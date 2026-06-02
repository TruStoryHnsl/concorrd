/**
 * Phase D — VaultBrowser visitor-side tests.
 *
 * Three flows from the task spec are exercised here:
 *   - clicking a directory drills into it via porch_visit_list_vault
 *   - clicking a markdown file renders its content
 *   - the too-large envelope surfaces a friendly placeholder
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listVaultMock = vi.fn();
const getVaultFileMock = vi.fn();

vi.mock("../../../api/porch", async () => {
  const actual = await vi.importActual<typeof import("../../../api/porch")>(
    "../../../api/porch",
  );
  return {
    ...actual,
    porchVisitListVault: (...a: Parameters<typeof actual.porchVisitListVault>) =>
      listVaultMock(...a),
    porchVisitGetVaultFile: (
      ...a: Parameters<typeof actual.porchVisitGetVaultFile>
    ) => getVaultFileMock(...a),
  };
});

import { VaultBrowser } from "../VaultBrowser";
import type { VaultEntry, VaultFileResponse } from "../../../api/porch";

describe("VaultBrowser", () => {
  beforeEach(() => {
    listVaultMock.mockReset();
    getVaultFileMock.mockReset();
  });

  it("clicking a directory drills into it via porch_visit_list_vault", async () => {
    const root: VaultEntry[] = [
      { path: "campaign", kind: "directory", size: null, modified_at: null },
      { path: "readme.md", kind: "file", size: 12, modified_at: null },
    ];
    const sub: VaultEntry[] = [
      {
        path: "campaign/notes.md",
        kind: "file",
        size: 42,
        modified_at: null,
      },
    ];
    listVaultMock.mockImplementation(async (_peer, _ch, path: string) => {
      if (path === "") return root;
      if (path === "campaign") return sub;
      return [];
    });

    render(
      <VaultBrowser peerId="12D3PEER" channelId="ob-1" channelName="Vault" />,
    );

    // Root listed.
    await waitFor(() =>
      expect(screen.getByTestId("vault-dir-campaign")).toBeInTheDocument(),
    );
    expect(listVaultMock).toHaveBeenCalledWith("12D3PEER", "ob-1", "");

    // Click the directory; expect the visit_list_vault call for the
    // sub-path AND the sub-file to appear.
    fireEvent.click(screen.getByTestId("vault-dir-campaign"));
    await waitFor(() =>
      expect(screen.getByTestId("vault-file-campaign/notes.md")).toBeInTheDocument(),
    );
    const calls = listVaultMock.mock.calls.map((c) => c[2]);
    expect(calls).toContain("campaign");
  });

  it("clicking a markdown file renders its content", async () => {
    listVaultMock.mockResolvedValue([
      { path: "hello.md", kind: "file", size: 12, modified_at: null },
    ] satisfies VaultEntry[]);
    const body = "# Hello\n\nThis is **bold**.";
    const b64 = btoa(body);
    getVaultFileMock.mockResolvedValue({
      kind: "inline",
      path: "hello.md",
      mime_type: "text/markdown",
      bytes_b64: b64,
      size: body.length,
    } satisfies VaultFileResponse);

    render(
      <VaultBrowser peerId="12D3PEER" channelId="ob-1" channelName="Vault" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("vault-file-hello.md")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("vault-file-hello.md"));
    // The lazy-loaded MarkdownView resolves asynchronously; wait for
    // the rendered container to mount + content to appear.
    await waitFor(
      () => expect(screen.getByTestId("vault-markdown-rendered")).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // The rendered content includes the heading text.
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("too-large file surfaces a friendly placeholder", async () => {
    listVaultMock.mockResolvedValue([
      { path: "huge.png", kind: "file", size: 999_999, modified_at: null },
    ] satisfies VaultEntry[]);
    getVaultFileMock.mockResolvedValue({
      kind: "too_large",
      path: "huge.png",
      mime_type: "image/png",
      size: 1_500_000,
    } satisfies VaultFileResponse);

    render(
      <VaultBrowser peerId="12D3PEER" channelId="ob-1" channelName="Vault" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("vault-file-huge.png")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("vault-file-huge.png"));
    await waitFor(() =>
      expect(screen.getByTestId("vault-file-too-large")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("vault-file-too-large").textContent).toMatch(
      /too large to preview/i,
    );
  });
});
