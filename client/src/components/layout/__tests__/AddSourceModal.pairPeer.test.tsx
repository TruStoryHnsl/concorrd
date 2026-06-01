/**
 * AddSourceModal — "Pair a peer" tile + screen.
 *
 * Pins the 2026-05-30 surface that exposes peer pairing alongside the
 * existing Concord / Matrix / Mozilla / Custom-Matrix tiles in the Add
 * Source pick screen.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// LocalHostingControl pulls in servitude + tauri detect. Stub to a
// harmless placeholder so the pick screen renders without the native
// host-control machinery.
vi.mock("../../sources/LocalHostingControl", () => ({
  LocalHostingControl: () => (
    <div data-testid="local-hosting-control-stub" />
  ),
}));

// PeerCardScanner is the body of the pair-peer screen — render a small
// recognizable stub so we can assert that the screen mounted it.
vi.mock("../../peers/PeerCardScanner", () => ({
  PeerCardScanner: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="peer-card-scanner-stub">
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

// SourceBrandIcon is used in the tile chrome — stub it so tests don't
// drag SVG assets through jsdom.
vi.mock("../../sources/sourceBrand", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sources/sourceBrand")>();
  return {
    ...actual,
    SourceBrandIcon: () => <span data-testid="brand-icon" />,
  };
});

import { AddSourceModal } from "../ChatLayout";

describe("<AddSourceModal /> pair-peer surface", () => {
  beforeEach(() => {
    // Belt-and-braces: any pending SSO state from a prior test would
    // force the modal to land on the validating screen.
    window.localStorage.clear();
  });

  it("renders a 'Pair a peer' tile on the pick screen", () => {
    render(
      <AddSourceModal
        onClose={() => {}}
        onSourceAdded={() => {}}
      />,
    );

    const tile = screen.getByTestId("add-source-tile-pair-peer");
    expect(tile).toBeInTheDocument();
    expect(tile).toHaveTextContent(/pair a peer/i);
    expect(tile).toHaveTextContent(/qr|deeplink|matrix room/i);
  });

  it("clicking the tile switches to the pair-peer screen which mounts the scanner", () => {
    render(
      <AddSourceModal
        onClose={() => {}}
        onSourceAdded={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("add-source-tile-pair-peer"));

    expect(
      screen.getByTestId("add-source-screen-pair-peer"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("peer-card-scanner-stub"),
    ).toBeInTheDocument();
  });
});
