//! Porch Phase F — pair-to-promote handshake helpers.
//!
//! Most of the link state lives in `sync::device` (DB) and
//! `sync::protocol` (wire). This module exists for the
//! "outbound" side of the bilateral handshake — the user clicks
//! "Add personal device" → enters a peer-id → the local Tauri command
//! dials the remote, exchanges device-ids, then commits the local side
//! of the link.
//!
//! Both sides must independently take this step before sync runs.

use libp2p::PeerId;
use libp2p_stream::Control;

use crate::porch::db::Porch;
use crate::porch::error::PorchError;

use super::device::DeviceLink;
use super::protocol::{visit_link_request, LinkResponse};

/// Outbound: dial `peer_id`, send our device-id, learn theirs, commit
/// the local side of the link.
///
/// Returns the inserted `DeviceLink` row. The remote will need to
/// independently call its own equivalent before sync over
/// `/concord/porch-sync/` succeeds in the other direction.
pub async fn link_and_record(
    porch: &Porch,
    control: &mut Control,
    peer_id: PeerId,
    label: Option<String>,
) -> Result<DeviceLink, PorchError> {
    let my_device = porch.device_id()?;
    let LinkResponse {
        my_device_id: remote_device_id,
        ..
    } = visit_link_request(control, peer_id, my_device, label.clone()).await?;
    porch.link_personal_device(
        &peer_id.to_base58(),
        &remote_device_id,
        label.as_deref(),
    )
}
