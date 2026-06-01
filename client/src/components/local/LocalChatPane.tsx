/**
 * LocalChatPane — message area for the active porch channel.
 *
 * Reuses MessageList + MessageInput so the visual surface is
 * byte-identical to a Matrix text channel. The data layer is the
 * source-kind-aware piece: porchStore records (`ChannelMessage`) are
 * adapted into the renderer's `ChatMessage` shape at the call boundary
 * so MessageList consumes them unchanged.
 *
 * Mapping notes:
 *  - `ChannelMessage.author_peer_id` becomes the `sender`. The porch
 *    has no Matrix-style user identity for visitors; peer-id is the
 *    real handle for now. Display-name resolution is a TODO — for
 *    Phase A we render the raw peer-id, which is consistent with how
 *    the rest of the porch UI surfaces visitor identity.
 *  - `ChannelMessage.created_at` (unix ms) maps straight to
 *    `ChatMessage.timestamp`.
 *  - Reactions / edits / file uploads / typing indicators are not part
 *    of the porch protocol yet. The MessageList + MessageInput shape
 *    accommodates them as no-ops; future porch phases can wire them
 *    in without changing this component's external contract.
 */

import { useCallback, useMemo, useState } from "react";
import type { ChatMessage } from "../../hooks/useMatrix";
import { usePorchStore } from "../../stores/porchStore";
import { useInstanceNameStore } from "../../stores/instanceName";
import { MessageList } from "../chat/MessageList";
import { MessageInput } from "../chat/MessageInput";
import { BringingUpSplash } from "../BringingUpSplash";
import { VanityNameBanner, isVanityBannerSkipped } from "./VanityNameBanner";
import { isTauri } from "../../api/servitude";

function porchToChatMessage(
  m: {
    id: string;
    author_peer_id: string;
    body: string;
    created_at: number;
  },
): ChatMessage {
  return {
    id: m.id,
    sender: m.author_peer_id,
    body: m.body,
    timestamp: m.created_at,
    redacted: false,
    edited: false,
    msgtype: "m.text",
    url: null,
    reactions: [],
  };
}

export function LocalChatPane() {
  const isNative = isTauri();
  const channels = usePorchStore((s) => s.channels);
  const selectedChannelId = usePorchStore((s) => s.selectedChannelId);
  const messages = usePorchStore((s) => s.messages);
  const isLoaded = usePorchStore((s) => s.isLoaded);
  const isLoading = usePorchStore((s) => s.isLoading);
  const error = usePorchStore((s) => s.error);
  const sendMessage = usePorchStore((s) => s.sendMessage);

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);

  // Vanity-name banner gating. We show it when:
  //  - the user has not picked a name yet (`instanceName === ""`),
  //  - the porch has no messages (truly fresh install — long-running
  //    porches don't get re-nagged), and
  //  - the user hasn't tapped "skip" in this session.
  // `bannerHidden` lets the user dismiss the banner without immediately
  // re-mounting it from the parent props.
  const instanceName = useInstanceNameStore((s) => s.name);
  const [bannerHidden, setBannerHidden] = useState(() => isVanityBannerSkipped());
  const showVanityBanner =
    isNative &&
    !bannerHidden &&
    instanceName.trim().length === 0 &&
    messages.length === 0;

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) ?? null,
    [channels, selectedChannelId],
  );

  const chatMessages = useMemo(
    () => messages.map(porchToChatMessage),
    [messages],
  );

  const handleSend = useCallback(
    async (body: string) => {
      await sendMessage(body);
    },
    [sendMessage],
  );

  // Edit / file / reaction handlers are no-ops for porch Phase A —
  // the protocol doesn't carry those yet. Wired as resolved promises
  // so MessageList's prop contract stays satisfied without changes.
  const noopAsync = useCallback(async () => {}, []);

  // Web build: porch is desktop-only. Reuse the splash to mirror the
  // "we're waiting on a hosted service" affordance and surface a
  // status string the user can read.
  if (!isNative) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <BringingUpSplash
          size="compact"
          status="The porch lives on your desktop install"
        />
      </div>
    );
  }

  // Still loading the initial channel list.
  if (!isLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <BringingUpSplash size="compact" status="Loading porch…" />
      </div>
    );
  }

  if (error && error !== "native_only") {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-error font-body">{error}</p>
      </div>
    );
  }

  if (!selectedChannel) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-on-surface-variant font-body">
          Select a channel to start chatting
        </p>
      </div>
    );
  }

  const emptyState = (
    <p className="text-base text-on-surface font-body">
      Be the first to say something!
    </p>
  );

  return (
    <>
      {showVanityBanner && (
        <VanityNameBanner onDismiss={() => setBannerHidden(true)} />
      )}
      <MessageList
        messages={chatMessages}
        isPaginating={isLoading}
        hasMore={false}
        onLoadMore={noopAsync}
        // The porch has no Matrix user-id — surface this as "anonymous"
        // so the MessageList "own message" gating never lights up. A
        // future phase will plumb the local peer-id through here.
        currentUserId={null}
        isServerOwner={false}
        onDelete={noopAsync}
        onStartEdit={setEditingMessage}
        onReact={noopAsync}
        onRemoveReaction={noopAsync}
        emptyState={emptyState}
      />
      <MessageInput
        onSend={handleSend}
        editingMessage={editingMessage}
        onCancelEdit={() => setEditingMessage(null)}
        roomName={selectedChannel.name}
      />
    </>
  );
}
