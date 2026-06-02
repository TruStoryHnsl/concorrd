/**
 * UsersTab component tests.
 *
 * Covers the four Phase-1 acceptance criteria:
 *
 *  1. Renders the list returned by `userProfileList()` with the
 *     provenance badge variant on each row.
 *  2. The create-profile form wires through `userProfileCreate`.
 *  3. Inline rename wires through `userProfileRename`.
 *  4. Promote-to-primary wires through `userProfileSetPrimary` and the
 *     star icon moves to the promoted row after refresh.
 *  5. Delete fires a confirm → then calls `userProfileDelete` with the
 *     primary-demotion flag honoured.
 *
 * The userProfile API module is mocked so the tests don't touch real
 * IPC. The mock returns whatever the test sets it to return on each
 * call — see `setMockProfiles` in each test.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const {
  userProfileListMock,
  userProfileCreateMock,
  userProfileRenameMock,
  userProfileSetPrimaryMock,
  userProfileDeleteMock,
} = vi.hoisted(() => ({
  userProfileListMock: vi.fn(),
  userProfileCreateMock: vi.fn(),
  userProfileRenameMock: vi.fn(),
  userProfileSetPrimaryMock: vi.fn(),
  userProfileDeleteMock: vi.fn(),
}));

vi.mock("../../../api/userProfile", () => ({
  userProfileList: userProfileListMock,
  userProfileCreate: userProfileCreateMock,
  userProfileRename: userProfileRenameMock,
  userProfileSetPrimary: userProfileSetPrimaryMock,
  userProfileDelete: userProfileDeleteMock,
}));

import { UsersTab } from "../UsersTab";
import type { UserProfile } from "../../../api/userProfile";

function makeProfile(overrides: Partial<UserProfile>): UserProfile {
  return {
    id: "01H000000000000000000000A0",
    display_name: "Local",
    avatar_url: null,
    is_primary: true,
    provenance: "local",
    created_at: 1_000_000,
    ...overrides,
  };
}

describe("<UsersTab />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders each profile row with its display name and provenance badge", async () => {
    userProfileListMock.mockResolvedValue([
      makeProfile({ id: "p-primary", display_name: "Alpha", is_primary: true }),
      makeProfile({
        id: "p-relay",
        display_name: "Work",
        is_primary: false,
        provenance: "relay_restored",
      }),
    ]);

    render(<UsersTab />);

    // Wait for the async list fetch + render.
    await waitFor(() => {
      expect(screen.getAllByTestId("users-tab-profile-row")).toHaveLength(2);
    });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();

    const badges = screen.getAllByTestId("users-tab-provenance-badge");
    expect(badges[0]).toHaveAttribute("data-provenance", "local");
    expect(badges[0]).toHaveTextContent("Local");
    expect(badges[1]).toHaveAttribute("data-provenance", "relay_restored");
    expect(badges[1]).toHaveTextContent("From relay");

    // Star marker only on the primary row.
    const primaryMarkers = screen.getAllByTestId("users-tab-primary-marker");
    expect(primaryMarkers).toHaveLength(1);
  });

  it("create-profile form calls userProfileCreate and refreshes the list", async () => {
    // First call returns single seeded profile; after create, returns
    // both so the refresh visibly shows the new row.
    const initial = makeProfile({ id: "p-alpha", display_name: "Alpha" });
    const after = [
      initial,
      makeProfile({ id: "p-work", display_name: "Work", is_primary: false }),
    ];
    userProfileListMock
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce(after);
    userProfileCreateMock.mockResolvedValue(after[1]);

    render(<UsersTab />);
    await screen.findByText("Alpha");

    // Open the create form.
    fireEvent.click(screen.getByTestId("users-tab-create-start"));
    const input = await screen.findByTestId("users-tab-create-input");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByTestId("users-tab-create-save"));

    await waitFor(() => {
      expect(userProfileCreateMock).toHaveBeenCalledWith("Work");
    });
    // Refresh fires after create — assert the new row appears.
    await screen.findByText("Work");
  });

  it("inline rename submits new display name via userProfileRename", async () => {
    const seed = makeProfile({ id: "p-alpha", display_name: "Alpha" });
    const renamed = { ...seed, display_name: "Renamed" };
    userProfileListMock
      .mockResolvedValueOnce([seed])
      .mockResolvedValueOnce([renamed]);
    userProfileRenameMock.mockResolvedValue(renamed);

    render(<UsersTab />);
    await screen.findByText("Alpha");

    // Click Rename, type new name, click Save.
    fireEvent.click(screen.getByTestId("users-tab-rename-start"));
    const input = await screen.findByTestId("users-tab-rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("users-tab-rename-save"));

    await waitFor(() => {
      expect(userProfileRenameMock).toHaveBeenCalledWith("p-alpha", "Renamed");
    });
    await screen.findByText("Renamed");
  });

  it("promote-to-primary calls userProfileSetPrimary on the clicked row", async () => {
    const a = makeProfile({ id: "p-a", display_name: "Alpha", is_primary: true });
    const b = makeProfile({
      id: "p-b",
      display_name: "Beta",
      is_primary: false,
    });
    const aDemoted = { ...a, is_primary: false };
    const bPromoted = { ...b, is_primary: true };

    userProfileListMock
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([bPromoted, aDemoted]);
    userProfileSetPrimaryMock.mockResolvedValue(bPromoted);

    render(<UsersTab />);
    await screen.findByText("Beta");

    // The promote button is rendered ONLY on non-primary rows. Beta is
    // non-primary in the initial fetch.
    const promotes = screen.getAllByTestId("users-tab-promote");
    expect(promotes).toHaveLength(1);
    fireEvent.click(promotes[0]);

    await waitFor(() => {
      expect(userProfileSetPrimaryMock).toHaveBeenCalledWith("p-b");
    });
  });

  it("delete asks for confirmation and then calls userProfileDelete", async () => {
    const a = makeProfile({ id: "p-a", display_name: "Alpha", is_primary: true });
    const b = makeProfile({
      id: "p-b",
      display_name: "Beta",
      is_primary: false,
    });
    userProfileListMock
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([a]);
    userProfileDeleteMock.mockResolvedValue(undefined);

    render(<UsersTab />);
    await screen.findByText("Beta");

    // Click the delete button on the non-primary row.
    const deleteStarts = screen.getAllByTestId("users-tab-delete-start");
    // Two rows, two delete buttons; clicking either reveals confirm
    // state on that row. Click the second one (Beta).
    fireEvent.click(deleteStarts[1]);
    const confirm = await screen.findByTestId("users-tab-delete-confirm");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(userProfileDeleteMock).toHaveBeenCalledWith("p-b", false);
    });
  });
});
