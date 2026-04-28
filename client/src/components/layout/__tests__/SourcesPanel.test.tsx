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

  it("right click opens the source browser directly without toggling the source", () => {
    const onSourceOpen = vi.fn();
    render(
      <SourcesPanel
        onAddSource={() => {}}
        onSourceOpen={onSourceOpen}
      />,
    );

    fireEvent.contextMenu(screen.getByTitle("Matrix — Matrix"));

    expect(useSourcesStore.getState().sources[0].enabled).toBe(true);
    expect(onSourceOpen).toHaveBeenCalledWith("src_matrix");
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
