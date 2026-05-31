/**
 * Phase 9 (browser P2P UI surface) — PeerCardDisplay tests for the web
 * build.
 *
 * Pins two behaviors:
 *
 *   1. The web build derives the card from `getBrowserIdentity()` plus
 *      the running browser libp2p node's multiaddrs — NOT the native
 *      identity store. The "native builds only" placeholder is gone.
 *   2. The "(session card)" subtitle renders so users understand the
 *      ephemeral nature of the browser-derived card.
 *
 * `isTauri()` is pinned to `false`, the libp2p singletons are mocked
 * with lightweight fakes, and the matrix-js-sdk surface is left to its
 * real exports (the test never exercises room posting).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const {
  isTauriMock,
  getBrowserIdentityMock,
  getBrowserNodeIfStartedMock,
  qrcodeToDataURLMock,
} = vi.hoisted(() => ({
  isTauriMock: vi.fn(),
  getBrowserIdentityMock: vi.fn(),
  getBrowserNodeIfStartedMock: vi.fn(),
  qrcodeToDataURLMock: vi.fn(),
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

// The PeerCardDisplay component self-triggers swarm startup via
// `useBrowserLibp2p({ enabled: true })`. Stub the hook so the test
// doesn't try to dynamically import the real libp2p tree under jsdom.
vi.mock("../../../hooks/useBrowserLibp2p", () => ({
  useBrowserLibp2p: () => ({
    status: "running",
    error: undefined,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

// QR encoding is synchronous; mock to bypass the canvas dep entirely.
vi.mock("qrcode", () => ({
  default: { toDataURL: qrcodeToDataURLMock },
  toDataURL: qrcodeToDataURLMock,
}));

import { PeerCardDisplay } from "../PeerCardDisplay";
import { useAuthStore } from "../../../stores/auth";
import { useIdentityStore } from "../../../stores/identity";

describe("<PeerCardDisplay /> (web build)", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    getBrowserIdentityMock.mockResolvedValue({
      peerId: "12D3KooWBrowserSession",
      publicKeyHex: "a".repeat(64),
      privateKey: {} as never,
    });
    // Lightweight libp2p stand-in: one multiaddr so the card assembles.
    getBrowserNodeIfStartedMock.mockResolvedValue({
      getMultiaddrs: () => [
        { toString: () => "/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWBrowserSession" },
      ],
    });
    qrcodeToDataURLMock.mockResolvedValue(
      "data:image/png;base64,fakebrowserqr",
    );

    // No matrix client needed — the Post-to-Room button is just
    // disabled. We DO need the auth store to not crash on read.
    useAuthStore.setState({
      client: null,
      userId: "@webuser:example.org",
      accessToken: null,
      isLoggedIn: true,
      isLoading: false,
      isGuest: false,
      syncing: false,
    });

    // Native identity store stays empty so the web branch is the one
    // that fires. Setting these to null guarantees we're not
    // accidentally reading from the native path.
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
   * (1) Web build generates a QR card from the browser identity instead
   * of showing the placeholder.
   */
  it("renders the QR card from getBrowserIdentity() on web", async () => {
    render(<PeerCardDisplay />);

    // The card wrapper renders (NOT the "native builds only"
    // placeholder).
    const wrapper = await screen.findByTestId("peer-card-display");
    expect(wrapper).toBeInTheDocument();
    expect(
      screen.queryByText(/peer pairing is available in native builds only/i),
    ).toBeNull();

    // QR image gets a src from the mocked toDataURL once the card
    // assembles. The mock resolves async (browser identity + libp2p
    // accessors are both promises), so wait for the img to land.
    await waitFor(() => {
      const img = screen.getByAltText(
        /peer card qr code/i,
      ) as HTMLImageElement;
      expect(img.src).toContain("fakebrowserqr");
    });

    // QRCode.toDataURL receives the canonical concord://peer/ link.
    expect(qrcodeToDataURLMock).toHaveBeenCalled();
    const firstCall = qrcodeToDataURLMock.mock.calls[0];
    expect(firstCall[0]).toMatch(/^concord:\/\/peer\//);
  });

  /**
   * (2) "(session card)" subtitle is visible so users know the card
   * is ephemeral.
   */
  it("renders the '(session card)' subtitle on web", async () => {
    render(<PeerCardDisplay />);

    await waitFor(() => {
      expect(
        screen.getByTestId("peer-card-session-subtitle"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("peer-card-session-subtitle"),
    ).toHaveTextContent(/recipients can dial you while this tab is open/i);
  });
});
