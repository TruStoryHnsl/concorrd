/**
 * UserConnectionsTab tests — peer-connections section.
 *
 * After the 2026-05-30 P2P UI relocation, the peer-identity row, swarm
 * status block, and "Add a peer…" button live here (not in ProfileTab).
 * This file pins the positive assertions that were previously inside
 * `ProfileTab.web.test.tsx`.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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

// PeerCardDisplay + KnownPeersList + PeerCardScanner are rendered as
// stubs so the test focuses on the UserConnectionsTab's own
// composition; their internals have dedicated tests elsewhere.
vi.mock("../../peers/PeerCardDisplay", () => ({
  PeerCardDisplay: () => (
    <div data-testid="peer-card-display-stub">peer card</div>
  ),
}));
vi.mock("../../peers/KnownPeersList", () => ({
  KnownPeersList: () => (
    <div data-testid="known-peers-list-stub">known peers</div>
  ),
}));
vi.mock("../../peers/PeerCardScanner", () => ({
  PeerCardScanner: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="peer-card-scanner-stub">
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

import { UserConnectionsTab } from "../UserConnectionsTab";
import { useAuthStore } from "../../../stores/auth";
import { useIdentityStore } from "../../../stores/identity";

describe("<UserConnectionsTab /> peer-connections section", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    getBrowserIdentityMock.mockResolvedValue({
      peerId: "12D3KooWBrowserSession",
      publicKeyHex: "a".repeat(64),
      privateKey: {} as never,
    });
    fingerprintForHexMock.mockResolvedValue("BROWSEROFINGERPRT");
    getBrowserNodeIfStartedMock.mockResolvedValue(null);

    // Auth must be signed-in so the tab renders its rich body (the
    // signed-out path bails out before the connection cards / peer
    // section render).
    useAuthStore.setState({
      client: null,
      userId: "@webuser:example.org",
      accessToken: "ACCESS",
      isLoggedIn: true,
      isLoading: false,
      isGuest: false,
      syncing: false,
    });
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
   * (1) Browser session identity row renders.
   */
  it("renders the browser session-identity row with the fingerprint", async () => {
    render(<UserConnectionsTab />);

    await waitFor(() => {
      expect(
        screen.getByText(/session identity \(ephemeral\)/i),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("BROWSEROFINGERPRT")).toBeInTheDocument();
    });
  });

  /**
   * (2) Browser swarm status block renders the peer count when the
   * node is running.
   */
  it("renders the browser swarm peer count when the node is running", async () => {
    const listeners: Record<string, EventListener[]> = {};
    const fakeNode = {
      peerId: { toString: () => "12D3KooWFakePeer" },
      getMultiaddrs: () => [
        { toString: () => "/ip4/127.0.0.1/tcp/4001" },
      ],
      getPeers: () => [
        { toString: () => "p1" },
        { toString: () => "p2" },
      ],
      addEventListener: (name: string, fn: EventListener) => {
        (listeners[name] ??= []).push(fn);
      },
      removeEventListener: (name: string, fn: EventListener) => {
        listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
      },
    };
    getBrowserNodeIfStartedMock.mockResolvedValue(fakeNode);

    render(<UserConnectionsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("swarm-peers-row")).toHaveTextContent(
        "Peers connected",
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("swarm-peers-row")).toHaveTextContent(
        "2",
      );
    });
  });

  /**
   * (3) "Add a peer…" button is enabled.
   */
  it("renders the 'Add a peer…' button as enabled", async () => {
    render(<UserConnectionsTab />);

    const button = await screen.findByRole("button", {
      name: /add a peer/i,
    });
    expect(button).not.toBeDisabled();
  });
});
