import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the porch API surface BEFORE importing the editor, so the
// component picks up the mocked functions.
const getThemeMock = vi.fn();
const setThemeMock = vi.fn();
const uploadAssetMock = vi.fn();
const listAssetsMock = vi.fn();

vi.mock("../../../api/porch", async () => {
  const actual = await vi.importActual<typeof import("../../../api/porch")>(
    "../../../api/porch",
  );
  return {
    ...actual,
    porchGetTheme: (...a: Parameters<typeof actual.porchGetTheme>) =>
      getThemeMock(...a),
    porchSetTheme: (...a: Parameters<typeof actual.porchSetTheme>) =>
      setThemeMock(...a),
    porchUploadAsset: (...a: Parameters<typeof actual.porchUploadAsset>) =>
      uploadAssetMock(...a),
    porchListAssets: (...a: Parameters<typeof actual.porchListAssets>) =>
      listAssetsMock(...a),
  };
});

// Import AFTER the mock so the editor reads the mocked module.
import { ChannelThemeEditor } from "../ChannelThemeEditor";
import { defaultChannelTheme, type ChannelTheme } from "../../../api/porch";

describe("ChannelThemeEditor", () => {
  beforeEach(() => {
    getThemeMock.mockReset();
    setThemeMock.mockReset();
    uploadAssetMock.mockReset();
    listAssetsMock.mockReset();
    listAssetsMock.mockResolvedValue([]);
  });

  it("color-picker updates flip the Save button live; Save calls porchSetTheme with the new theme", async () => {
    const initial = defaultChannelTheme("porch-default");
    getThemeMock.mockResolvedValue(initial);
    setThemeMock.mockImplementation(async (t: ChannelTheme) => ({
      ...t,
      updated_at: 1234,
    }));

    render(
      <ChannelThemeEditor channelId="porch-default" channelName="Porch" />,
    );

    // Wait for the initial fetch to settle and the editor to render.
    await waitFor(() => screen.getByTestId("color-primary"));

    // Tweak primary color.
    const primaryInput = screen.getByTestId("color-primary") as HTMLInputElement;
    fireEvent.input(primaryInput, { target: { value: "#abcdef" } });

    // Save button enabled now (dirty).
    const saveBtn = screen.getByTestId("theme-save-button") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);

    await waitFor(() => expect(setThemeMock).toHaveBeenCalledTimes(1));
    const arg = setThemeMock.mock.calls[0][0] as ChannelTheme;
    expect(arg.primary_color).toBe("#abcdef");
    expect(arg.channel_id).toBe("porch-default");
  });

  it("upload button calls porchUploadAsset with the file mime + base64 bytes", async () => {
    const initial = defaultChannelTheme("porch-default");
    getThemeMock.mockResolvedValue(initial);
    uploadAssetMock.mockResolvedValue({
      id: "01ASSET",
      channel_id: "porch-default",
      mime_type: "image/png",
      file_path: "01ASSET.png",
      bytes: 4,
      sha256: "abc",
      created_at: 1234,
    });

    render(
      <ChannelThemeEditor channelId="porch-default" channelName="Porch" />,
    );
    await waitFor(() => screen.getByTestId("color-primary"));

    // Switch to the image tab so the file-input mounts.
    fireEvent.click(screen.getByTestId("bg-tab-image"));
    const fileInput = screen.getByTestId("bg-image-file-input") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "x.png", {
      type: "image/png",
    });
    Object.defineProperty(fileInput, "files", { value: [file] });
    fireEvent.change(fileInput);

    await waitFor(() => expect(uploadAssetMock).toHaveBeenCalledTimes(1));
    const [chId, mime, b64] = uploadAssetMock.mock.calls[0];
    expect(chId).toBe("porch-default");
    expect(mime).toBe("image/png");
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);
  });
});
