//! Phase 8 (INS-019b) — voice path selection.
//!
//! Decides per-call whether the voice subsystem runs as a full libp2p
//! WebRTC mesh (each participant dials every other directly) or falls
//! back to a LiveKit SFU on a docker-deployed Concord instance.
//!
//! ## Rules (from `docs/architecture/p2p-design.md` Phase 8)
//!
//!   * `> 8` participants → SFU. Full-mesh fanout grows O(n²); the
//!     8-peer cap is the design-doc-stated threshold above which a
//!     central SFU is unambiguously the better path.
//!   * Any [`ParticipantKind::WebOnly`] participant → SFU. Browsers
//!     can't be full libp2p-mesh peers until Phase 9 ships; until
//!     then, any browser in the room forces the whole call onto
//!     LiveKit.
//!   * All [`ParticipantKind::Native`] AND `<= 8` total → mesh.
//!
//! The participant list includes the local user. A 1-peer call (the
//! lonely degenerate case) selects mesh; harmless — there's no remote
//! to dial, but a stale local call setup doesn't accidentally spin
//! up the SFU pipeline either.

/// Classification of a single voice-call participant for the purpose
/// of path selection.
///
/// `Native` carries the peer's libp2p `PeerId`. The selector itself
/// doesn't use the `PeerId` (it only counts members and watches for
/// `WebOnly` entries) but downstream callers — the mesh-orchestration
/// layer in particular — need the `PeerId` to actually dial the peer
/// once `LibP2pMesh` is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticipantKind {
    /// Has a libp2p PeerId in the local peer-store (Phase 5 KnownPeer).
    Native { peer_id: libp2p::PeerId },
    /// Reachable only via the web/SFU plane (no known PeerId).
    WebOnly,
}

/// The voice path the call will run over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoicePath {
    /// Full peer-to-peer mesh via libp2p WebRTC. Each participant
    /// dials every other directly. No SFU, no project-run media
    /// relay required.
    LibP2pMesh,
    /// LiveKit SFU on a docker-deployed Concord instance. Used for
    /// >8-participant calls, calls including any web-only participant,
    /// and (in a future revision) calls where the mesh can't
    /// hole-punch its way through NAT.
    LiveKitSfu,
}

/// Pure path-selection logic. Stateless — call
/// [`VoicePathSelector::select`] with the participant set and inspect
/// the returned [`VoicePath`]. The reason classification lives in
/// [`select_with_reason`] so the Tauri command surface can surface it
/// to the UI.
pub struct VoicePathSelector;

/// Coarse-grained reason the selector chose [`VoicePath::LiveKitSfu`]
/// or [`VoicePath::LibP2pMesh`]. Surfaced through the Tauri command
/// surface so the UI can render the right context for the user
/// ("falling back to LiveKit because one participant is on the web
/// build").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoicePathReason {
    /// Participant count exceeded the mesh cap (>8).
    AboveCap8,
    /// At least one participant is reachable only via the web plane.
    WebOnlyParticipantPresent,
    /// All participants are native AND the total count is within the
    /// mesh cap.
    AllNativeUnderCap,
}

impl VoicePathReason {
    /// Stable wire string used by the Tauri command surface. Snake-case
    /// matches the JSON convention the rest of the servitude module
    /// uses.
    pub fn as_str(self) -> &'static str {
        match self {
            VoicePathReason::AboveCap8 => "above_cap_8",
            VoicePathReason::WebOnlyParticipantPresent => "web_only_participant_present",
            VoicePathReason::AllNativeUnderCap => "all_native_under_cap",
        }
    }
}

impl VoicePathSelector {
    /// Decide which voice path to use given the call's participants.
    ///
    /// See module docs for the rules. The participants slice includes
    /// the local user; the cap of 8 is inclusive.
    pub fn select(participants: &[ParticipantKind]) -> VoicePath {
        Self::select_with_reason(participants).0
    }

