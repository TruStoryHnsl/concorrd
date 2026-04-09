import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function seedAuth() {
  // Reset the auth store to a known state with a fake access token
  // without going through `login()` (which instantiates a real
  // matrix-js-sdk client — heavy and not needed for this test).
  useAuthStore.setState({
    client: null,
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
});
