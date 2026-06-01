/**
 * SourcesPanel — intrinsic Local tile tests.
 *
 * The local tile represents THIS device's hosted instance and is
 * NOT in `useSourcesStore.sources` (which holds external connections
 * only). SourcesPanel synthesizes the tile at the TOP of the rail and
 * routes click → `onLocalOpen()`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SourcesPanel } from "../SourcesPanel";
import { useSourcesStore } from "../../../stores/sources";
import { useAuthStore } from "../../../stores/auth";
import { usePeerStore } from "../../../stores/peerStore";
import { useInstanceNameStore } from "../../../stores/instanceName";

describe("<SourcesPanel /> — Local tile", () => {
  beforeEach(() => {
    useSourcesStore.setState({ sources: [] });
    // No Matrix client by default — exercises the home-icon fallback.
    useAuthStore.setState({
      client: null,
      userId: null,
      accessToken: null,
      isLoggedIn: false,
      isGuest: false,
      isLoading: false,
      syncing: false,
    });
    usePeerStore.setState({
      knownPeers: [],
      isLoading: false,
      error: null,
      load: vi.fn(async () => {}),
      addFromCard: vi.fn(async () => null),
      remove: vi.fn(async () => false),
    });
    // Default to "no vanity name set" so the tile renders the "local"
    // fallback label. Individual tests override when needed.
    useInstanceNameStore.setState({
      name: "",
      loading: false,
      error: null,
    });
  });

  it("renders the local tile even when sources is empty", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    expect(screen.getByTestId("local-tile")).toBeInTheDocument();
  });

  it("renders the local tile FIRST — above all source tiles", () => {
    useSourcesStore.setState({
      sources: [
        {
          id: "src_matrix",
          host: "matrix.org",
          instanceName: "Matrix",
          inviteToken: "",
          apiBase: "https://matrix.org",
          homeserverUrl: "https://matrix.org",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "matrix",
        },
      ],
    });
    render(<SourcesPanel onAddSource={() => {}} />);
    const localTile = screen.getByTestId("local-tile");
    const sourceTile = screen.getByTestId("source-tile-src_matrix");
    expect(
      localTile.compareDocumentPosition(sourceTile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("right-click on the local tile does NOT open the source context menu", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("local-tile"));
    expect(screen.queryByText(/close connection/i)).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-testid^="source-context-menu-"]'),
    ).toBeNull();
  });

  it("falls back to home icon when no Matrix client is available", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    expect(screen.getByTestId("local-tile-home-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("local-tile-avatar")).toBeNull();
  });

  it("invokes onLocalOpen when the tile is clicked", () => {
    const onLocalOpen = vi.fn();
    render(
      <SourcesPanel onAddSource={() => {}} onLocalOpen={onLocalOpen} />,
    );
    fireEvent.click(screen.getByTestId("local-tile"));
    expect(onLocalOpen).toHaveBeenCalledTimes(1);
  });

  it("uses the vanity instance name as the tile label when set", () => {
    useInstanceNameStore.setState({
      name: "patio",
      loading: false,
      error: null,
    });
    render(<SourcesPanel onAddSource={() => {}} />);
    expect(screen.getByTestId("local-tile").getAttribute("title")).toBe(
      "patio",
    );
  });

  it("falls back to 'local' label when no vanity name is set", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    expect(screen.getByTestId("local-tile").getAttribute("title")).toBe(
      "local",
    );
  });

  it("renders an offline indicator when no peers have recent lastSeen", () => {
    usePeerStore.setState({
      knownPeers: [
        {
          peerId: "12D3KooWtest",
          publicKeyHex: "00",
          multiaddrs: [],
          firstSeen: new Date(0).toISOString(),
          lastSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
          source: "qr",
        },
      ],
      isLoading: false,
      error: null,
      load: vi.fn(async () => {}),
      addFromCard: vi.fn(async () => null),
      remove: vi.fn(async () => false),
    });
    render(<SourcesPanel onAddSource={() => {}} />);
    const wrapper = screen.getByTestId("local-tile-wrapper");
    expect(
      within(wrapper).getByTestId("local-tile-online-no"),
    ).toBeInTheDocument();
  });
});
