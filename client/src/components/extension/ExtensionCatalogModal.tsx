/**
 * INS-070 — Extension Library modal.
 *
 * Surfaced from the Tools dropdown ("Extension Library" entry) so
 * admins can install/uninstall extensions in one click instead of
 * digging through Settings → Admin → Extensions.
 *
 * Shape: full-page overlay similar to `SourceServerBrowser` — a
 * centred glass-panel card with a close button + escape-to-close,
 * filling up to 85vh and scrolling the inner panel when needed.
 *
 * Body delegates to {@link ExtensionLibraryPanel} so the install
 * logic stays in one place between the modal and the AdminTab
 * settings tab.
 */

import { useEffect } from "react";
import { useAuthStore } from "../../stores/auth";
import { ExtensionLibraryPanel } from "./ExtensionLibraryPanel";

export function ExtensionCatalogModal({ onClose }: { onClose: () => void }) {
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-testid="extension-catalog-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Extension Library"
    >
      <div className="w-full max-w-2xl mx-4 bg-surface-container rounded-2xl border border-outline-variant/20 shadow-2xl p-6 max-h-[85vh] flex flex-col">
        <div className="flex items-center gap-3 mb-4 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant">library_books</span>
          </div>
          <h2 className="flex-1 text-lg font-headline font-semibold text-on-surface">
            Extension Library
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            data-testid="extension-catalog-modal-close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
          <ExtensionLibraryPanel mode="modal" token={accessToken} />
        </div>
      </div>
    </div>
  );
}
