/**
 * Phase 8 follow-up — browser-side voice mesh orchestration tests.
 *
 * Three cases mock `getUserMedia` + `RTCPeerConnection` so the
 * orchestrator can be exercised without a real WebRTC stack inside
 * jsdom:
 *
 *   1. `joinMesh` opens a per-peer connection for each known peer in
 *      the participants list.
 *   2. Mesh join with no peers in the room succeeds (degenerate case,
 *      no PC opened).
 *   3. `leaveMesh` calls `pc.close()` on every peer.
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
  // js-libp2p PeerIds expose `.toString()`. The orchestrator only
  // calls `.toString()` on the participant entries; a stub object
  // with a matching `toString` is enough.
  return {
    toString: () => id,
  } as unknown as import("@libp2p/interface").PeerId;
}

describe("joinMesh orchestration", () => {
  const pcInstances: MockPC[] = [];
  const originalPC = globalThis.RTCPeerConnection;
  const originalMediaDevices = (globalThis.navigator as Navigator | undefined)
    ?.mediaDevices;

  beforeEach(() => {
    pcInstances.length = 0;
    // Replace RTCPeerConnection with a factory that produces our
    // mock and records every instance. Must be `new`-able, so use a
    // class wrapper rather than a plain `vi.fn`.
    class PCStub {
      constructor() {
        const pc = makeMockPC();
        pcInstances.push(pc);
        return pc as unknown as PCStub;
      }
    }
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      PCStub;
    // Mock getUserMedia — return a MediaStream-shaped stub.
    (globalThis as unknown as { navigator: { mediaDevices: unknown } }).navigator =
      {
        ...globalThis.navigator,
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [
              {
                stop: vi.fn(),
                kind: "audio",
              } as unknown as MediaStreamTrack,
            ],
          } as unknown as MediaStream),
        },
      } as unknown as Navigator;
  });

  afterEach(async () => {
    // Tear down any room our test left behind.
    await leaveMesh("test-room");
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      originalPC;
    if (originalMediaDevices !== undefined) {
      (globalThis as unknown as { navigator: { mediaDevices: unknown } }).navigator =
        {
          ...globalThis.navigator,
          mediaDevices: originalMediaDevices,
        } as unknown as Navigator;
    }
  });

  /**
   * For each participant in the list, `joinMesh` must:
   *   - allocate a new `RTCPeerConnection`,
   *   - call `addTrack` for every local mic track,
   *   - call `createOffer` + `setLocalDescription`,
   *   - call `node.dialProtocol(...)` to send the Offer envelope.
   */
  it("opens one PeerConnection per participant and sends an Offer", async () => {
    const node = makeMockLibp2p();
    const room = await joinMesh(node, "test-room", [
      { peerId: fakePeerId("12D3KooWAlice") },
      { peerId: fakePeerId("12D3KooWBob") },
    ]);

    expect(pcInstances.length).toBe(2);
    for (const pc of pcInstances) {
      expect(pc.addTrack).toHaveBeenCalled();
      expect(pc.createOffer).toHaveBeenCalledTimes(1);
      expect(pc.setLocalDescription).toHaveBeenCalledTimes(1);
    }
    expect((node as unknown as { dialProtocol: { mock: { calls: unknown[] } } })
      .dialProtocol.mock.calls.length).toBe(2);
    expect(room.peers.size).toBe(2);
    expect(getMeshRoom("test-room")?.peers.size).toBe(2);
  });

  /**
   * No participants — degenerate case. The handler is installed (so
   * late joiners can still dial in) but no PeerConnections are
   * constructed.
   */
  it("with no participants registers the inbound handler but creates no PCs", async () => {
    const node = makeMockLibp2p();
    const room = await joinMesh(node, "test-room", []);

    expect(pcInstances.length).toBe(0);
    expect(room.peers.size).toBe(0);
    expect((node as unknown as { handle: { mock: { calls: unknown[] } } })
      .handle.mock.calls.length).toBe(1);
  });

  /**
   * `leaveMesh` must close every PC and unregister the inbound
   * signaling handler. Idempotent — calling leave twice is a no-op.
   */
  it("leaveMesh closes every PC and unregisters the inbound handler", async () => {
    const node = makeMockLibp2p();
    await joinMesh(node, "test-room", [
      { peerId: fakePeerId("12D3KooWAlice") },
      { peerId: fakePeerId("12D3KooWBob") },
    ]);
    expect(pcInstances.length).toBe(2);

    await leaveMesh("test-room");

    for (const pc of pcInstances) {
      expect(pc.close).toHaveBeenCalledTimes(1);
    }
    expect((node as unknown as { unhandle: { mock: { calls: unknown[] } } })
      .unhandle.mock.calls.length).toBe(1);
    expect(getMeshRoom("test-room")).toBeUndefined();

    // Second leave is idempotent.
    await leaveMesh("test-room");
  });
});