    /// Same as [`Self::select`] but also returns the
    /// [`VoicePathReason`] so the UI / command surface can render the
    /// "why" alongside the chosen path.
    pub fn select_with_reason(participants: &[ParticipantKind]) -> (VoicePath, VoicePathReason) {
        // >8 is the hard cap. Evaluated FIRST so an oversized native
        // call (e.g. a 9-peer all-native call) still flips to SFU —
        // the design-doc rule is "cap regardless of native-ness".
        if participants.len() > 8 {
            return (VoicePath::LiveKitSfu, VoicePathReason::AboveCap8);
        }
        // Any web-only participant kicks the whole call over to SFU.
        if participants
            .iter()
            .any(|p| matches!(p, ParticipantKind::WebOnly))
        {
            return (
                VoicePath::LiveKitSfu,
                VoicePathReason::WebOnlyParticipantPresent,
            );
        }
        // Within cap, all native — mesh is the right call.
        (VoicePath::LibP2pMesh, VoicePathReason::AllNativeUnderCap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::PeerId;

    fn native() -> ParticipantKind {
        ParticipantKind::Native {
            peer_id: PeerId::random(),
        }
    }

    /// 2-peer all-native call — the canonical mesh case.
    #[test]
    fn picks_mesh_for_two_native_peers() {
        let participants = vec![native(), native()];
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LibP2pMesh);
        assert_eq!(reason, VoicePathReason::AllNativeUnderCap);
    }

    /// 8-peer all-native call — at the boundary, mesh is still the
    /// right choice. This pins the "cap is inclusive" semantics.
    #[test]
    fn picks_mesh_at_the_eight_peer_boundary() {
        let participants: Vec<_> = (0..8).map(|_| native()).collect();
        assert_eq!(participants.len(), 8);
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LibP2pMesh);
        assert_eq!(reason, VoicePathReason::AllNativeUnderCap);
    }

    /// 9-peer all-native call — over the cap, must select SFU even
    /// though every participant is reachable as a native peer.
    #[test]
    fn picks_sfu_above_the_cap() {
        let participants: Vec<_> = (0..9).map(|_| native()).collect();
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LiveKitSfu);
        assert_eq!(reason, VoicePathReason::AboveCap8);
    }

    /// Mixed call: 3 native + 1 web-only. The web participant forces
    /// the whole call onto SFU even though we're well within the cap.
    #[test]
    fn picks_sfu_when_any_web_only_participant() {
        let participants = vec![native(), native(), native(), ParticipantKind::WebOnly];
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LiveKitSfu);
        assert_eq!(reason, VoicePathReason::WebOnlyParticipantPresent);
    }

    /// Degenerate 1-peer call — picks mesh, which is harmless (no
    /// remote to dial). The selector must NOT accidentally fall into
    /// the SFU branch via an "n>0 web-only check" reading the empty
    /// slice as web-only.
    #[test]
    fn picks_mesh_for_lonely_single_peer() {
        let participants = vec![native()];
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LibP2pMesh);
        assert_eq!(reason, VoicePathReason::AllNativeUnderCap);
    }

    /// Zero participants — empty slice. Returns mesh (degenerate);
    /// callers should never invoke the selector with an empty list,
    /// but if they do, the result is a no-op mesh path rather than a
    /// panic.
    #[test]
    fn picks_mesh_for_empty_participant_list() {
        let participants: Vec<ParticipantKind> = vec![];
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LibP2pMesh);
        assert_eq!(reason, VoicePathReason::AllNativeUnderCap);
    }

    /// Cap-vs-web-only priority: a 9-peer call WITH a web-only
    /// participant must report `AboveCap8`, not
    /// `WebOnlyParticipantPresent`. The cap check happens first.
    #[test]
    fn cap_check_takes_priority_over_web_only_check() {
        let mut participants: Vec<_> = (0..8).map(|_| native()).collect();
        participants.push(ParticipantKind::WebOnly); // 9 total
        let (path, reason) = VoicePathSelector::select_with_reason(&participants);
        assert_eq!(path, VoicePath::LiveKitSfu);
        assert_eq!(reason, VoicePathReason::AboveCap8);
    }

    /// `select()` returns the same path as `select_with_reason().0`
    /// for all the canonical cases. Pins the convenience helper to
    /// the underlying logic.
    #[test]
    fn select_matches_select_with_reason() {
        let mesh_case = vec![native(), native()];
        let sfu_cap_case: Vec<_> = (0..9).map(|_| native()).collect();
        let sfu_web_case = vec![native(), ParticipantKind::WebOnly];

        assert_eq!(
            VoicePathSelector::select(&mesh_case),
            VoicePathSelector::select_with_reason(&mesh_case).0
        );
        assert_eq!(
            VoicePathSelector::select(&sfu_cap_case),
            VoicePathSelector::select_with_reason(&sfu_cap_case).0
        );
        assert_eq!(
            VoicePathSelector::select(&sfu_web_case),
            VoicePathSelector::select_with_reason(&sfu_web_case).0
        );
    }
}
