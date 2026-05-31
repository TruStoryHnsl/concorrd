/**
 * TauriTitlebar — replacement chrome for the native window.
 *
 * `tauri.conf.json` ships with `decorations: false`, which removes the
 * OS-provided title bar + window controls. That choice plays nicely
 * with users (e.g. corr) who run their compositor with system
 * decorations off, but it leaves a window the user can't drag or
 * close from inside the app. This component fills that gap with a
 * tiny in-app strip:
 *
 *   - The whole strip is `data-tauri-drag-region` so any pixel can
 *     start a window drag.
 *   - A small close button hits `getCurrentWindow().close()`.
 *   - Hidden on the web build (Tauri runtime detector returns false).
 *
 * Keep it small — anything richer (minimize / maximize affordances,
 * window menu) lands as a follow-up if users ask. The MVP just makes
 * sure "no decorations on the OS side" doesn't translate to "no way
 * to close the window".
 */

import { useEffect, useState } from "react";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function TauriTitlebar() {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(isTauri());
  }, []);

  if (!supported) return null;

  const handleClose = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err) {
      console.warn("[titlebar] close failed", err);
    }
  };

  return (
    <div
      data-tauri-drag-region
      data-testid="tauri-titlebar"
      className="fixed top-0 left-0 right-0 z-[60] h-8 flex items-center \
                 justify-end gap-1 px-2 select-none bg-surface \
                 border-b border-outline-variant/15"
    >
      <span
        data-tauri-drag-region
        className="flex-1 text-xs font-medium text-on-surface-variant"
      >
        Concord
      </span>
      <button
        type="button"
        aria-label="Close window"
        onClick={handleClose}
        className="w-6 h-6 flex items-center justify-center rounded \
                   text-on-surface-variant hover:bg-error/90 hover:text-on-error \
                   transition-colors"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M2 2 L10 10 M10 2 L2 10" />
        </svg>
      </button>
    </div>
  );
}
