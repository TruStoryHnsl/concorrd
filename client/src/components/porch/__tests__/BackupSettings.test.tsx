/**
 * Phase E — BackupSettings owner-side tests.
 *
 * Covers the three user-visible affordances spec'd in the Phase E task:
 *
 *   1. "Add target" calls porchBackupAddTarget with the entered values.
 *   2. "Push now" surfaces a success toast on the happy path.
 *   3. "Restore from this" requires a confirmation modal before firing
 *      the destructive porchBackupRestoreFrom call.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addTargetMock = vi.fn();
const removeTargetMock = vi.fn();
const listTargetsMock = vi.fn();
const listReceivedMock = vi.fn();
const pushNowMock = vi.fn();
const restoreFromMock = vi.fn();
const checkRemoteInfoMock = vi.fn();

vi.mock("../../../api/porch", async () => {
  const actual = await vi.importActual<typeof import("../../../api/porch")>(
    "../../../api/porch",
  );
  return {
    ...actual,
    porchBackupAddTarget: (
      ...a: Parameters<typeof actual.porchBackupAddTarget>
    ) => addTargetMock(...a),
    porchBackupRemoveTarget: (
      ...a: Parameters<typeof actual.porchBackupRemoveTarget>
    ) => removeTargetMock(...a),
    porchBackupListTargets: () => listTargetsMock(),
    porchBackupListReceived: () => listReceivedMock(),
    porchBackupPushNow: (
      ...a: Parameters<typeof actual.porchBackupPushNow>
    ) => pushNowMock(...a),
    porchBackupRestoreFrom: (
      ...a: Parameters<typeof actual.porchBackupRestoreFrom>
    ) => restoreFromMock(...a),
    porchBackupCheckRemoteInfo: (
      ...a: Parameters<typeof actual.porchBackupCheckRemoteInfo>
    ) => checkRemoteInfoMock(...a),
  };
});

vi.mock("../../../api/servitude", () => ({
  isTauri: () => true,
}));

import { BackupSettings } from "../BackupSettings";

describe("BackupSettings", () => {
  beforeEach(() => {
    addTargetMock.mockReset();
    removeTargetMock.mockReset();
    listTargetsMock.mockReset();
    listReceivedMock.mockReset();
    pushNowMock.mockReset();
    restoreFromMock.mockReset();
    checkRemoteInfoMock.mockReset();
    listTargetsMock.mockResolvedValue([]);
    listReceivedMock.mockResolvedValue([]);
    checkRemoteInfoMock.mockResolvedValue(null);
  });

  it("Add target calls porchBackupAddTarget with the entered peer-id + label", async () => {
    addTargetMock.mockResolvedValue({
      peer_id: "12D3KooWTarget",
      label: "docker",
      added_at: 100,
      last_success_at: null,
      last_failure_at: null,
      last_failure_reason: null,
    });
    render(<BackupSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("backup-add-target-button")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("backup-add-target-button"));
    fireEvent.change(screen.getByTestId("backup-add-target-peer-id"), {
      target: { value: "12D3KooWTarget" },
    });
    fireEvent.change(screen.getByTestId("backup-add-target-label"), {
      target: { value: "docker" },
    });
    fireEvent.click(screen.getByTestId("backup-add-target-submit"));

    await waitFor(() => expect(addTargetMock).toHaveBeenCalledTimes(1));
    expect(addTargetMock).toHaveBeenCalledWith("12D3KooWTarget", "docker");
  });

  it("Push now button surfaces success toast", async () => {
    listTargetsMock.mockResolvedValue([
      {
        peer_id: "12D3KooWA",
        label: null,
        added_at: 100,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
      },
    ]);
    pushNowMock.mockResolvedValue(undefined);

    render(<BackupSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("backup-push-now-12D3KooWA")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("backup-push-now-12D3KooWA"));

    await waitFor(() => expect(pushNowMock).toHaveBeenCalledTimes(1));
    expect(pushNowMock).toHaveBeenCalledWith("12D3KooWA");
    await waitFor(() =>
      expect(screen.getByTestId("backup-toast")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("backup-toast").textContent).toMatch(
      /Backup pushed/i,
    );
  });

  it("Restore button shows confirm modal before firing the destructive call", async () => {
    listTargetsMock.mockResolvedValue([
      {
        peer_id: "12D3KooWB",
        label: null,
        added_at: 100,
        last_success_at: 200,
        last_failure_at: null,
        last_failure_reason: null,
      },
    ]);
    restoreFromMock.mockResolvedValue({ schema_version: 5 });

    render(<BackupSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("backup-restore-from-12D3KooWB")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("backup-restore-from-12D3KooWB"));

    // Modal must appear; restoreFrom must NOT have been called yet.
    await waitFor(() =>
      expect(
        screen.getByTestId("backup-restore-confirm-modal"),
      ).toBeInTheDocument(),
    );
    expect(restoreFromMock).not.toHaveBeenCalled();

    // Click "Cancel" — no call.
    fireEvent.click(screen.getByTestId("backup-restore-confirm-cancel"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("backup-restore-confirm-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(restoreFromMock).not.toHaveBeenCalled();

    // Re-open + confirm — call fires with confirm=true.
    fireEvent.click(screen.getByTestId("backup-restore-from-12D3KooWB"));
    await waitFor(() =>
      expect(
        screen.getByTestId("backup-restore-confirm-modal"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("backup-restore-confirm-yes"));

    await waitFor(() => expect(restoreFromMock).toHaveBeenCalledTimes(1));
    expect(restoreFromMock).toHaveBeenCalledWith("12D3KooWB", true);
  });
});
