/**
 * Phase D — ObsidianChannelEditor owner-side test.
 *
 * Validates the "pick + save" flow: the editor opens the OS file
 * picker via @tauri-apps/plugin-dialog, captures the chosen path,
 * and on Save calls `porch_set_obsidian_config` with the path.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setObsidianConfigMock = vi.fn();
const getObsidianConfigMock = vi.fn();
const openDialogMock = vi.fn();

vi.mock("../../../api/porch", async () => {
  const actual = await vi.importActual<typeof import("../../../api/porch")>(
    "../../../api/porch",
  );
  return {
    ...actual,
    porchSetObsidianConfig: (
      ...a: Parameters<typeof actual.porchSetObsidianConfig>
    ) => setObsidianConfigMock(...a),
    porchGetObsidianConfig: (
      ...a: Parameters<typeof actual.porchGetObsidianConfig>
    ) => getObsidianConfigMock(...a),
  };
});

vi.mock("../../../api/servitude", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialogMock(...a),
}));

import { ObsidianChannelEditor } from "../ObsidianChannelEditor";

describe("ObsidianChannelEditor", () => {
  beforeEach(() => {
    setObsidianConfigMock.mockReset();
    getObsidianConfigMock.mockReset();
    openDialogMock.mockReset();
    getObsidianConfigMock.mockResolvedValue(null);
  });

  it("picking a vault root then saving calls porchSetObsidianConfig with the path", async () => {
    openDialogMock.mockResolvedValue("/home/user/vault");
    setObsidianConfigMock.mockImplementation(
      async (
        channelId: string,
        vaultRoot: string,
        subfolder: string | null,
        followSymlinks: boolean,
      ) => ({
        channel_id: channelId,
        vault_root: vaultRoot,
        subfolder,
        follow_symlinks: followSymlinks,
      }),
    );

    render(<ObsidianChannelEditor channelId="ob-1" channelName="Vault" />);
    await waitFor(() =>
      expect(screen.getByTestId("obsidian-pick-vault-root")).toBeInTheDocument(),
    );

    // Pick the vault root.
    fireEvent.click(screen.getByTestId("obsidian-pick-vault-root"));
    await waitFor(() =>
      expect(screen.getByTestId("obsidian-vault-root-display").textContent).toBe(
        "/home/user/vault",
      ),
    );

    // Save.
    fireEvent.click(screen.getByTestId("obsidian-save"));
    await waitFor(() =>
      expect(setObsidianConfigMock).toHaveBeenCalledTimes(1),
    );
    const [chId, root, sub, follow] = setObsidianConfigMock.mock.calls[0];
    expect(chId).toBe("ob-1");
    expect(root).toBe("/home/user/vault");
    expect(sub).toBeNull();
    expect(follow).toBe(false);
  });
});
