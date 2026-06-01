/**
 * LocalChannelSidebar — channel column for the active local porch.
 *
 * Visual contract: identical to ChannelSidebar's text-channel section —
 * server-name header at the top, a `Text Channels` group beneath, one
 * row per channel styled with the same Tailwind classes that
 * ChannelSidebar uses for a Matrix text channel. The data backing each
 * row comes from `usePorchStore` instead of `useServerStore`, but the
 * pixels are the same.
 *
 * The Phase A porch backend already auto-seeds a default channel on
 * first open (see `src-tauri/src/porch/db.rs::Porch::open`), so the
 * list is never empty when running natively. On the web build, the
 * porch is unreachable — we render a small "desktop-only" hint
 * instead of an empty list.
 */

import { memo, useEffect } from "react";
import { usePorchStore } from "../../stores/porchStore";
import { useInstanceNameStore } from "../../stores/instanceName";
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
  const channels = usePorchStore((s) => s.channels);
  const selectedChannelId = usePorchStore((s) => s.selectedChannelId);
  const isLoaded = usePorchStore((s) => s.isLoaded);
  const error = usePorchStore((s) => s.error);
  const loadChannels = usePorchStore((s) => s.loadChannels);
  const selectChannel = usePorchStore((s) => s.selectChannel);

  // Lazy-load on mount. `loadChannels` is idempotent — re-calling it
  // refreshes the list without resetting the selection.
  useEffect(() => {
    if (!isLoaded) {
      void loadChannels();
    }
  }, [isLoaded, loadChannels]);

  const instanceName = useInstanceNameStore((s) => s.name);
  const porchLabel = instanceName.trim() || "porch";

  return (
    <div className="w-full h-full flex flex-col min-h-0 bg-surface-container-low">
      {/* Server header — mirrors ChannelSidebar's `p-3 flex items-center
          justify-between` row. Settings/invite affordances are intentionally
          omitted in Phase A; per-channel admin lives in the per-feature
          surfaces under client/src/components/porch/. */}
      <div className="p-3 flex items-center justify-between relative">
        <span
          data-testid="local-channel-sidebar-server-header"
          className="min-w-0 text-left text-sm font-headline font-semibold text-on-surface truncate"
          title={porchLabel}
        >
          {porchLabel}
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
              The local porch lives on your desktop install.
            </p>
          </div>
        ) : !isLoaded ? (
          <div className="flex justify-center py-6">
            <BringingUpSplash size="compact" status="Loading porch…" />
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
