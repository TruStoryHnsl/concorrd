import { useState, useCallback, type FormEvent, type KeyboardEvent } from "react";
import { sendMessage } from "@/api/tauri";
import { useServersStore, MESH_GENERAL_CHANNEL } from "@/stores/servers";

interface MessageInputProps {
  channelId?: string;
  serverId?: string;
  placeholder?: string;
}

function MessageInput({
  channelId = MESH_GENERAL_CHANNEL,
  serverId,
  placeholder = "Message the mesh...",
}: MessageInputProps) {
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const trimmed = content.trim();
      if (!trimmed || sending) return;

      setSending(true);
      try {
        const msg = await sendMessage(channelId, trimmed, serverId);
        useServersStore.getState().addMessage(msg);
        setContent("");
      } catch (err) {
        console.error("Failed to send message:", err);
      } finally {
        setSending(false);
      }
    },
    [content, channelId, serverId, sending],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="shrink-0 p-3 glass-panel rounded-xl mx-4 mb-3">
      <form onSubmit={handleSend} className="flex items-center gap-2">
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={sending}
          className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-surface-container border-none text-on-surface placeholder:text-on-surface-variant/50 font-body text-sm focus:outline-none focus:ring-1 focus:ring-primary/30 transition-colors"
        />
        <button
          type="submit"
          disabled={!content.trim() || sending}
          className="flex items-center justify-center w-9 h-9 rounded-xl primary-glow text-on-primary hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <span className="material-symbols-outlined text-lg">send</span>
        </button>
      </form>
    </div>
  );
}

export default MessageInput;
