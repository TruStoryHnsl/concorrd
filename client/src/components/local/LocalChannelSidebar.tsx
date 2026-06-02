/**
 * LocalChannelSidebar — channel column for the active LOCAL server
 * (porch OR home, see the 2026-06-01 CONSOLIDATED ARCHITECTURE filing
 * in `instructions_inbox.md`).
 *
 * Today both tiles read their channels from the existing `porchStore`
 * (which is backed by the persistent porch SQLite). That's correct
 * for the HOME server — the porch SQLite is being repurposed as the
 * home's backing store; rename of the porch module / file is a
 * follow-up PR. The PORCH server's ephemeral in-memory channel set
 * lands in F1a (parallel PR); until then the porch tile shows the
 * same list (still useful — the porch tile changing the header
 * label confirms the routing works end-to-end).
 *
 * The server-name header reflects the currently-active local server:
 *   - `active === "home"` → `useHomeServerNameStore.name` (default "home")
 *   - `active === "porch"` → literal "porch" (porch is not renamable)
 */

import { memo, useEffect } from "react";
import { usePorchStore } from "../../stores/porchStore";
import { useHomeServerNameStore } from "../../stores/homeServerName";
import { useLocalServerSelectionStore } from "../../stores/localServerSelection";
import { isTauri } from "../../api/servitude";
import { BringingUpSplash } from "../BringingUpSplash";

interface LocalChannelSidebarProps {
  mobile?: boolean;
  onChannelSelect?: () => void;
}

export const LocalChannelSidebar = memo(function LocalChannelSidebar({
  mobile: _mobile,
  onChannelSelect,
}: LocalChannelSidebarProps) {
  // NOTE: `porchStore` is the persistent home-server's backing store
  // today — the variable name is keep-as-is because the module
  // rename is a follow-up PR.
  const channels = usePorchStore((s) => s.channels);
  const selectedChannelId = usePorchStore((s) => s.selectedChannelId);
  const isLoaded = usePorchStore((s) => s.isLoaded);
  const error = usePorchStore((s) => s.error);
  const loadChannels = usePorchStore((s) => s.loadChannels);
  const selectChannel = usePorchStore((s) => s.selectChannel);

  const active = useLocalServerSelectionStore((s) => s.active);
  const homeName = useHomeServerNameStore((s) => s.name);

  // Lazy-load on mount. `loadChannels` is idempotent — re-calling it
  // refreshes the list without resetting the selection.
  useEffect(() => {
    if (!isLoaded) {
      void loadChannels();
    }
  }, [isLoaded, loadChannels]);

  const serverLabel =
    active === "home" ? homeName.trim() || "home" : "porch";

  // Loading status string matches the active server so the user
  // sees consistent vocabulary in BringingUpSplash.
  const loadingStatus =
    active === "home" ? "Loading home…" : "Loading porch…";

  return (
    <div className="w-full h-full flex flex-col min-h-0 bg-surface-container-low">
      {/* Server header — mirrors ChannelSidebar's `p-3 flex items-center
          justify-between` row. Settings/invite affordances are intentionally
          omitted in this PR; per-channel admin lives in the per-feature
          surfaces under client/src/components/porch/. */}
      <div className="p-3 flex items-center justify-between relative">
        <span
          data-testid="local-channel-sidebar-server-header"
          data-server-key={active}
          className="min-w-0 text-left text-sm font-headline font-semibold text-on-surface truncate"
          title={serverLabel}
        >
          {serverLabel}
        </span>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto p-2">
        {!isTauri() ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm text-on-surface-variant font-body">
              This device is in web mode
            </p>
            <p className="mt-2 text-xs text-on-surface-variant/60 font-label">
              The local {serverLabel} server lives on your desktop install.
            </p>
          </div>
        ) : !isLoaded ? (
          <div className="flex justify-center py-6">
            <BringingUpSplash size="compact" status={loadingStatus} />
          </div>
        ) : error && error !== "native_only" ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm text-error font-body">{error}</p>
            <button
              type="button"
              onClick={() => void loadChannels()}
              className="mt-3 px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-xs text-on-surface-variant hover:text-on-surface transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="mb-3">
            <div className="flex items-center justify-between px-2 mb-1">
              <h3 className="text-[10px] font-label font-medium text-on-surface-variant uppercase tracking-widest">
                Text Channels
              </h3>
            </div>
            {channels.map((ch) => {
              const isActive = selectedChannelId === ch.id;
              return (
                <div key={ch.id} className="group flex items-center gap-0.5">
                  <button
                    type="button"
                    data-testid={`local-channel-row-${ch.id}`}
                    onClick={() => {
                      void selectChannel(ch.id);
                      onChannelSelect?.();
                    }}
                    className={`flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm transition-all flex items-center gap-2 font-body ${
                      isActive
                        ? "bg-surface-container-highest text-on-surface"
                        : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                    }`}
                  >
                    <span className="text-on-surface-variant flex-shrink-0">#</span>
                    <span className="min-w-0 truncate flex-1">{ch.name}</span>
                  </button>
                </div>
              );
            })}
            {channels.length === 0 && (
              <p className="px-3 py-4 text-xs text-on-surface-variant/70 font-label text-center">
                No channels yet
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
