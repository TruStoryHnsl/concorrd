import { useAuthStore } from "../../stores/auth";
import { useSettingsStore } from "../../stores/settings";
import { useSourcesStore } from "../../stores/sources";
import { SourceBrandIcon } from "../sources/sourceBrand";

/**
 * Per-user Connections tab.
 *
 * Each connection is personal to the caller; tiles deep-link into the
 * AddSource modal via requestAddSource.
 */
export function UserConnectionsTab() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const requestAddSource = useSettingsStore((s) => s.requestAddSource);
  const sources = useSourcesStore((s) => s.sources);

  if (!accessToken) {
    return (
      <div className="space-y-4" data-testid="user-connections-tab">
        <h3 className="text-xl font-semibold text-on-surface">Connections</h3>
        <p className="text-sm text-on-surface-variant">
          Sign in to manage your connected accounts.
        </p>
      </div>
    );
  }

  const concordCount = sources.filter((s) => s.platform === "concord").length;
  const matrixCount = sources.filter((s) => s.platform === "matrix").length;

  return (
    <div className="space-y-6" data-testid="user-connections-tab">
      <div>
        <h3 className="text-xl font-semibold text-on-surface">Connections</h3>
        <p className="text-sm text-on-surface-variant mt-1">
          Link external instances to Concord. Each connection is personal
          to you — other users and admins can't see or act on your connections.
        </p>
      </div>

      <ConnectionCard
        brand="concord"
        title="Concord Instance"
        subtitle="Connect to another Concord domain with an invite token"
        action={concordCount === 0 ? "Connect" : "Add another"}
        onAction={() => requestAddSource("concord")}
        count={concordCount}
      />

      <ConnectionCard
        brand="matrix"
        title="matrix.org"
        subtitle="Discover public rooms with Matrix login flows"
        action={matrixCount === 0 ? "Connect" : "Add another"}
        onAction={() => requestAddSource("matrix.org")}
      />
      <ConnectionCard
        brand="mozilla"
        title="Mozilla"
        subtitle="Use Mozilla's delegated Matrix login"
        action="Connect"
        onAction={() => requestAddSource("chat.mozilla.org")}
      />
      <ConnectionCard
        brand="matrix"
        title="Custom Matrix Homeserver"
        subtitle="Enter any Matrix domain manually"
        action="Connect"
        onAction={() => requestAddSource("matrix")}
        count={matrixCount > 0 ? matrixCount : undefined}
      />

      <ConnectionCard
        brand="slack"
        title="Slack"
        subtitle="Preloaded release target"
        action="Soon"
        disabled
      />
      <ConnectionCard
        brand="reticulum"
        title="Reticulum"
        subtitle="Preloaded release target"
        action="Soon"
        disabled
      />
    </div>
  );
}

function ConnectionCard({
  brand,
  title,
  subtitle,
  action,
  onAction,
  disabled,
  count,
}: {
  brand: "concord" | "matrix" | "mozilla" | "slack" | "reticulum";
  title: string;
  subtitle: string;
  action: string;
  onAction?: () => void;
  disabled?: boolean;
  count?: number;
}) {
  const brandedIcon =
    brand === "concord" || brand === "matrix" || brand === "mozilla"
      ? <SourceBrandIcon brand={brand} size={24} />
      : <span className="material-symbols-outlined text-on-surface-variant">
          {brand === "slack" ? "forum" : "sensors"}
        </span>;

  return (
    <div className="border border-outline-variant/20 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-low/60">
        <div className="w-8 h-8 rounded-lg bg-surface-container-high ring-1 ring-outline-variant/15 flex items-center justify-center flex-shrink-0">
          {brandedIcon}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-on-surface">
            {title}
            {count !== undefined && count > 0 && (
              <span className="ml-2 text-xs text-on-surface-variant">
                · {count} connected
              </span>
            )}
          </h4>
          <p className="text-xs text-on-surface-variant">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          data-testid={`connection-action-${brand}`}
          className={
            disabled
              ? "px-3 py-1.5 bg-surface-container/40 text-on-surface-variant/60 text-xs rounded-md min-h-[32px] cursor-not-allowed"
              : "px-3 py-1.5 bg-primary/10 hover:bg-primary/15 text-primary text-xs rounded-md transition-colors min-h-[32px]"
          }
        >
          {action}
        </button>
      </div>
    </div>
  );
}
