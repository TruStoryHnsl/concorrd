import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExploreModal } from "../ExploreModal";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";
import * as concordApi from "../../../api/concord";

// Mock the API helper. The real one reaches for `fetch` + getApiBase(),
// and we only care about contract behavior here.
vi.mock("../../../api/concord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/concord")>();
  return {
    ...actual,
    listExploreServers: vi.fn(),
  };
});

const mockedListExploreServers = vi.mocked(concordApi.listExploreServers);

/**
 * Build a minimal MatrixClient-like stub exposing just the methods the
 * ExploreModal touches (`publicRooms`, `joinRoom`). We do this instead of
 * instantiating a real matrix-js-sdk client so the test stays hermetic.
 */
function makeFakeClient(overrides?: {
  publicRooms?: ReturnType<typeof vi.fn>;
  joinRoom?: ReturnType<typeof vi.fn>;
}) {
  return {
    publicRooms:
      overrides?.publicRooms ??
      vi.fn().mockResolvedValue({ chunk: [] }),
    joinRoom:
      overrides?.joinRoom ?? vi.fn().mockResolvedValue({ roomId: "!joined:x" }),
  };
}

function seedAuth(client: ReturnType<typeof makeFakeClient> | null = null) {
  // Reset the auth store to a known state with a fake access token
  // without going through `login()` (which instantiates a real
  // matrix-js-sdk client — heavy and not needed for this test).
  useAuthStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    userId: "@tester:example.org",
    accessToken: "test-access-token",
    isLoggedIn: true,
    isLoading: false,
  });
}

function resetToasts() {
  useToastStore.setState({ toasts: [] });
}

describe("<ExploreModal />", () => {
  beforeEach(() => {
    mockedListExploreServers.mockReset();
    seedAuth();
    resetToasts();
  });

  it("renders federated peers from the API", async () => {
    mockedListExploreServers.mockResolvedValueOnce([
      {
        domain: "alpha.example.org",
        name: "Alpha Instance",
        description: "The first federated friend",
      },
      {
        domain: "beta.example.org",
        name: "beta.example.org",
        description: null,
      },
    ]);

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    // Wait for the two domains to appear — the first one has a distinct
    // name, the second has name === domain.
    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    expect(screen.getByText("alpha.example.org")).toBeInTheDocument();
    expect(screen.getByText("beta.example.org")).toBeInTheDocument();
    expect(screen.getByText("The first federated friend")).toBeInTheDocument();

    // API was called with the token seeded in the auth store.
    expect(mockedListExploreServers).toHaveBeenCalledTimes(1);
    expect(mockedListExploreServers).toHaveBeenCalledWith("test-access-token");
  });

  it("surfaces an error and exposes a retry button when the fetch fails", async () => {
    mockedListExploreServers.mockRejectedValueOnce(new Error("boom: network"));

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't load federated servers/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/boom: network/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // Error path should also push a toast via the shared store.
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toMatch(/boom: network/);
    expect(toasts[0].type).toBe("error");
  });

  it("shows an empty-state message when the allowlist is empty", async () => {
    mockedListExploreServers.mockResolvedValueOnce([]);

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(/No federated servers yet/i),
      ).toBeInTheDocument();
    });
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <ExploreModal isOpen={false} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(mockedListExploreServers).not.toHaveBeenCalled();
  });

  it("browses public rooms on the selected federated server", async () => {
    mockedListExploreServers.mockResolvedValueOnce([
      {
        domain: "alpha.example.org",
        name: "Alpha Instance",
        description: null,
      },
    ]);

    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!general:alpha.example.org",
          name: "General",
          topic: "Catch-all",
          canonical_alias: "#general:alpha.example.org",
          num_joined_members: 42,
        },
        {
          room_id: "!announcements:alpha.example.org",
          name: "Announcements",
          num_joined_members: 1,
        },
      ],
    });
    seedAuth(makeFakeClient({ publicRooms }));

    const user = userEvent.setup();
    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    // Wait for the explore list to render, then click "Browse public rooms".
    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );

    // Public-rooms fetch should be keyed on the remote server.
    expect(publicRooms).toHaveBeenCalledTimes(1);
    expect(publicRooms).toHaveBeenCalledWith({
      server: "alpha.example.org",
      limit: 50,
    });

    // Both rooms from the mocked directory should appear.
    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
    expect(screen.getByText("Announcements")).toBeInTheDocument();
    expect(screen.getByText("Catch-all")).toBeInTheDocument();
    expect(screen.getByText("42 members")).toBeInTheDocument();
    expect(screen.getByText("1 member")).toBeInTheDocument();

    // The toggle flips to "Hide rooms" while expanded.
    expect(
      screen.getByRole("button", { name: /hide rooms/i }),
    ).toBeInTheDocument();

    // Collapse and re-expand should NOT refetch (per-domain cache).
    await user.click(screen.getByRole("button", { name: /hide rooms/i }));
    await user.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    expect(publicRooms).toHaveBeenCalledTimes(1);
  });

  it("joins a room via the room's canonical alias with the domain as via hint", async () => {
    mockedListExploreServers.mockResolvedValueOnce([
      { domain: "alpha.example.org", name: "Alpha", description: null },
    ]);

    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!general:alpha.example.org",
          name: "General",
          canonical_alias: "#general:alpha.example.org",
          num_joined_members: 5,
        },
      ],
    });
    const joinRoom = vi.fn().mockResolvedValue({ roomId: "!joined:x" });
    seedAuth(makeFakeClient({ publicRooms, joinRoom }));

    const user = userEvent.setup();
    render(<ExploreModal isOpen={true} onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /join/i }));

    expect(joinRoom).toHaveBeenCalledWith(
      "#general:alpha.example.org",
      { viaServers: ["alpha.example.org"] },
    );
  });
});
