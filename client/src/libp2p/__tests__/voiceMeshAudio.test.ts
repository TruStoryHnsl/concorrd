/**
 * Phase 8/9 follow-up — browser-side mesh AUDIO orchestration tests.
 *
 * Complements `voiceMesh.test.ts` (which covers the signaling round-
 * trip + PC orchestration). This file specifically asserts the
 * audio-capture / addTrack / playback path: getUserMedia is requested,
 * every audio track ends up on every PeerConnection, and leaveMesh
 * stops every local track AND detaches every remote `<audio>`
 * element.
 *
 * Three cases:
 *
 *   1. `joinMesh requests audio-only getUserMedia` — assert the
 *      constraints object passed in is `{ audio: true }`.
 *   2. `joinMesh calls addTrack for every audio track on every PC` —
 *      N peers, M audio tracks → N×M addTrack invocations.
 *   3. `leaveMesh stops every local track AND pauses remote audio
 *      elements` — assert MediaStreamTrack.stop() runs and the
 *      attached HTMLAudioElement's srcObject is nulled.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { joinMesh, leaveMesh, getMeshRoom } from "../voiceMesh";

interface MockPC {
  addTrack: ReturnType<typeof vi.fn>;
  addTransceiver: ReturnType<typeof vi.fn>;
  createOffer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  addIceCandidate: ReturnType<typeof vi.fn>;
  createAnswer: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  ontrack: ((ev: RTCTrackEvent) => void) | null;
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null;
}

function makeMockPC(): MockPC {
  return {
    addTrack: vi.fn(),
    addTransceiver: vi.fn(),
    createOffer: vi
      .fn()
      .mockResolvedValue({ type: "offer", sdp: "v=0\r\nfake-offer\r\n" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createAnswer: vi
      .fn()
      .mockResolvedValue({ type: "answer", sdp: "v=0\r\nfake-answer\r\n" }),
    close: vi.fn(),
    ontrack: null,
    onicecandidate: null,
  };
}

function makeMockLibp2p() {
  const handle = vi.fn().mockResolvedValue(undefined);
  const unhandle = vi.fn().mockResolvedValue(undefined);
  const dialProtocol = vi.fn().mockResolvedValue({
    send: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return { handle, unhandle, dialProtocol } as unknown as import(
    "@libp2p/interface"
  ).Libp2p & {
    handle: typeof handle;
    unhandle: typeof unhandle;
    dialProtocol: typeof dialProtocol;
  };
}

function fakePeerId(id: string): import("@libp2p/interface").PeerId {
  return {
    toString: () => id,
  } as unknown as import("@libp2p/interface").PeerId;
}

interface MockTrack {
  stop: ReturnType<typeof vi.fn>;
  kind: string;
  id: string;
}

function makeMockTrack(id: string, kind = "audio"): MockTrack {
  return {
    stop: vi.fn(),
    kind,
    id,
  };
}

describe("joinMesh audio orchestration", () => {
  const pcInstances: MockPC[] = [];
  const originalPC = globalThis.RTCPeerConnection;
  const originalMediaDevices = (globalThis.navigator as Navigator | undefined)
    ?.mediaDevices;
  const originalAudio = (globalThis as unknown as { Audio: unknown }).Audio;
  const audioInstances: Array<{
    pause: ReturnType<typeof vi.fn>;
    autoplay: boolean;
    srcObject: unknown;
    _srcObject: unknown;
    dataset: Record<string, string>;
  }> = [];
  let getUserMediaMock: ReturnType<typeof vi.fn>;
  let mockTracks: MockTrack[];

  beforeEach(() => {
    pcInstances.length = 0;
    audioInstances.length = 0;
    mockTracks = [makeMockTrack("track-a")];

    class PCStub {
      constructor() {
        const pc = makeMockPC();
        pcInstances.push(pc);
        return pc as unknown as PCStub;
      }
    }
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      PCStub;

    getUserMediaMock = vi.fn().mockResolvedValue({
      getTracks: () => mockTracks,
      getAudioTracks: () => mockTracks.filter((t) => t.kind === "audio"),
    } as unknown as MediaStream);

    (globalThis as unknown as { navigator: { mediaDevices: unknown } }).navigator =
      {
        ...globalThis.navigator,
        mediaDevices: {
          getUserMedia: getUserMediaMock,
        },
      } as unknown as Navigator;

    // Stub Audio so we can assert attach + detach. `srcObject` is a
    // get/set; we shadow the property with plain storage so the
    // test can read it back.
    class AudioStub {
      pause = vi.fn();
      autoplay = false;
      _srcObject: unknown = null;
      dataset: Record<string, string> = {};
      get srcObject(): unknown {
        return this._srcObject;
      }
      set srcObject(v: unknown) {
        this._srcObject = v;
      }
      constructor() {
        audioInstances.push(this);
      }
    }
    (globalThis as unknown as { Audio: unknown }).Audio = AudioStub;
  });

  afterEach(async () => {
    await leaveMesh("audio-test-room");
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      originalPC;
    if (originalMediaDevices !== undefined) {
      (globalThis as unknown as { navigator: { mediaDevices: unknown } }).navigator =
        {
          ...globalThis.navigator,
          mediaDevices: originalMediaDevices,
        } as unknown as Navigator;
    }
    // Always restore Audio — even if `originalAudio` is undefined,
    // setting it explicitly avoids leaking the stub class into
    // sibling test files that run in the same worker process.
    (globalThis as unknown as { Audio: unknown }).Audio = originalAudio;
  });

  /**
   * The mesh code MUST request audio-only — never video, never
   * arbitrary constraints. This locks down the constraints object
   * shape so a future change can't silently broaden the surface.
   */
  it("joinMesh requests audio-only getUserMedia", async () => {
    const node = makeMockLibp2p();
    await joinMesh(node, "audio-test-room", [
      { peerId: fakePeerId("12D3KooWAlice") },
    ]);
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    const constraints = getUserMediaMock.mock.calls[0][0] as MediaStreamConstraints;
    expect(constraints.audio).toBe(true);
    // Explicitly never asks for video. Forward-compatible if someone
    // later adds `video: false`; we only assert it's not `true`.
    expect(constraints.video).not.toBe(true);
  });

  /**
   * For N peers and M local audio tracks, the mesh must call
   * `addTrack` N × M times — every track gets attached to every
   * PeerConnection so every remote sees our mic.
   */
  it("joinMesh calls addTrack for every audio track on every PC", async () => {
    // Two audio tracks (think dual-mic / virtual processor) and
    // three peers.
    mockTracks = [
      makeMockTrack("track-a"),
      makeMockTrack("track-b"),
    ];
    const node = makeMockLibp2p();
    await joinMesh(node, "audio-test-room", [
      { peerId: fakePeerId("12D3KooWAlice") },
      { peerId: fakePeerId("12D3KooWBob") },
      { peerId: fakePeerId("12D3KooWCarol") },
    ]);

    expect(pcInstances.length).toBe(3);
    for (const pc of pcInstances) {
      // 2 tracks × 1 PC = 2 addTrack calls per PC.
      expect(pc.addTrack).toHaveBeenCalledTimes(mockTracks.length);
      const calledTracks = pc.addTrack.mock.calls.map(
        (args) => (args[0] as MockTrack).id,
      );
      expect(calledTracks).toEqual(
        expect.arrayContaining(mockTracks.map((t) => t.id)),
      );
    }
  });

  /**
   * `leaveMesh` must call `stop()` on every local mic track (so the
   * OS-level mic indicator turns off) AND pause + null `srcObject`
   * on every remote `<audio>` element so the browser stops decoding
   * inbound packets.
   */
  it("leaveMesh stops local tracks AND detaches remote audio elements", async () => {
    const node = makeMockLibp2p();
    await joinMesh(node, "audio-test-room", [
      { peerId: fakePeerId("12D3KooWAlice") },
    ]);

    // Simulate an inbound remote track arriving by firing the
    // initiator-side PC's ontrack handler. The handler installs an
    // `<audio>` element via the AudioStub above.
    const pc = pcInstances[0];
    expect(pc.ontrack).not.toBeNull();
    const fakeRemoteTrack = {
      id: "remote-track-1",
      kind: "audio",
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getTracks: () => [fakeRemoteTrack],
      addTrack: vi.fn(),
    } as unknown as MediaStream;
    pc.ontrack!({
      track: fakeRemoteTrack,
      streams: [fakeStream],
    } as unknown as RTCTrackEvent);

    // Sanity — the room captured the remote audio element.
    expect(audioInstances.length).toBe(1);
    const audio = audioInstances[0];
    expect(audio.autoplay).toBe(true);
    expect(audio._srcObject).toBe(fakeStream);

    await leaveMesh("audio-test-room");

    // Local mic tracks stopped.
    for (const track of mockTracks) {
      expect(track.stop).toHaveBeenCalledTimes(1);
    }
    // Remote audio elements detached.
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio._srcObject).toBeNull();

    // Registry no longer has the room.
    expect(getMeshRoom("audio-test-room")).toBeUndefined();
  });
});
