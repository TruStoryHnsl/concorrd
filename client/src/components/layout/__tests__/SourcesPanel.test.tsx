import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SourcesPanel } from "../SourcesPanel";
import { useSourcesStore } from "../../../stores/sources";

describe("<SourcesPanel />", () => {
  beforeEach(() => {
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
  });

  it("left click toggles the source and notifies selection", () => {
    const onSourceSelect = vi.fn();
    render(
      <SourcesPanel
        onAddSource={() => {}}
        onSourceSelect={onSourceSelect}
      />,
    );

    fireEvent.click(screen.getByTitle("Matrix — Matrix"));

    expect(useSourcesStore.getState().sources[0].enabled).toBe(false);
    expect(onSourceSelect).toHaveBeenCalledWith("src_matrix");
  });

  it("right click opens the per-source context menu without toggling the source", () => {
    const onSourceOpen = vi.fn();
    render(
      <SourcesPanel
        onAddSource={() => {}}
        onSourceOpen={onSourceOpen}
      />,
    );

    fireEvent.contextMenu(screen.getByTitle("Matrix — Matrix"));

    // Toggle state must NOT change on right-click (left-click is the
    // toggle action; right-click opens the menu).
    expect(useSourcesStore.getState().sources[0].enabled).toBe(true);
    // The context menu surfaces three entries: Open, Settings, Close
    // connection. The "Open" entry is what now drives onSourceOpen —
    // the user clicks it from the menu instead of the prior
    // right-click-equals-open shortcut.
    expect(
      screen.getByTestId("source-context-menu-src_matrix"),
    ).toBeInTheDocument();
    expect(onSourceOpen).not.toHaveBeenCalled();
  });

  it("Close connection menu entry severs the source after confirmation", () => {
    render(
      <SourcesPanel
        onAddSource={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByTitle("Matrix — Matrix"));
    // First click on "Close connection" surfaces the inline confirm
    // step — we don't want the destructive action to fire on a
    // single mis-click. The follow-up "Sever" button is the actual
    // commit.
    fireEvent.click(
      screen.getByTestId("source-context-close-src_matrix"),
    );
    fireEvent.click(
      screen.getByTestId("source-context-confirm-close-src_matrix"),
    );

    expect(useSourcesStore.getState().sources).toHaveLength(0);
  });

  // W2-10 — owner badge in the rail tile.
  it("renders an owner badge ONLY on sources where isOwner === true", () => {
    useSourcesStore.setState({
      sources: [
        {
          id: "src_owned",
          host: "127.0.0.1",
          instanceName: "My Living Room",
          inviteToken: "",
          apiBase: "http://127.0.0.1:8448",
          homeserverUrl: "http://127.0.0.1:8448",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "concord",
          isOwner: true,
        },
        {
          id: "src_remote",
          host: "matrix.org",
          instanceName: "Matrix",
          inviteToken: "",
          apiBase: "https://matrix.org",
          homeserverUrl: "https://matrix.org",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "matrix",
          isOwner: false,
        },
      ],
    });
    render(<SourcesPanel onAddSource={() => {}} />);
    expect(
      screen.queryByTestId("source-owner-badge-src_owned"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("source-owner-badge-src_remote"),
    ).not.toBeInTheDocument();
  });
});
