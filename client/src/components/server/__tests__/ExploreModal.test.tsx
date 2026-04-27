import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { ExploreModal } from "../ExploreModal";
import { useAuthStore } from "../../../stores/auth";
import { useSourcesStore } from "../../../stores/sources";
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

// Shape-only stub of the MatrixClient methods the modal calls. Every test
// that drills into the rooms view builds its own pair of mocks on top of
// this base so assertions can check call arguments.
function makeFakeMatrixClient(overrides: {
  publicRooms?: ReturnType<typeof vi.fn>;
  joinRoom?: ReturnType<typeof vi.fn>;
}): MatrixClient {
  return {
    publicRooms: overrides.publicRooms ?? vi.fn(),
    joinRoom: overrides.joinRoom ?? vi.fn(),
  } as unknown as MatrixClient;
}

function seedAuth(client: MatrixClient | null = null) {
  // Reset the auth store to a known state with a fake access token
  // without going through `login()` (which instantiates a real
  // matrix-js-sdk client — heavy and not needed for this test).
  useAuthStore.setState({
    client,
    userId: "@tester:example.org",
    accessToken: "test-access-token",
    isLoggedIn: true,
    isLoading: false,
  });
}

function resetToasts() {
  useToastStore.setState({ toasts: [] });
}

function resetSources() {
  useSourcesStore.setState({ sources: [] });
}

describe("<ExploreModal />", () => {
  beforeEach(() => {
    mockedListExploreServers.mockReset();
    seedAuth();
    resetToasts();
    resetSources();
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

  it("fetches only once per open cycle, then refetches after close and reopen", async () => {
    mockedListExploreServers.mockResolvedValue([
      {
        domain: "alpha.example.org",
        name: "Alpha Instance",
        description: null,
      },
    ]);

    const { rerender } = render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    expect(mockedListExploreServers).toHaveBeenCalledTimes(1);

    rerender(<ExploreModal isOpen={true} onClose={() => {}} />);
    expect(mockedListExploreServers).toHaveBeenCalledTimes(1);

    rerender(<ExploreModal isOpen={false} onClose={() => {}} />);
    rerender(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(mockedListExploreServers).toHaveBeenCalledTimes(2);
    });
  });

  it("does not render connected sources in the explore list", async () => {
    mockedListExploreServers.mockResolvedValueOnce([]);
    useSourcesStore.setState({
      sources: [
        {
          id: "src_matrix",
          host: "matrix.example.org",
          instanceName: "Matrix Example",
          inviteToken: "",
          apiBase: "https://matrix.example.org/api",
          homeserverUrl: "https://matrix.example.org",
          status: "connected",
          enabled: true,
          addedAt: new Date().toISOString(),
          platform: "matrix",
        },
      ],
    });

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(/No federated servers yet/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Matrix Example")).not.toBeInTheDocument();
  });
});

describe("<ExploreModal /> rooms drill-down", () => {
  beforeEach(() => {
    mockedListExploreServers.mockReset();
    resetToasts();
    resetSources();
    // The servers step always returns a single peer so every rooms test can
    // click straight through without re-asserting the servers list.
    mockedListExploreServers.mockResolvedValue([
      {
        domain: "alpha.example.org",
        name: "Alpha Instance",
        description: null,
      },
    ]);
  });

  it("loads and renders public rooms when Browse public rooms is clicked", async () => {
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!general:alpha.example.org",
          name: "General",
          topic: "Chatter welcome",
          canonical_alias: "#general:alpha.example.org",
          num_joined_members: 42,
          world_readable: true,
          guest_can_join: false,
        },
      ],
    });
    seedAuth(makeFakeMatrixClient({ publicRooms }));

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    // Wait for the server row, then click its "Browse public rooms" button.
    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
    expect(screen.getByText("Chatter welcome")).toBeInTheDocument();
    expect(screen.getByText(/42 members/i)).toBeInTheDocument();
    expect(publicRooms).toHaveBeenCalledWith({
      server: "alpha.example.org",
      limit: 50,
    });
  });

  it("uses the local room directory path for the current homeserver", async () => {
    mockedListExploreServers.mockResolvedValueOnce([
      {
        domain: "example.concordchat.net",
        name: "Concorrd",
        description: null,
      },
    ]);
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!general:example.concordchat.net",
          name: "General",
          canonical_alias: "#general:example.concordchat.net",
          num_joined_members: 12,
          world_readable: true,
          guest_can_join: false,
        },
      ],
    });
    seedAuth(makeFakeMatrixClient({ publicRooms }));
    useAuthStore.setState({ userId: "@tester:example.concordchat.net" });

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Concorrd")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
    expect(publicRooms).toHaveBeenCalledWith({ limit: 50 });
  });

  it("joins a public room and closes the modal on success", async () => {
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!offtopic:alpha.example.org",
          name: "Off-topic",
          canonical_alias: "#offtopic:alpha.example.org",
          num_joined_members: 7,
          world_readable: true,
          guest_can_join: false,
        },
      ],
    });
    const joinRoom = vi.fn().mockResolvedValue({});
    seedAuth(makeFakeMatrixClient({ publicRooms, joinRoom }));
    const onClose = vi.fn();

    render(<ExploreModal isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => {
      expect(screen.getByText("Off-topic")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^join$/i }));

    await waitFor(() => {
      expect(joinRoom).toHaveBeenCalledWith("#offtopic:alpha.example.org", {
        viaServers: ["alpha.example.org"],
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === "success")).toBe(true);
  });

  it("joins local public rooms without federation viaServers hints", async () => {
    mockedListExploreServers.mockResolvedValueOnce([
      {
        domain: "example.concordchat.net",
        name: "Concorrd",
        description: null,
      },
    ]);
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!general:example.concordchat.net",
          name: "General",
          canonical_alias: "#general:example.concordchat.net",
          num_joined_members: 12,
          world_readable: true,
          guest_can_join: false,
        },
      ],
    });
    const joinRoom = vi.fn().mockResolvedValue({});
    seedAuth(makeFakeMatrixClient({ publicRooms, joinRoom }));
    useAuthStore.setState({ userId: "@tester:example.concordchat.net" });

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Concorrd")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^join$/i }));

    await waitFor(() => {
      expect(joinRoom).toHaveBeenCalledWith("#general:example.concordchat.net", {});
    });
  });

  it("surfaces an error + retry button when public rooms fetch fails", async () => {
    const publicRooms = vi
      .fn()
      .mockRejectedValueOnce(new Error("rooms boom"));
    seedAuth(makeFakeMatrixClient({ publicRooms }));

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't load public rooms/i),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText(/rooms boom/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // Error toast pushed to the shared store.
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === "error")).toBe(true);
  });

  it("shows the empty-state when a server has no public rooms", async () => {
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [] });
    seedAuth(makeFakeMatrixClient({ publicRooms }));

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No public rooms on this server/i),
      ).toBeInTheDocument();
    });
  });

  it("returns to the servers view when Back is clicked", async () => {
    const publicRooms = vi.fn().mockResolvedValue({ chunk: [] });
    seedAuth(makeFakeMatrixClient({ publicRooms }));

    render(<ExploreModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/No public rooms/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /back to servers/i }));

    // Back in the servers view, the heading reverts and the peer is listed.
    expect(screen.getByText(/Explore Federated Servers/i)).toBeInTheDocument();
    expect(screen.getByText("Alpha Instance")).toBeInTheDocument();
  });
});
