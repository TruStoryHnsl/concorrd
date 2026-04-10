interface ExtensionEmbedProps {
  url: string;
  extensionName: string;
  hostUserId: string;
  isHost: boolean;
  onStop: () => void;
}

/** Shortens a Matrix user ID to just the localpart (e.g. "@corr:server" → "corr"). */
function displayName(userId: string): string {
  return userId.split(":")[0].replace("@", "");
}

export default function ExtensionEmbed({
  url,
  extensionName,
  hostUserId,
  isHost,
  onStop,
}: ExtensionEmbedProps) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      {/* Header bar */}
      <div className="h-10 flex items-center justify-between px-3 bg-surface-container-low border-b border-outline-variant/20 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-base text-primary">
            extension
          </span>
          <span className="text-sm font-headline font-semibold truncate text-on-surface">
            {extensionName}
          </span>
          <span className="text-xs text-on-surface-variant font-label truncate">
            hosted by {displayName(hostUserId)}
          </span>
        </div>
        {isHost && (
          <button
            onClick={onStop}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-label text-error hover:bg-error/10 transition-colors flex-shrink-0"
          >
            <span className="material-symbols-outlined text-sm">stop</span>
            Stop
          </button>
        )}
      </div>

      {/* Sandboxed iframe */}
      <iframe
        src={url}
        sandbox="allow-scripts allow-same-origin"
        className="flex-1 w-full border-0 min-h-0"
        title={extensionName}
      />
    </div>
  );
}
