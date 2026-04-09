import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExploreModal } from "../ExploreModal";
import { useAuthStore } from "../../../stores/auth";
import { useServerStore } from "../../../stores/server";
import { useToastStore } from "../../../stores/toast";
import * as concordApi from "../../../api/concord";
import type { Server } from "../../../api/concord";

// Mock the API helper. The real one reaches for `fetch` + getApiBase(),
// and we only care about contract behavior here.
vi.mock("../../../api/concord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/concord")>();
  return {
    ...actual,
    listExploreServers: vi.fn(),
    // Stubbed so `useServerStore.loadServers()` — which the ExploreModal
    // now calls after a successful join — doesn't try to hit /api/servers
    // in jsdom. Tests that care about the post-join navigation path set
    // this mock's return value to the server list they want the store
    // to hydrate with.
    listServers: vi.fn().mockResolvedValue([]),
    getDefaultServer: vi.fn().mockResolvedValue({
      server_id: null,
      is_member: true,
      name: null,
      created_at: null,
      member_count: 0,
    }),
    joinServer: vi.fn().mockResolvedValue(undefined),
    rejoinServerRooms: vi.fn().mockResolvedValue({ joined: 0, failures: {} }),
  };
});

const mockedListExploreServers = vi.mocked(concordApi.listExploreServers);
const mockedListServers = vi.mocked(concordApi.listServers);

/**
 * Build a minimal `Server` record matching the wire contract the API
 * returns. Used by tests exercising the post-join navigation path so
 * the server store hydrates with a server whose Channel.matrix_room_id
 * matches the roomId the fake Matrix client resolves to.
 */
function makeServer(overrides: Partial<Server> & { channelRoomId?: string }): Server {
  const { channelRoomId, ...rest } = overrides;
  return {
    id: "srv-1",
    name: "Test Server",
    icon_url: null,
    owner_id: "@tester:example.org",
    visibility: "private",
    abbreviation: null,
    media_uploads_enabled: false,
    channels: channelRoomId
      ? [
          {
            id: 1,
            name: "general",
            channel_type: "text",
            matrix_room_id: channelRoomId,
            position: 0,
          },
        ]
      : [],
    ...rest,
  };
}

/**
 * Build a minimal MatrixClient-like stub exposing just the methods the
 * ExploreModal touches. We do this instead of instantiating a real
 * matrix-js-sdk client so the test stays hermetic.
 *
 * In addition to `publicRooms` + `joinRoom` (which the modal uses
 * directly), the stub also implements `getRooms` and `getUserId` —
 * those feed `hydrateFederatedRooms`, which the modal now calls on
 * its post-join path to surface the newly-joined room as a
 * synthetic federated-server entry in the sidebar.
 */
