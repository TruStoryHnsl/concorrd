/**
 * Phase F — PersonalDevices owner-side tests.
 *
 * Covers the three user-visible affordances spec'd in the Phase F task:
 *
 *   1. "Add personal device" calls porchLinkPersonalDevice with the
 *      entered peer-id + label.
 *   2. "Sync now" button surfaces per-table counts as a toast on the
 *      happy path.
 *   3. "Unlink" button shows a confirm modal before firing
 *      porchUnlinkDevice.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const linkMock = vi.fn();
const unlinkMock = vi.fn();
const listMock = vi.fn();
const syncNowMock = vi.fn();
const syncAllMock = vi.fn();

vi.mock("../../../api/porch", async () => {
  const actual = await vi.importActual<typeof import("../../../api/porch")>(
    "../../../api/porch",
  );
  return {
    ...actual,
    porchLinkPersonalDevice: (
      ...a: Parameters<typeof actual.porchLinkPersonalDevice>
    ) => linkMock(...a),
    porchUnlinkDevice: (
      ...a: Parameters<typeof actual.porchUnlinkDevice>
    ) => unlinkMock(...a),
    porchListDeviceLinks: () => listMock(),
    porchSyncNow: (...a: Parameters<typeof actual.porchSyncNow>) =>
      syncNowMock(...a),
    porchSyncAllPersonalDevices: () => syncAllMock(),
  };
});

vi.mock("../../../api/servitude", () => ({
  isTauri: () => true,
}));

import { PersonalDevices } from "../PersonalDevices";

describe("PersonalDevices", () => {
  beforeEach(() => {
    linkMock.mockReset();
    unlinkMock.mockReset();
    listMock.mockReset();
    syncNowMock.mockReset();
    syncAllMock.mockReset();
    listMock.mockResolvedValue([]);
    syncAllMock.mockResolvedValue([]);
  });

  it("Add personal device calls porchLinkPersonalDevice with the entered peer-id + label", async () => {
    linkMock.mockResolvedValue({
      peer_id: "12D3KooWPhone",
      device_id: "01JDEVICE",
      role: "personal_device",
      linked_at: 100,
      last_sync_at: null,
      last_sync_lamport: 0,
      label: "My phone",
    });
    render(<PersonalDevices />);
    await waitFor(() =>
      expect(
        screen.getByTestId("personal-add-device-button"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("personal-add-device-button"));
    fireEvent.change(screen.getByTestId("personal-add-device-peer-id"), {
      target: { value: "12D3KooWPhone" },
    });
    fireEvent.change(screen.getByTestId("personal-add-device-label"), {
      target: { value: "My phone" },
    });
    fireEvent.click(screen.getByTestId("personal-add-device-submit"));

    await waitFor(() => expect(linkMock).toHaveBeenCalledTimes(1));
    expect(linkMock).toHaveBeenCalledWith("12D3KooWPhone", "My phone");
  });

  it("Sync now button surfaces SyncReport per-table counts as a toast", async () => {
    listMock.mockResolvedValue([
      {
        peer_id: "12D3KooWPhone",
        device_id: "01JD",
        role: "personal_device",
        linked_at: 100,
        last_sync_at: null,
        last_sync_lamport: 0,
        label: "My phone",
      },
    ]);
    syncNowMock.mockResolvedValue({
      peer_id: "12D3KooWPhone",
      pulled_count_per_table: { channels: 2, messages: 5 },
      pushed_count_per_table: { channels: 1, messages: 3 },
      error: null,
    });

    render(<PersonalDevices />);
    await waitFor(() =>
      expect(
        screen.getByTestId("personal-sync-now-12D3KooWPhone"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("personal-sync-now-12D3KooWPhone"));

    await waitFor(() => expect(syncNowMock).toHaveBeenCalledTimes(1));
    expect(syncNowMock).toHaveBeenCalledWith("12D3KooWPhone");
    await waitFor(() =>
      expect(screen.getByTestId("personal-toast")).toBeInTheDocument(),
    );
    // 2 + 5 pulled, 1 + 3 pushed → "7 pulled / 4 pushed"
    expect(screen.getByTestId("personal-toast").textContent).toMatch(
      /7 pulled \/ 4 pushed/,
    );
  });

  it("Unlink button shows confirm modal before calling porchUnlinkDevice", async () => {
    listMock.mockResolvedValue([
      {
        peer_id: "12D3KooWPhone",
        device_id: "01JD",
        role: "personal_device",
        linked_at: 100,
        last_sync_at: 200,
        last_sync_lamport: 9,
        label: "My phone",
      },
    ]);
    unlinkMock.mockResolvedValue(undefined);

    render(<PersonalDevices />);
    await waitFor(() =>
      expect(
        screen.getByTestId("personal-unlink-12D3KooWPhone"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("personal-unlink-12D3KooWPhone"));

    // Modal must appear; unlink must NOT have been called yet.
    await waitFor(() =>
      expect(
        screen.getByTestId("personal-unlink-confirm-modal"),
      ).toBeInTheDocument(),
    );
    expect(unlinkMock).not.toHaveBeenCalled();

    // Cancel — no call.
    fireEvent.click(screen.getByTestId("personal-unlink-confirm-cancel"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("personal-unlink-confirm-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(unlinkMock).not.toHaveBeenCalled();

    // Re-open + confirm — call fires.
    fireEvent.click(screen.getByTestId("personal-unlink-12D3KooWPhone"));
    await waitFor(() =>
      expect(
        screen.getByTestId("personal-unlink-confirm-modal"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("personal-unlink-confirm-yes"));

    await waitFor(() => expect(unlinkMock).toHaveBeenCalledTimes(1));
    expect(unlinkMock).toHaveBeenCalledWith("12D3KooWPhone");
  });
});
