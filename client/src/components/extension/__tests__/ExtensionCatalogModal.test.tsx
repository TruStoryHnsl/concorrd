/**
 * INS-070 — Extension Library modal tests.
 *
 * Verifies:
 *   - The modal renders catalog rows fetched via
 *     `adminGetExtensionCatalog`.
 *   - Clicking the per-row Install button calls
 *     `adminInstallExtension` with the row's id + the user's access
 *     token.
 *   - Escape key closes the modal.
 *   - The close button calls onClose.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ExtensionCatalogModal } from "../ExtensionCatalogModal";
import { useAuthStore } from "../../../stores/auth";

const sampleCatalog = {
  catalog_url: "https://catalog.example.test/index.json",
  catalog: {
    catalog_version: 1,
    extensions: [
      {
        id: "com.concord.test-ext",
        version: "1.0.0",
        name: "Test Extension",
        description: "A test extension for the catalog modal.",
        bundle_url: "https://catalog.example.test/test-ext.zip",
      },
      {
        id: "com.concord.installed-ext",
        version: "2.0.0",
        name: "Installed Extension",
        description: "Already installed.",
        bundle_url: "https://catalog.example.test/installed.zip",
      },
    ],
  },
  installed_ids: ["com.concord.installed-ext"],
  installed_versions: { "com.concord.installed-ext": "2.0.0" },
};

const adminGetExtensionCatalog = vi.fn();
const adminInstallExtension = vi.fn();
const adminUninstallExtension = vi.fn();

vi.mock("../../../api/concord", () => ({
  adminGetExtensionCatalog: (...args: unknown[]) =>
    adminGetExtensionCatalog(...(args as [string])),
  adminInstallExtension: (...args: unknown[]) =>
    adminInstallExtension(...(args as [string, string])),
  adminUninstallExtension: (...args: unknown[]) =>
    adminUninstallExtension(...(args as [string, string])),
}));

// `useExtensionStore.getState().reloadCatalog` is called after
// install — stub it so the test doesn't reach into a real store.
vi.mock("../../../stores/extension", () => ({
  useExtensionStore: {
    getState: () => ({ reloadCatalog: vi.fn().mockResolvedValue(undefined) }),
  },
}));

describe("ExtensionCatalogModal (INS-070)", () => {
  beforeEach(() => {
    adminGetExtensionCatalog.mockReset();
    adminInstallExtension.mockReset();
    adminUninstallExtension.mockReset();
    adminGetExtensionCatalog.mockResolvedValue(sampleCatalog);
    useAuthStore.setState({ accessToken: "fake-token" } as never);
  });

  it("renders catalog rows after a successful fetch", async () => {
    render(<ExtensionCatalogModal onClose={() => {}} />);
    expect(adminGetExtensionCatalog).toHaveBeenCalledWith("fake-token");
    await waitFor(() => {
      expect(screen.getByTestId("ext-row-com.concord.test-ext")).toBeInTheDocument();
      expect(screen.getByTestId("ext-row-com.concord.installed-ext")).toBeInTheDocument();
    });
  });

  it("calls adminInstallExtension when a row's Install button is clicked", async () => {
    adminInstallExtension.mockResolvedValue(undefined);
    render(<ExtensionCatalogModal onClose={() => {}} />);

    const installBtn = await screen.findByTestId("ext-install-com.concord.test-ext");
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(adminInstallExtension).toHaveBeenCalledWith(
        "com.concord.test-ext",
        "fake-token",
      );
    });
  });

  it("invokes onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<ExtensionCatalogModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId("extension-catalog-modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(<ExtensionCatalogModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
