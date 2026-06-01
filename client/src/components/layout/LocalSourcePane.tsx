/**
 * Local-source main pane.
 *
 * When the user clicks the intrinsic "local" tile in SourcesPanel,
 * ChatLayout flips `localActive` to true and renders this pane in
 * place of its Matrix-aware panes. The pane uses the same visual
 * primitives ChatLayout uses for every other source (channel sidebar
 * left, message pane right, send-input bottom) — so visiting your
 * own porch looks identical to visiting any Matrix / Concord /
 * Discord server. The data flows differently: porch rows come from
 * `usePorchStore` via the porch_* Tauri commands, NOT from
 * matrix-js-sdk.
 *
 * Behavior:
 *   - On mount, kicks `loadChannels()` (idempotent — no-op if loaded).
 *   - Sidebar lists every porch channel; clicking selects it.
 *   - Right pane renders the selected channel's messages and a
 *     send-input at the bottom. Empty channel → "Send the first
 *     message" placeholder.
 *   - "Back" button in the header returns control to the parent
 *     by invoking `onClose`, which clears `localActive` in
 *     ChatLayout.
 *
 * Web build: porchStore short-circuits (`error: "native_only"`).
 * In that case the pane shows a "porch is desktop-only" message
 * rather than crashing the renderer.
 */

import { useEffect, useState } from "react";
import { usePorchStore } from "../../stores/porchStore";
import { useInstanceNameStore } from "../../stores/instanceName";
import { isTauri } from "../../api/servitude";
import { BringingUpSplash } from "../BringingUpSplash";

interface LocalSourcePaneProps {
  onClose: () => void;
}

export function LocalSourcePane({ onClose }: LocalSourcePaneProps) {
  const channels = usePorchStore((s) => s.channels);
  const selectedChannelId = usePorchStore((s) => s.selectedChannelId);
  const messages = usePorchStore((s) => s.messages);
  const isLoaded = usePorchStore((s) => s.isLoaded);
  const isLoading = usePorchStore((s) => s.isLoading);
  const error = usePorchStore((s) => s.error);
  const loadChannels = usePorchStore((s) => s.loadChannels);
  const selectChannel = usePorchStore((s) => s.selectChannel);
  const sendMessage = usePorchStore((s) => s.sendMessage);
  const instanceName = useInstanceNameStore((s) => s.name);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const label = instanceName.trim() || "local";

  let body: React.ReactNode;
  if (!isTauri()) {
    body = (
      <div className="flex-1 flex items-center justify-center p-8 text-on-surface-variant text-sm text-center">
        The porch lives on the native client. Open Concord on your
        desktop or phone to see your local instance here.
      </div>
    );
  } else if (!isLoaded && isLoading) {
    body = (
      <div className="flex-1">
        <BringingUpSplash size="compact" status="Loading your porch…" />
      </div>
    );
  } else if (error && error !== "native_only") {
    body = (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-on-surface-variant text-sm">
        <p>Couldn't load your porch.</p>
        <pre className="text-xs text-error max-w-md overflow-auto whitespace-pre-wrap">
          {error}
        </pre>
        <button
          type="button"
          onClick={() => void loadChannels()}
          className="px-3 py-1.5 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/15"
        >
          Retry
        </button>
      </div>
    );
  } else {
    body = (
      <div className="flex-1 min-h-0 flex">
        <ChannelList
          channels={channels}
          selectedChannelId={selectedChannelId}
          onSelect={(id) => void selectChannel(id)}
        />
        <MessagePane
          messages={messages}
          isLoading={isLoading}
          isReady={selectedChannelId !== null}
          onSend={(body) => void sendMessage(body)}
        />
      </div>
    );
  }

  // Full-bleed overlay inside ChatLayout's React tree (not a separate
  // window). Sits above the Matrix-aware panes when localActive is
  // true; backs out via the in-header arrow.
  return (
    <div
      data-testid="local-source-pane"
      className="fixed inset-0 z-40 bg-surface flex flex-col"
    >
      <Header label={label} onClose={onClose} />
      {body}
    </div>
  );
}

function Header({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="h-12 flex items-center px-3 gap-2 bg-surface-container-low border-b border-outline-variant/15 flex-shrink-0">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close local instance"
        data-testid="local-source-pane-close"
        className="btn-press flex items-center justify-center w-9 h-9 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors flex-shrink-0"
      >
        <span className="material-symbols-outlined text-xl">arrow_back</span>
      </button>
      <span className="material-symbols-outlined text-on-surface-variant text-lg">
        home
      </span>
      <h2 className="font-headline font-semibold text-on-surface">
        {label}
      </h2>
      <span
        className="text-xs text-on-surface-variant/60"
        title="This is THIS device's hosted porch"
      >
        · your device
      </span>
    </div>
  );
}

function ChannelList({
  channels,
  selectedChannelId,
  onSelect,
}: {
  channels: import("../../api/porch").PorchChannel[];
  selectedChannelId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      data-testid="local-source-pane-channels"
      className="w-56 flex-shrink-0 border-r border-outline-variant/15 bg-surface-container-low/40 flex flex-col overflow-y-auto"
    >
      <div className="px-3 pt-3 pb-1 text-[0.7rem] uppercase tracking-wider text-on-surface-variant/70 font-semibold">
        Channels
      </div>
      {channels.length === 0 ? (
        <p className="px-3 py-2 text-xs text-on-surface-variant">
          No channels yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {channels.map((ch) => {
            const isActive = ch.id === selectedChannelId;
            return (
              <li key={ch.id}>
                <button
                  type="button"
                  onClick={() => onSelect(ch.id)}
                  data-testid={`local-channel-${ch.id}`}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                    isActive
                      ? "bg-primary/15 text-on-surface"
                      : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                  }`}
                >
                  <span className="material-symbols-outlined text-base opacity-70">
                    {ch.kind === "obsidian" ? "menu_book" : "tag"}
                  </span>
                  <span className="truncate">{ch.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function MessagePane({
  messages,
  isLoading,
  isReady,
  onSend,
}: {
  messages: import("../../api/porch").ChannelMessage[];
  isLoading: boolean;
  isReady: boolean;
  onSend: (body: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft("");
  };

  return (
    <section
      data-testid="local-source-pane-messages"
      className="flex-1 min-w-0 flex flex-col"
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {!isReady ? (
          <p className="text-sm text-on-surface-variant">
            Pick a channel on the left.
          </p>
        ) : isLoading && messages.length === 0 ? (
          <BringingUpSplash size="compact" status="Loading messages…" />
        ) : messages.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            No messages yet. Send the first one below.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((m) => (
              <li
                key={m.id}
                data-testid={`local-message-${m.id}`}
                className="flex flex-col gap-0.5"
              >
                <div className="text-[0.7rem] text-on-surface-variant/70 font-mono">
                  {m.author_peer_id.slice(0, 12)}…
                  <span className="ml-2">
                    {new Date(m.created_at).toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-sm text-on-surface whitespace-pre-wrap break-words">
                  {m.body}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        onSubmit={handleSubmit}
        className="border-t border-outline-variant/15 p-3 bg-surface-container-low/60 flex items-end gap-2 flex-shrink-0"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={1}
          disabled={!isReady}
          placeholder={isReady ? "Send a message" : "Pick a channel first"}
          aria-label="Send a message"
          data-testid="local-source-pane-input"
          className="flex-1 resize-none bg-surface rounded-lg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 border border-outline-variant/30 focus:outline-none focus:border-primary disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <button
          type="submit"
          disabled={!isReady || !draft.trim()}
          className="px-3 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
