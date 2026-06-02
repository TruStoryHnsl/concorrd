import { useEffect, useMemo, useRef, useState } from "react";
import { useServerConfigStore } from "../../stores/serverConfig";
import type { HostingStatus } from "../settings/HostingTab";

/** Pill showing which Concord instance the user is currently connected to. */
export function ConnectedHostLabel({ compact = false }: { compact?: boolean }) {
  const config = useServerConfigStore((s) => s.config);

  const display = useMemo(() => {
    if (config) {
      return config.instance_name || config.host;
    }
    if (typeof window !== "undefined") {
      return window.location.hostname || "web";
    }
    return "web";
  }, [config]);

  // On compact mode (mobile ≤360px), trim to the first dot so long
  // domains don't crowd the top bar.
  const shown = compact ? display.split(".")[0] : display;

  return (
    <span
      className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high/60 text-[10px] font-label font-medium text-on-surface-variant max-w-[140px] truncate"
      title={`Connected to ${display}`}
      aria-label={`Connected to ${display}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-secondary flex-shrink-0"
        aria-hidden="true"
      />
      <span className="truncate">{shown}</span>
    </span>
  );
}

/** Shared 44×44 round icon button for the top bar. Matches the account-icon
 *  footprint so the row stays visually balanced across viewports. */
export function TopBarIconButton({
  icon,
  label,
  onClick,
  ref,
  className = "",
}: {
  icon: string;
  label: string;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`btn-press flex items-center justify-center w-11 h-11 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0 ${className}`}
    >
      <span className="material-symbols-outlined text-xl">{icon}</span>
    </button>
  );
}

/** Colored-dot button indicating the embedded servitude lifecycle.
 *  Green = running, Orange = stopped/not configured, Red = error. */
export function HostingStatusButton({
  status,
  onClick,
}: {
  status: HostingStatus;
  onClick: () => void;
}) {
  const dotColor =
    status === "running" ? "bg-green-500" :
    status === "error" ? "bg-red-500" :
    status === "loading" ? "bg-outline-variant/40 animate-pulse" :
    "bg-orange-400";
  const label =
    status === "running" ? "Hosting active" :
    status === "error" ? "Hosting error" :
    "Hosting offline";
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="btn-press flex items-center justify-center w-11 h-11 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
    >
      <div className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
    </button>
  );
}

/** Single row inside the TopBarMoreMenu dropdown. */
export function OverflowMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 min-h-[44px] text-sm font-label text-on-surface hover:bg-surface-container-high transition-colors text-left"
    >
      <span className="material-symbols-outlined text-lg text-on-surface-variant">{icon}</span>
      {label}
    </button>
  );
}

/** Wrench button + dropdown containing every secondary top-bar action.
 *  Replaces the prior per-button row at small viewports. */
export function TopBarMoreMenu({
  voiceMicActive,
  showExtension,
  onExtension,
  onHelp,
  onStats,
  onBug,
  onSettings,
  onExtensionLibrary,
}: {
  voiceMicActive?: boolean;
  showExtension?: boolean;
  onExtension?: () => void;
  onHelp: () => void;
  onStats: () => void;
  onBug: () => void;
  onSettings: () => void;
  /** INS-070 — admin-only Extension Library entry. */
  onExtensionLibrary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handle = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Menu"
        className="btn-press flex items-center justify-center w-11 h-11 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
      >
        <span className="material-symbols-outlined text-xl">handyman</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-40 min-w-[200px] glass-panel rounded-xl py-1 animate-[fadeSlideUp_0.15s_ease-out] shadow-2xl"
        >
          <div className="px-3 py-2 flex items-center gap-2 border-b border-outline-variant/10">
            {voiceMicActive && (
              <div
                className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0"
                title="Microphone active"
              />
            )}
            <ConnectedHostLabel />
          </div>
          {showExtension && onExtension && (
            <OverflowMenuItem
              icon="extension"
              label="Room Extensions"
              onClick={handle(onExtension)}
            />
          )}
          {onExtensionLibrary && (
            <OverflowMenuItem
              icon="library_books"
              label="Extension Library"
              onClick={handle(onExtensionLibrary)}
            />
          )}
          <OverflowMenuItem icon="help" label="Help" onClick={handle(onHelp)} />
          <OverflowMenuItem icon="bar_chart" label="Your stats" onClick={handle(onStats)} />
          <OverflowMenuItem icon="bug_report" label="Report a bug" onClick={handle(onBug)} />
          <div className="mx-3 my-1 border-t border-outline-variant/15" />
          {/* Outer Tools/wrench button keeps `handyman`; inner Settings row uses
           *  the universal gear glyph — `handyman` inside `handyman` was visually
           *  confusing ("tools inside tools"). */}
          <OverflowMenuItem
            icon="settings"
            label="Settings"
            onClick={handle(onSettings)}
          />
        </div>
      )}
    </div>
  );
}
