/**
 * Phase 9 (browser P2P UI surface) — ProfileTab tests for the web build.
 *
 * Pins three behaviors that distinguish the web build from the native
 * build's existing UI:
 *
 *   1. Session identity row renders the browser fingerprint (NOT the
 *      "native builds only" placeholder).
 *   2. Swarm status block renders the browser-node-derived "Peers
 *      connected" row (NOT the native placeholder).
 *   3. The "Add a peer…" button is enabled even though we're not in
 *      Tauri — the browser is now a real libp2p peer and the scanner
 *      has a paste path on every platform.
 *
 * The Tauri-only call surfaces (servitude APIs, libp2p lazy-load
 * chunk, Matrix-room peer-card listeners, etc.) are mocked so the
 * suite never actually touches them. `isTauri()` is pinned to `false`
 * via the mocked servitude module.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// ── Hoisted mocks ────────────────────────────────────────────────
const {
  isTauriMock,
  getBrowserIdentityMock,
  getBrowserNodeIfStartedMock,
  fingerprintForHexMock,
  useBrowserLibp2pMock,
  subscribeToLanPeersMock,
} = vi.hoisted(() => ({
  isTauriMock: vi.fn(),
  getBrowserIdentityMock: vi.fn(),
  getBrowserNodeIfStartedMock: vi.fn(),
  fingerprintForHexMock: vi.fn(),
  useBrowserLibp2pMock: vi.fn(() => ({
    status: "running" as const,
    error: undefined,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  })),
  subscribeToLanPeersMock: vi.fn(() => () => {}),
}));

vi.mock("../../../api/servitude", () => ({
  isTauri: isTauriMock,
}));

vi.mock("../../../libp2p/identity", () => ({
  getBrowserIdentity: getBrowserIdentityMock,
}));

vi.mock("../../../libp2p/lazyNode", () => ({
  getBrowserNodeIfStarted: getBrowserNodeIfStartedMock,
  // The ensureBrowserNode export is consumed by useBrowserLibp2p, which
  // we mock at the hook layer below; no need to stub here.
}));

vi.mock("../../../libp2p/fingerprint", () => ({
  fingerprintForHex: fingerprintForHexMock,
}));

vi.mock("../../../hooks/useBrowserLibp2p", () => ({
  useBrowserLibp2p: useBrowserLibp2pMock,
}));

vi.mock("../../../api/lanPeers", () => ({
  subscribeToLanPeers: subscribeToLanPeersMock,
}));

// Concord API surface — mocked because the Profile tab calls it for
// TOTP / recovery-email status on mount.
vi.mock("../../../api/concord", () => ({
  changePassword: vi.fn(),
  getTOTPStatus: vi.fn(async () => ({ enabled: false })),
  setupTOTP: vi.fn(),
  verifyTOTP: vi.fn(),
  disableTOTP: vi.fn(),
  getRecoveryEmailStatus: vi.fn(async () => ({ has_recovery_email: false })),
  setRecoveryEmail: vi.fn(),
}));

// Hosting-profile section calls fetchHostingProfile on mount. Stub.
vi.mock("../../../api/hostingProfile", () => ({
  fetchHostingProfile: vi.fn(async () => ({
    profile: "web_first",
    webStackRunning: false,
    lastChanged: null,
  })),
  setHostingProfile: vi.fn(),
  enableWebStack: vi.fn(),
}));

// PeerCardDisplay opens dependencies on auth + libp2p. We render it
// as a small stand-in so the test focuses on ProfileTab's own
// composition rather than re-asserting card internals (which the
// dedicated PeerCardDisplay.web.test.tsx covers).
vi.mock("../../peers/PeerCardDisplay", () => ({
  PeerCardDisplay: () => (
    <div data-testid="peer-card-display-stub">peer card</div>
  ),
}));

// KnownPeersList loads from peerStore on mount; render a stub so we
// don't have to seed the localStorage state for this test.
vi.mock("../../peers/KnownPeersList", () => ({
  KnownPeersList: () => (
    <div data-testid="known-peers-list-stub">known peers</div>
  ),
}));

// Scanner only renders when open; ProfileTab guards it behind
// `scannerOpen`. Stub so we don't pull in jsQR / matrix-js-sdk types.
vi.mock("../../peers/PeerCardScanner", () => ({
  PeerCardScanner: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="peer-card-scanner-stub">
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

import { ProfileTab } from "../ProfileTab";
import { useAuthStore } from "../../../stores/auth";
import { useIdentityStore } from "../../../stores/identity";

describe("<ProfileTab /> (web build)", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    getBrowserIdentityMock.mockResolvedValue({
      peerId: "12D3KooWBrowserSession",
      publicKeyHex: "a".repeat(64),
      privateKey: {} as never,
    });
    // Deterministic fingerprint so the assertion is exact.
    fingerprintForHexMock.mockResolvedValue("BROWSEROFINGERPRT");
    // Default: no libp2p node has loaded yet — the swarm-status block
    // renders the "not started" hint. Individual tests override this.
    getBrowserNodeIfStartedMock.mockResolvedValue(null);

    // Seed minimum auth state so the User ID row doesn't crash. The
    // Avatar component reads userId from the store; we set both
    // userId AND a null client so the surface that needs the client
    // gracefully no-ops.
    useAuthStore.setState({
      client: null,
      userId: "@webuser:example.org",
      accessToken: null,
      isLoggedIn: true,
      isLoading: false,
      isGuest: false,
      syncing: false,
    });
    // Wipe identity store so the native Phase-2 path never accidentally
    // populates the fingerprint row before our web branch picks up.
    useIdentityStore.setState({
      fingerprint: null,
      publicKeyHex: null,
      isLoading: false,
      error: null,
      swarmPeerId: null,
      swarmMultiaddrs: [],
      swarmPeerCount: 0,
      swarmLastEvent: null,
      swarmLoading: false,
      swarmError: null,
    });
  });

  /**
   * (1) Session identity row renders the browser fingerprint — NOT the
   * native-only placeholder.
   */
  it("renders the browser session-identity row with the fingerprint", async () => {
    render(<ProfileTab />);

    // Label change is part of the surface contract.
    await waitFor(() => {
      expect(
        screen.getByText(/session identity \(ephemeral\)/i),
      ).toBeInTheDocument();
    });
    // Fingerprint string comes from the mock; wait for it to land in
    // the DOM (the helper resolves asynchronously).
    await waitFor(() => {
      expect(screen.getByText("BROWSEROFINGERPRT")).toBeInTheDocument();
    });
    // The old native-only placeholder must NOT be present in any row.
    expect(
      screen.queryAllByText(/native builds only/i),
    ).toHaveLength(0);
  });

  /**
   * (2) Swarm status block renders the browser node's peer count when
   * the node is available.
   */
  it("renders the browser swarm peer count when the node is running", async () => {
    // Lightweight fake libp2p node satisfying the accessors the
    // status block calls.
    const listeners: Record<string, EventListener[]> = {};
    const fakeNode = {
      peerId: { toString: () => "12D3KooWFakePeer" },
      getMultiaddrs: () => [
        { toString: () => "/ip4/127.0.0.1/tcp/4001" },
      ],
      getPeers: () => [{ toString: () => "p1" }, { toString: () => "p2" }],
      addEventListener: (name: string, fn: EventListener) => {
        (listeners[name] ??= []).push(fn);
      },
      removeEventListener: (name: string, fn: EventListener) => {
        listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
      },
    };
    getBrowserNodeIfStartedMock.mockResolvedValue(fakeNode);

    render(<ProfileTab />);

    // The block renders the row label + the count.
    await waitFor(() => {
      expect(screen.getByTestId("swarm-peers-row")).toHaveTextContent(
        "Peers connected",
      );
    });
    // The count is populated from `getPeers().length`.
    await waitFor(() => {
      expect(screen.getByTestId("swarm-peers-row")).toHaveTextContent(
        "2",
      );
    });
    // And the native "Swarm — native builds only" placeholder is gone.
    expect(screen.queryByText(/swarm.*native builds only/i)).toBeNull();
  });

  /**
   * (3) "Add a peer…" button is enabled on web.
   */
  it("renders the 'Add a peer…' button as enabled on web", async () => {
    render(<ProfileTab />);

    const button = await screen.findByRole("button", {
      name: /add a peer/i,
    });
    expect(button).not.toBeDisabled();
  });
});
