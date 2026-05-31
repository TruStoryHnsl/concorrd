/**
 * SourcesPanel — intrinsic Porch tile tests.
 *
 * The porch is local to this install and does NOT live in
 * `useSourcesStore.sources`. SourcesPanel synthesizes the tile and
 * routes click → `onPorchOpen()`.
 *
 * Reference: `docs/architecture/porch-design.md` (Phase A — Sources-rail
 * integration).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SourcesPanel } from "../SourcesPanel";
import { useSourcesStore } from "../../../stores/sources";
import { useAuthStore } from "../../../stores/auth";
import { usePeerStore } from "../../../stores/peerStore";

describe("<SourcesPanel /> — Porch tile", () => {
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
    // Disable peer-store load() side effects in tests — we don't want
    // it to call into Tauri or browser storage. Replacing it with a
    // no-op keeps the effect inert.
    usePeerStore.setState({
      knownPeers: [],
      isLoading: false,
      error: null,
      load: vi.fn(async () => {}),
      addFromCard: vi.fn(async () => null),
      remove: vi.fn(async () => false),
    });
  });

  it("renders the porch tile even when sources is empty", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    expect(screen.getByTestId("porch-tile")).toBeInTheDocument();
  });

  it("renders the porch tile FIRST — above all source tiles", () => {
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
    // Both tiles render. The porch tile's DOM position must precede
    // the source tile (compareDocumentPosition's "FOLLOWING" bit).
    const porchTile = screen.getByTestId("porch-tile");
    const sourceTile = screen.getByTestId("source-tile-src_matrix");
    expect(
      porchTile.compareDocumentPosition(sourceTile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("right-click on the porch tile does NOT open the source context menu (no Disconnect)", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("porch-tile"));
    // The intrinsic porch tile has no SourceContextMenu — there's
    // nothing to disconnect from. Confirm no source-context-menu
    // rendered, and no "Close connection" entry exists.
    expect(screen.queryByText(/close connection/i)).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-testid^="source-context-menu-"]'),
    ).toBeNull();
  });

  it("falls back to home icon when no Matrix client is available", () => {
    render(<SourcesPanel onAddSource={() => {}} />);
    // No client → useAvatarUrl returns null → home material symbol renders.
    expect(screen.getByTestId("porch-tile-home-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("porch-tile-avatar")).toBeNull();
  });

  it("invokes onPorchOpen when the tile is clicked", () => {
    const onPorchOpen = vi.fn();
    render(
      <SourcesPanel onAddSource={() => {}} onPorchOpen={onPorchOpen} />,
    );
    fireEvent.click(screen.getByTestId("porch-tile"));
    expect(onPorchOpen).toHaveBeenCalledTimes(1);
  });

  it("renders an offline indicator when no peers have recent lastSeen", () => {
    // Stale peer (last seen >60s ago) → still offline.
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
    const wrapper = screen.getByTestId("porch-tile-wrapper");
    expect(
      within(wrapper).getByTestId("porch-tile-online-no"),
    ).toBeInTheDocument();
  });
});