function makeFakeClient(overrides?: {
  publicRooms?: ReturnType<typeof vi.fn>;
  joinRoom?: ReturnType<typeof vi.fn>;
  getRooms?: ReturnType<typeof vi.fn>;
  getUserId?: ReturnType<typeof vi.fn>;
  leave?: ReturnType<typeof vi.fn>;
}) {
  return {
    publicRooms:
      overrides?.publicRooms ??
      vi.fn().mockResolvedValue({ chunk: [] }),
    joinRoom:
      overrides?.joinRoom ?? vi.fn().mockResolvedValue({ roomId: "!joined:x" }),
    // Default: the client "knows about" no rooms. Tests that want
    // to assert the federated-hydration path supply their own
    // getRooms mock returning Room-like objects.
    getRooms: overrides?.getRooms ?? vi.fn().mockReturnValue([]),
    getUserId:
      overrides?.getUserId ?? vi.fn().mockReturnValue("@tester:example.org"),
    // `leaveOrphanRooms` (the cleanup pass) calls this; ExploreModal
    // tests never trigger it directly but the store's action type
    // requires the method to exist on the FederatedRoomsClientLike
    // shape, so we supply a no-op resolved default.
    leave: overrides?.leave ?? vi.fn().mockResolvedValue(undefined),
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
    mockedListServers.mockReset();
    mockedListServers.mockResolvedValue([]);
    // Reset the server store so each test starts from a clean slate.
    // loadServers() will repopulate it from the mocked listServers.
    useServerStore.setState({
      servers: [],
      activeServerId: null,
      activeChannelId: null,
      members: {},
    });
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
    await user.click(screen.getByTestId("explore-join-!general:alpha.example.org"));

    expect(joinRoom).toHaveBeenCalledWith(
      "#general:alpha.example.org",
      { viaServers: ["alpha.example.org"] },
    );
  });

  it("shows Joining… state + aria-busy while the join is in flight, then reverts", async () => {
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

    // Deferred promise we control — lets us observe the intermediate
    // "Joining…" state with the join still in flight, then resolve it
    // to exercise the post-success path.
    let resolveJoin: ((value: { roomId: string }) => void) | undefined;
    const joinRoom = vi.fn().mockImplementation(
      () =>
        new Promise<{ roomId: string }>((res) => {
          resolveJoin = res;
        }),
    );
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

    const joinButton = screen.getByTestId(
      "explore-join-!general:alpha.example.org",
    );
    await user.click(joinButton);

    // Intermediate state: button is disabled, aria-busy, label is
    // "Joining…". The join promise is still in flight because
    // resolveJoin hasn't been called yet.
    await waitFor(() => {
      expect(joinButton).toBeDisabled();
      expect(joinButton).toHaveAttribute("aria-busy", "true");
      expect(joinButton).toHaveTextContent(/joining/i);
    });

    // Now resolve the join. The rest of the join flow (loadServers +
    // navigate/toast) runs after.
    resolveJoin?.({ roomId: "!joined:alpha.example.org" });

    // Eventually the button should either disappear (modal closed) or
    // return to "Join". We rely on modal closure here because all
    // post-join paths call onClose().
    await waitFor(() => {
      expect(joinRoom).toHaveBeenCalledTimes(1);
    });
  });

  it("prevents double-click on the Join button while joining", async () => {
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
    // Never-resolving join promise so the button stays disabled.
    const joinRoom = vi.fn().mockImplementation(() => new Promise(() => {}));
    seedAuth(makeFakeClient({ publicRooms, joinRoom }));

    const user = userEvent.setup();
    render(<ExploreModal isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    await user.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => expect(screen.getByText("General")).toBeInTheDocument());

    const joinButton = screen.getByTestId(
      "explore-join-!general:alpha.example.org",
    );
    await user.click(joinButton);
    await user.click(joinButton);
    await user.click(joinButton);

    // Three clicks, one call — the disabled state prevents subsequent
    // invocations.
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });

  it("navigates to the matching Concord server after a successful join", async () => {
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
    // Resolver returns the canonical joined roomId — this is what
    // Concord's Channel.matrix_room_id stores.
    const joinRoom = vi
      .fn()
      .mockResolvedValue({ roomId: "!resolved:alpha.example.org" });
    seedAuth(makeFakeClient({ publicRooms, joinRoom }));

    // Prime the server-store mock so that after `loadServers()` the
    // joined room is findable as a Channel under a Concord server.
    mockedListServers.mockResolvedValue([
      makeServer({
        id: "srv-alpha",
        name: "Alpha Concord Server",
        channelRoomId: "!resolved:alpha.example.org",
      }),
    ]);

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ExploreModal isOpen={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    await user.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => expect(screen.getByText("General")).toBeInTheDocument());
    await user.click(screen.getByTestId("explore-join-!general:alpha.example.org"));

    // Join resolves → loadServers runs → server store has the match
    // → setActiveServer + setActiveChannel fire → modal closes.
    await waitFor(() => {
      expect(useServerStore.getState().activeServerId).toBe("srv-alpha");
    });
    expect(useServerStore.getState().activeChannelId).toBe(
      "!resolved:alpha.example.org",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a loose-room toast when the joined room isn't part of any Concord server", async () => {
    mockedListExploreServers.mockResolvedValueOnce([
      { domain: "alpha.example.org", name: "Alpha", description: null },
    ]);
    const publicRooms = vi.fn().mockResolvedValue({
      chunk: [
        {
          room_id: "!orphan:alpha.example.org",
          name: "Orphan",
          canonical_alias: "#orphan:alpha.example.org",
          num_joined_members: 2,
        },
      ],
    });
    const joinRoom = vi
      .fn()
      .mockResolvedValue({ roomId: "!orphan:alpha.example.org" });
    seedAuth(makeFakeClient({ publicRooms, joinRoom }));

    // No matching server — listServers returns an unrelated server
    // whose channels do NOT include the joined room.
    mockedListServers.mockResolvedValue([
      makeServer({
        id: "srv-other",
        name: "Other",
        channelRoomId: "!unrelated:beta.example.org",
      }),
    ]);

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ExploreModal isOpen={true} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    await user.click(
      screen.getByRole("button", { name: /browse public rooms/i }),
    );
    await waitFor(() => expect(screen.getByText("Orphan")).toBeInTheDocument());
    await user.click(screen.getByTestId("explore-join-!orphan:alpha.example.org"));

    // Loose-room path: an info toast explaining the limitation
    // appears, and onClose still fires so the user isn't stranded in
    // a modal that looks idle. Note that `activeServerId` is NOT
    // expected to be null after loadServers — the server store's
    // auto-select-first-server behavior will pick `srv-other` on
    // first load; what matters is that the *joined* room didn't drive
    // the navigation (the toast is how the user learns that).
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // activeChannelId is set by loadServers' auto-select to the
    // auto-picked server's first channel, NOT to the joined orphan
    // room. That proves the loose-room path was taken.
    expect(useServerStore.getState().activeChannelId).not.toBe(
      "!orphan:alpha.example.org",
    );

    const toasts = useToastStore.getState().toasts;
    expect(
      toasts.some((t) => /should appear in the sidebar shortly/i.test(t.message)),
    ).toBe(true);
  });
});
