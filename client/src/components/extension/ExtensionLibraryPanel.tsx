/**
 * INS-070 — shared Extension Library panel.
 *
 * Renders the install / update / uninstall UI sourced from the remote
 * concord-extensions catalog. Used in two places:
 *
 *   - Settings → Admin → Extensions (`mode="settings-tab"`)
 *   - Tools dropdown → Extension Library modal (`mode="modal"`)
 *
 * The two surfaces share data fetching + action handlers; only the
 * outer padding / header treatment differs. Lifting the body out of
 * `AdminTab.tsx::ExtensionsSection` lets the new modal entry-point
 * reuse the install logic instead of forking it.
 */

import { useEffect, useState } from "react";
import { useToastStore } from "../../stores/toast";
import { useExtensionStore } from "../../stores/extension";
import {
  adminGetExtensionCatalog,
  adminInstallExtension,
  adminUninstallExtension,
  type ExtensionCatalogResponse,
} from "../../api/concord";

export type ExtensionLibraryMode = "settings-tab" | "modal";

interface ExtensionLibraryPanelProps {
  /** Where this panel is rendered — controls padding/heading style. */
  mode: ExtensionLibraryMode;
  /** Admin-scoped Matrix access token. Required for install/uninstall. */
  token: string | null;
}

export function ExtensionLibraryPanel({ mode, token }: ExtensionLibraryPanelProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [catalog, setCatalog] = useState<ExtensionCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetExtensionCatalog(token);
      setCatalog(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleInstall = async (id: string) => {
    if (!token) return;
    setBusyId(id);
    try {
      await adminInstallExtension(id, token);
      addToast(`Installed ${id}`, "success");
      // Refresh THIS panel + the global extension store so the
      // Applications sidebar surfaces the new extension without a
      // page reload. The store has a `catalogLoaded` short-circuit on
      // its lazy loader, so we have to call the explicit reload here.
      await Promise.all([
        refresh(),
        useExtensionStore.getState().reloadCatalog(token),
      ]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Install failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  // Update path: install endpoint already wipes + re-extracts the
  // bundle directory on every call (admin_extensions.py overwrites
  // dest), so a "Update" button just hits the same install endpoint
  // — no separate API needed. We keep a distinct toast message and
  // busyId animation so the user knows their click did something
  // meaningfully different from a no-op.
  const handleUpdate = async (id: string, fromVersion: string, toVersion: string) => {
    if (!token) return;
    setBusyId(id);
    try {
      await adminInstallExtension(id, token);
      addToast(
        fromVersion
          ? `Updated ${id} ${fromVersion} → ${toVersion}`
          : `Updated ${id} to v${toVersion}`,
        "success",
      );
      await Promise.all([
        refresh(),
        useExtensionStore.getState().reloadCatalog(token),
      ]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (id: string) => {
    if (!token) return;
    setBusyId(id);
    try {
      await adminUninstallExtension(id, token);
      addToast(`Uninstalled ${id}`, "success");
      await Promise.all([
        refresh(),
        useExtensionStore.getState().reloadCatalog(token),
      ]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Uninstall failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  // Modal mode wraps everything in a scroll container so the inner
  // list can grow without pushing the close button off-screen.
  const containerClass = mode === "modal" ? "space-y-4 px-1" : "space-y-4";

  return (
    <div className={containerClass}>
      <div>
        <h4 className="text-sm font-semibold text-on-surface mb-1">Extension Catalog</h4>
        <p className="text-xs text-on-surface-variant">
          Extensions published in the concord-extensions library. Installing extracts the
          bundle into this instance's data volume and makes it available to every user via the
          Extensions menu.
        </p>
        {catalog && (
          <p className="text-[11px] text-on-surface-variant/60 mt-1 font-mono break-all">
            source: {catalog.catalog_url}
          </p>
        )}
      </div>

      {loading && <p className="text-sm text-on-surface-variant">Loading catalog…</p>}
      {error && (
        <div className="p-3 rounded border border-error/40 bg-error/10 text-sm text-error">
          {error}
          <button
            onClick={() => void refresh()}
            className="ml-3 underline"
          >
            Retry
          </button>
        </div>
      )}

      {catalog && catalog.catalog.extensions.length === 0 && (
        <p className="text-sm text-on-surface-variant">Catalog is empty.</p>
      )}

      {catalog && catalog.catalog.extensions.length > 0 && (
        <ul className="space-y-2">
          {catalog.catalog.extensions.map((ext) => {
            const isInstalled = catalog.installed_ids.includes(ext.id);
            // Installed version comparison. `installed_versions` is
            // optional for back-compat — if the server didn't ship the
            // field, we fall back to "no update UI". An empty string
            // means a legacy install predating the version field — we
            // treat that as "unknown, offer update" so the user has a
            // path forward without uninstall/reinstall.
            const installedVersion = catalog.installed_versions?.[ext.id];
            const updateAvailable =
              isInstalled &&
              installedVersion !== undefined &&
              installedVersion !== ext.version;
            const isBusy = busyId === ext.id;
            return (
              <li
                key={ext.id}
                data-testid={`ext-row-${ext.id}`}
                className="bg-surface-container rounded-lg p-3 border border-outline-variant/15"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-on-surface-variant">extension</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-on-surface">{ext.name}</p>
                      <span className="text-[10px] uppercase tracking-wider text-on-surface-variant font-label">
                        v{ext.version}
                      </span>
                      {isInstalled && !updateAvailable && (
                        <span className="text-[10px] uppercase tracking-wider text-primary font-label">
                          installed
                        </span>
                      )}
                      {updateAvailable && (
                        <span className="text-[10px] uppercase tracking-wider text-tertiary font-label">
                          {installedVersion
                            ? `update: v${installedVersion} → v${ext.version}`
                            : `update available`}
                        </span>
                      )}
                      {ext.pricing && ext.pricing !== "free" && (
                        <span className="text-[10px] uppercase tracking-wider text-on-surface-variant/80 font-label">
                          {ext.pricing.replace("_", " ")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-on-surface-variant mt-1 break-words">
                      {ext.description}
                    </p>
                    <p className="text-[11px] text-on-surface-variant/60 mt-1 font-mono">{ext.id}</p>
                  </div>
                  <div className="flex-shrink-0 flex flex-col gap-1.5 items-end">
                    {!isInstalled && (
                      <button
                        onClick={() => void handleInstall(ext.id)}
                        disabled={isBusy}
                        data-testid={`ext-install-${ext.id}`}
                        className="px-3 py-1.5 text-xs rounded primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface transition-colors"
                      >
                        {isBusy ? "…" : "Install"}
                      </button>
                    )}
                    {updateAvailable && (
                      <button
                        onClick={() =>
                          void handleUpdate(ext.id, installedVersion ?? "", ext.version)
                        }
                        disabled={isBusy}
                        className="px-3 py-1.5 text-xs rounded bg-tertiary/25 hover:bg-tertiary/35 disabled:opacity-40 text-tertiary transition-colors"
                      >
                        {isBusy ? "…" : "Update"}
                      </button>
                    )}
                    {isInstalled && (
                      <button
                        onClick={() => void handleUninstall(ext.id)}
                        disabled={isBusy}
                        data-testid={`ext-uninstall-${ext.id}`}
                        className="px-2.5 py-1 text-[11px] rounded bg-error/15 hover:bg-error/25 disabled:opacity-40 text-error transition-colors"
                      >
                        {isBusy ? "…" : "Uninstall"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
