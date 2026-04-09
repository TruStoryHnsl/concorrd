import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import { listExploreServers } from "../../api/concord";
import type { ExploreServerEntry } from "../../api/concord";

interface Props {
  /**
   * Controls visibility. When false, the modal renders nothing.
   * Kept as an explicit prop (rather than relying on parent-side
   * conditional rendering) so the component can manage its own
   * fetch lifecycle via a `useEffect` keyed on `isOpen`.
   */
  isOpen: boolean;
  onClose: () => void;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; entries: ExploreServerEntry[] }
  | { status: "error"; message: string };

export function ExploreModal({ isOpen, onClose }: Props) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  // Close on Escape — mirrors the convention used by NewServerModal /
  // InviteModal so keyboard behavior stays consistent across the app.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const load = useCallback(async () => {
    if (!accessToken) {
      setState({ status: "error", message: "Not signed in" });
      return;
    }
    setState({ status: "loading" });
    try {
      const entries = await listExploreServers(accessToken);
      setState({ status: "success", entries });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load federated servers";
      setState({ status: "error", message });
      addToast(message, "error");
    }
  }, [accessToken, addToast]);

  // Refetch every time the modal opens. The list is small and
  // federation allowlists change rarely, so a fresh fetch per open
  // is the simplest correct behavior.
  useEffect(() => {
    if (isOpen) {
      load();
    } else {
      setState({ status: "idle" });
    }
  }, [isOpen, load]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="explore-modal-title"
    >
      <div className="bg-surface-container rounded-lg w-full max-w-md border border-outline-variant/15 shadow-xl">
        <div className="p-4 border-b border-outline-variant/15 flex items-center justify-between">
          <h2
            id="explore-modal-title"
            className="text-lg font-semibold text-on-surface"
          >
            Explore Federated Servers
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-4">
          <ExploreBody state={state} onRetry={load} />
        </div>

        <div className="px-4 pb-4">
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ExploreBody({
  state,
  onRetry,
}: {
  state: LoadState;
  onRetry: () => void;
}) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <p
        className="text-on-surface-variant text-sm text-center py-8"
        role="status"
      >
        Loading…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-3 py-4 text-center">
        <p className="text-sm text-on-surface-variant">
          Couldn&apos;t load federated servers.
        </p>
        <p className="text-xs text-on-surface-variant/70 break-words">
          {state.message}
        </p>
        <button
          onClick={onRetry}
          className="text-xs px-3 py-1.5 primary-glow hover:brightness-110 text-on-surface rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.entries.length === 0) {
    return (
      <p className="text-on-surface-variant text-sm text-center py-8">
        No federated servers yet.
      </p>
    );
  }

  return (
    <ul className="max-h-72 overflow-y-auto space-y-1">
      {state.entries.map((entry) => (
        <li
          key={entry.domain}
          className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-surface-container-low hover:bg-surface-container-high transition-colors"
        >
          <div className="min-w-0">
            <p className="text-sm text-on-surface truncate">{entry.name}</p>
            {entry.name !== entry.domain && (
              <p className="text-xs text-on-surface-variant truncate">
                {entry.domain}
              </p>
            )}
            {entry.description && (
              <p className="text-xs text-on-surface-variant/80 truncate">
                {entry.description}
              </p>
            )}
          </div>
          <button
            type="button"
            // TODO: wire to public rooms browser
            onClick={() => {
              /* no-op placeholder — public rooms browser lands in a later slice */
            }}
            className="text-xs px-3 py-1 bg-surface-container-highest text-on-surface-variant hover:text-on-surface rounded transition-colors flex-shrink-0"
          >
            Browse public rooms
          </button>
        </li>
      ))}
    </ul>
  );
}
