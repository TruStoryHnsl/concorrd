/**
 * SourceContextMenu — right-click affordances on a Source tile.
 *
 * Three actions today:
 *   1. **Open** — opens the source's content panel (same as left-click).
 *   2. **Settings** — opens the per-source / per-server settings tab.
 *      Concord sources route into `openServerSettings`; Matrix sources
 *      fall through to the connection settings on the Connections tab.
 *   3. **Close connection** — destructive. Severs the source at the root
 *      via `removeSource`, dropping the tile and any in-memory state
 *      tied to it. We render a small confirm step inline (no separate
 *      dialog) because the destruction is local-only — there's nothing
 *      to roll back beyond re-adding the source manually.
 *
 * Positioning: the menu floats at the mouse cursor where the
 * `contextmenu` event fired. The host computes the (x, y) coordinates
 * from the event and passes them here; we clip to the viewport so the
 * menu can never render off-screen.
 *
 * Dismiss: click-outside, Escape, or pick an action. The host owns the
 * `open` state and clears it on `onClose`.
 */

import { useEffect, useRef, useState } from "react";
import type { ConcordSource } from "../../stores/sources";

interface SourceContextMenuProps {
  source: ConcordSource;
  /** Viewport-relative cursor position where the menu should anchor. */
  x: number;
  y: number;
  onClose: () => void;
  onOpen: (sourceId: string) => void;
  onOpenSettings: (sourceId: string) => void;
  onCloseConnection: (sourceId: string) => void;
}

export function SourceContextMenu({
  source,
  x,
  y,
  onClose,
  onOpen,
  onOpenSettings,
  onCloseConnection,
}: SourceContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  // Clip to viewport so the menu can't render off-screen on a click
  // near the right or bottom edge.
  const [position, setPosition] = useState({ x, y });
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    const clampedX = Math.min(x, Math.max(0, innerWidth - rect.width - 4));
    const clampedY = Math.min(y, Math.max(0, innerHeight - rect.height - 4));
    setPosition({ x: clampedX, y: clampedY });
  }, [x, y]);

  // Click-outside + Escape close.
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      const el = menuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const sourceLabel = source.instanceName || source.host || source.id;

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid={`source-context-menu-${source.id}`}
      style={{
        position: "fixed",
        top: position.y,
        left: position.x,
        zIndex: 50,
      }}
      className="min-w-[200px] bg-surface-container border border-outline-variant/20 rounded-md shadow-xl py-1 select-none"
    >
      <div
        className="px-3 py-1.5 text-xs font-medium text-on-surface-variant truncate"
        title={sourceLabel}
      >
        {sourceLabel}
      </div>
      <div className="h-px bg-outline-variant/15" />

      <MenuItem
        label="Open"
        onClick={() => {
          onOpen(source.id);
          onClose();
        }}
      />

      <MenuItem
        label="Settings"
        onClick={() => {
          onOpenSettings(source.id);
          onClose();
        }}
      />

      <div className="h-px bg-outline-variant/15 my-1" />

      {confirmClose ? (
        <div className="px-3 py-2 space-y-2">
          <p className="text-xs text-on-surface-variant">
            Sever the connection and delete data from {sourceLabel}?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              className="px-2 py-1 text-xs rounded text-on-surface-variant hover:bg-surface-container-high"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onCloseConnection(source.id);
                onClose();
              }}
              data-testid={`source-context-confirm-close-${source.id}`}
              className="px-2 py-1 text-xs rounded bg-error/90 hover:bg-error text-on-error"
            >
              Sever
            </button>
          </div>
        </div>
      ) : (
        <MenuItem
          label="Close connection"
          destructive
          onClick={() => setConfirmClose(true)}
          testId={`source-context-close-${source.id}`}
        />
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  destructive = false,
  testId,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      data-testid={testId}
      className={
        "w-full text-left px-3 py-1.5 text-sm transition-colors " +
        (destructive
          ? "text-error hover:bg-error/10"
          : "text-on-surface hover:bg-surface-container-high")
      }
    >
      {label}
    </button>
  );
}
