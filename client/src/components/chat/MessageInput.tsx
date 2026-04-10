import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import type { ChatMessage } from "../../hooks/useMatrix";
import { useToastStore } from "../../stores/toast";

interface MessageInputProps {
  onSend: (message: string) => Promise<void>;
  onSubmitEdit?: (eventId: string, newBody: string) => Promise<void>;
  onSendFile?: (file: File) => Promise<void>;
  uploading?: boolean;
  editingMessage: ChatMessage | null;
  onCancelEdit: () => void;
  onKeystroke?: () => void;
  onStopTyping?: () => void;
  roomName: string;
}

interface StagedFile {
  id: string;
  file: File;
  previewUrl: string | null;
}

export function MessageInput({
  onSend,
  onSubmitEdit,
  onSendFile,
  uploading,
  editingMessage,
  onCancelEdit,
  onKeystroke,
  onStopTyping,
  roomName,
}: MessageInputProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const pendingRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-grow textarea on text change
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const computedLineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const lineHeight = Number.isNaN(computedLineHeight) ? 22 : computedLineHeight;
    const maxHeight = Math.min(window.innerHeight * 0.4, 8 * lineHeight);
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [text]);

  // Populate input when entering edit mode
  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.body);
      setStagedFiles([]);
      inputRef.current?.focus();
    }
  }, [editingMessage]);

  // Clean up preview URLs on unmount or when files change
  useEffect(() => {
    return () => {
      stagedFiles.forEach((sf) => {
        if (sf.previewUrl) URL.revokeObjectURL(sf.previewUrl);
      });
    };
  }, [stagedFiles]);

  const stageFiles = useCallback((files: FileList | File[]) => {
    const newStaged: StagedFile[] = Array.from(files).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    setStagedFiles((prev) => [...prev, ...newStaged]);
  }, []);

  const removeStaged = useCallback((id: string) => {
    setStagedFiles((prev) => {
      const removed = prev.find((sf) => sf.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((sf) => sf.id !== id);
    });
  }, []);

  const hasContent = text.trim().length > 0 || stagedFiles.length > 0;

  // INS-018: on touch devices (mobile soft keyboards) the Enter key should
  // insert a newline instead of sending, since there's no Shift modifier
  // available. Send is still reachable via the explicit Send button.
  const isCoarsePointer = useMemo(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(pointer: coarse)").matches;
  }, []);

  const handleSubmit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    const trimmed = text.trim();
    if ((!trimmed && stagedFiles.length === 0) || sending) return;

    setSending(true);
    pendingRef.current = trimmed;
    setText("");
    const filesToSend = [...stagedFiles];
    setStagedFiles([]);
    onStopTyping?.();

    try {
      if (editingMessage && onSubmitEdit) {
        await onSubmitEdit(editingMessage.id, trimmed);
        onCancelEdit();
      } else {
        // Send staged files first
        if (onSendFile) {
          for (const sf of filesToSend) {
            await onSendFile(sf.file);
          }
        }
        // Send text message if any
        if (trimmed) {
          await onSend(trimmed);
        }
      }
      pendingRef.current = null;
      // Clean up preview URLs
      filesToSend.forEach((sf) => {
        if (sf.previewUrl) URL.revokeObjectURL(sf.previewUrl);
      });
    } catch (err) {
      setText((current) => current || pendingRef.current || "");
      pendingRef.current = null;
      addToast(
        err instanceof Error ? err.message : "Failed to send message",
      );
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && editingMessage) {
      e.preventDefault();
      setText("");
      onCancelEdit();
      return;
    }
    // INS-018: on mobile/coarse-pointer devices, let Enter insert a newline.
    // Sending is done via the explicit Send button on those devices.
    if (isCoarsePointer) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (!editingMessage) {
      if (e.target.value) onKeystroke?.();
      else onStopTyping?.();
    }
  };

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) {
        stageFiles(e.target.files);
      }
      if (fileRef.current) fileRef.current.value = "";
    },
    [stageFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        stageFiles(e.dataTransfer.files);
      }
    },
    [stageFiles],
  );

  const formatSize = useMemo(() => (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }, []);

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface-container-low flex-shrink-0"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {editingMessage && (
        <div className="flex items-center gap-2 px-4 pt-2 text-xs text-on-surface-variant font-label">
          <span>Editing message</span>
          <button
            type="button"
            onClick={() => {
              setText("");
              onCancelEdit();
            }}
            className="text-on-surface-variant hover:text-on-surface"
          >
            Esc to cancel
          </button>
        </div>
      )}
      {uploading && (
        <div className="flex items-center gap-2 px-4 pt-2 text-xs text-primary font-label">
          <span className="inline-block w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          Uploading...
        </div>
      )}

      {/* Media deck */}
      {stagedFiles.length > 0 && (
        <div className="px-4 pt-3 pb-1">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {stagedFiles.map((sf) => (
              <div
                key={sf.id}
                className="relative flex-shrink-0 group"
              >
                {sf.previewUrl ? (
                  <img
                    src={sf.previewUrl}
                    alt={sf.file.name}
                    className="w-20 h-20 object-cover rounded-xl"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-xl bg-surface-container-high flex flex-col items-center justify-center p-1.5">
                    <span className="material-symbols-outlined text-on-surface-variant text-xl mb-1">description</span>
                    <span className="text-[9px] text-on-surface-variant truncate w-full text-center font-label">{sf.file.name}</span>
                    <span className="text-[9px] text-on-surface-variant/50 font-label">{formatSize(sf.file.size)}</span>
                  </div>
                )}
                {/* Remove button */}
                <button
                  type="button"
                  onClick={() => removeStaged(sf.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-error text-on-error flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <span className="material-symbols-outlined text-xs">close</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3">
        <div
          className={`flex items-end gap-2 bg-surface-container rounded-xl px-2 transition-all ${
            dragOver
              ? "ring-1 ring-primary/30 bg-primary/5"
              : editingMessage
                ? "ring-1 ring-primary/20"
                : ""
          }`}
        >
          {onSendFile && (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="concord-file-upload-btn btn-press p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-on-surface-variant hover:text-on-surface active:text-primary transition-colors flex-shrink-0 rounded-xl"
                title="Upload file"
              >
                <span className="material-symbols-outlined text-xl">attach_file</span>
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={onStopTyping}
            enterKeyHint="send"
            autoCapitalize="sentences"
            autoComplete="off"
            autoCorrect="on"
            spellCheck
            data-focusable="true"
            data-focus-group="chat-input"
            placeholder={
              editingMessage
                ? "Edit your message..."
                : dragOver
                  ? "Drop file here..."
                  : stagedFiles.length > 0
                    ? "Add a message or press Enter to send"
                    : `Message #${roomName}`
            }
            className="flex-1 px-2 py-3 bg-transparent text-on-surface placeholder-on-surface-variant/50 focus:outline-none text-base md:text-sm font-body resize-none leading-[22px]"
          />
          {hasContent && (
            <button
              type="submit"
              disabled={sending}
              data-focusable="true"
              data-focus-group="chat-input"
              className="btn-press p-2 text-primary hover:text-primary-container disabled:text-outline transition-colors flex-shrink-0"
              title="Send"
            >
              <span className="material-symbols-outlined text-xl">send</span>
            </button>
          )}
        </div>
      </div>
      <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
    </form>
  );
}
