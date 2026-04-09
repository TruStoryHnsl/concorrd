import { useEffect, useState, useRef, useCallback } from "react";
import type { Room, MatrixEvent, RoomMember } from "matrix-js-sdk";
import type { RoomMessageEventContent, ReactionEventContent } from "matrix-js-sdk/lib/@types/events";
import { ClientEvent, RoomEvent, RoomMemberEvent, EventType, RelationType, type SyncState, type SyncStateData } from "matrix-js-sdk";
import { useAuthStore } from "../stores/auth";
import { useToastStore } from "../stores/toast";
import { mxcToHttp } from "../api/media";

// Maximum events kept per room timeline to prevent unbounded memory growth.
// matrix-js-sdk's MemoryStore accumulates every synced event forever — on a
// long-running session this can consume hundreds of MB.
const MAX_TIMELINE_EVENTS = 500;

/** Trim old events from a room's live timeline to cap memory usage. */
function trimTimeline(room: Room) {
  const timeline = room.getLiveTimeline();
  const events = timeline.getEvents();
  if (events.length <= MAX_TIMELINE_EVENTS) return;

  const toRemove = events.slice(0, events.length - MAX_TIMELINE_EVENTS);
  for (const ev of toRemove) {
    const id = ev.getId();
    if (id) timeline.removeEvent(id);
  }
}

export function useMatrixSync() {
  const client = useAuthStore((s) => s.client);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!client) return;

    let tokenErrorCount = 0;
    const onSync = (state: SyncState, _prev: SyncState | null, data?: SyncStateData) => {
      if (state === "SYNCING" || state === "PREPARED") {
        setSyncing(true);
        tokenErrorCount = 0; // Reset on successful sync
      } else {
        setSyncing(state !== "ERROR" && state !== "STOPPED");
      }
      // Auto-logout after consecutive M_UNKNOWN_TOKEN errors.
      // A single transient error (server restart, network hiccup) should not
      // kick the user out — the SDK will retry sync automatically.
      if (state === "ERROR") {
        const errcode = (data as Record<string, unknown>)?.error &&
          typeof (data as Record<string, unknown>).error === "object" &&
          ((data as Record<string, unknown>).error as { errcode?: string })?.errcode;
        if (errcode === "M_UNKNOWN_TOKEN") {
          tokenErrorCount++;
          if (tokenErrorCount >= 3) {
            console.warn("Session expired (M_UNKNOWN_TOKEN) after 3 attempts, logging out");
            useToastStore.getState().addToast("Session expired — please log in again");
            useAuthStore.getState().logout();
          } else {
            console.warn(`Matrix sync token error (attempt ${tokenErrorCount}/3), will retry`);
          }
        }
      }
    };

    client.on(ClientEvent.Sync, onSync);
    client.startClient({
      initialSyncLimit: 20,
      lazyLoadMembers: true,
      pollTimeout: 30000,
    }).catch((err) => {
      console.error("Matrix startClient failed:", err);
      useToastStore.getState().addToast("Failed to connect to chat server");
    });

    // Auto-accept DM room invites so the other user can see DM messages
    // immediately. Also auto-accept channel-room invites — the server
    // fans out a Matrix invite when a new channel is created, and clients
    // need to join the underlying Matrix room before any messages render.
    // Federation is allowlisted at the homeserver, so the only invite
    // sources are trusted Concord-managed rooms.
    //
    // matrix-js-sdk types `membership` as `string | undefined`, so accept
    // the full RoomMember type and guard on the field before comparing.
    const onMembership = (_event: MatrixEvent, member: RoomMember) => {
      if (member.userId !== client.getUserId()) return;
      if (member.membership !== "invite") return;
      client.joinRoom(member.roomId).then(() => {
        // After joining a non-DM channel invite, refresh the Concord server
        // list so the new channel appears in the sidebar even if the user
        // had a stale cache from before the channel was created.
        const room = client.getRoom(member.roomId);
        const isDirect = room?.getDMInviter() != null;
        if (!isDirect) {
          import("../stores/auth").then(({ useAuthStore }) => {
            import("../stores/server").then(({ useServerStore }) => {
              const token = useAuthStore.getState().accessToken;
              if (token) {
                useServerStore.getState().loadServers(token).catch(() => {});
              }
            });
          });
        }
      }).catch((err) => {
        console.warn("Auto-join invited room failed:", err);
      });
    };
    client.on(RoomMemberEvent.Membership, onMembership);

    // Periodically trim room timelines to prevent memory from growing
    // unbounded. Runs every 60s and caps each room at MAX_TIMELINE_EVENTS.
    const trimInterval = setInterval(() => {
      for (const room of client.getRooms()) {
        trimTimeline(room);
      }
    }, 60_000);

    return () => {
      clearInterval(trimInterval);
      client.removeListener(ClientEvent.Sync, onSync);
      client.removeListener(RoomMemberEvent.Membership, onMembership);
      client.stopClient();
    };
  }, [client]);

  return syncing;
}

export function useRooms() {
  const client = useAuthStore((s) => s.client);
  const [rooms, setRooms] = useState<Room[]>([]);
  const prevIdsRef = useRef<string>("");

  useEffect(() => {
    if (!client) return;

    const updateRooms = () => {
      const joined = client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join");
      // Only update state if the set of room IDs actually changed.
      // Prevents re-renders on every sync cycle (fires every few seconds).
      const ids = joined.map((r) => r.roomId).join(",");
      if (ids !== prevIdsRef.current) {
        prevIdsRef.current = ids;
        setRooms(joined);
        // The set of joined rooms changed — refresh the synthetic
        // federated-room entries in the server store so newly-joined
        // loose rooms appear in the sidebar, and rooms the user has
        // left disappear. This is a client-side-only augmentation;
        // the Concord API server list is unaffected.
        //
        // After hydrating, probe every newly-seen federated
        // hostname for a /.well-known/concord/client document so
        // we can visually mark other Concord instances distinctly
        // from vanilla Matrix hosts. Probes are de-duplicated by
        // the store and cached across page reloads via the
        // persist middleware, so we don't hammer the network on
        // every sync.
        Promise.all([
          import("../stores/server"),
          import("../stores/federatedInstances"),
        ]).then(([{ useServerStore }, { useFederatedInstanceStore }]) => {
          useServerStore.getState().hydrateFederatedRooms(client);
          const instanceStore = useFederatedInstanceStore.getState();
          for (const [host, inst] of Object.entries(instanceStore.instances)) {
            // Only probe hosts we haven't determined the Concord-
            // status of yet. Once isConcord is true, we're done;
            // once we've tried and got a clear non-Concord answer
            // (status "live" but isConcord still false), we skip
            // until the user manually refreshes.
            if (inst.isConcord) continue;
            if (inst.status === "live") continue;
            instanceStore.probeConcordHost(host);
          }
        });
      }
    };

    client.on(ClientEvent.Sync, updateRooms);
    client.on(ClientEvent.Room, updateRooms);
    updateRooms();

    return () => {
      client.removeListener(ClientEvent.Sync, updateRooms);
      client.removeListener(ClientEvent.Room, updateRooms);
    };
  }, [client]);

  return rooms;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
  eventIds: Record<string, string>; // userId -> reaction event ID
}

/**
 * ChartAttachment — typed chart spec attached to a Matrix message via the
 * `com.concord.chart` custom content field. Matrix permits namespaced custom
 * fields on `m.room.message`; they are preserved verbatim through federation
 * and on reload, so no separate persistence layer is needed. A chart is
 * authored by an agent (e.g. OpenClaw) and rendered client-side by
 * react-chartjs-2. The `options` field is a raw chart.js options object.
 */
export interface ChartAttachment {
  type: "bar" | "line" | "pie";
  data: {
    labels: string[];
    datasets: Array<{
      label?: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
    }>;
  };
  options?: Record<string, unknown>;
  title?: string;
}

export interface ChatMessage {
  id: string;
  sender: string;
  body: string;
  timestamp: number;
  redacted: boolean;
  edited: boolean;
  msgtype: string;
  url: string | null;
  info?: { mimetype?: string; size?: number; w?: number; h?: number };
  reactions: Reaction[];
  /** Raw chart attachment payload as received from Matrix (untrusted). */
  chartRaw?: unknown;
}

export interface RoomMessagesResult {
  messages: ChatMessage[];
  isPaginating: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
}

export function useRoomMessages(roomId: string | null): RoomMessagesResult {
  const client = useAuthStore((s) => s.client);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isPaginating, setIsPaginating] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const lastIdsRef = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extractRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!client || !roomId) {
      setMessages([]);
      lastIdsRef.current = "";
      setHasMore(true);
      return;
    }

    const extractMessages = () => {
      const room = client.getRoom(roomId);
      if (!room) return;

      const fullTimeline = room.getLiveTimeline().getEvents();
      // Only process the tail of the timeline to avoid O(n) scans over
      // thousands of accumulated events. 1000 gives enough context for
      // reactions/edits that reference recent messages.
      const timeline = fullTimeline.length > 1000
        ? fullTimeline.slice(-1000)
        : fullTimeline;

      // Pass 1: Build reaction map and edit map from the (capped) timeline
      const reactionMap = new Map<
        string,
        Map<string, { userIds: string[]; eventIds: Record<string, string> }>
      >();
      const editMap = new Map<string, string>(); // originalId -> latest body

      for (const ev of timeline) {
        if (ev.isRedacted()) continue;

        const type = ev.getType();

        if (type === "m.reaction") {
          const content = ev.getContent();
          const rel = content["m.relates_to"];
          if (rel?.rel_type === "m.annotation" && rel.event_id && rel.key) {
            const targetId = rel.event_id as string;
            const emoji = rel.key as string;
            const sender = ev.getSender()!;
            if (!reactionMap.has(targetId))
              reactionMap.set(targetId, new Map());
            const emojiMap = reactionMap.get(targetId)!;
            if (!emojiMap.has(emoji))
              emojiMap.set(emoji, { userIds: [], eventIds: {} });
            const entry = emojiMap.get(emoji)!;
            if (!entry.userIds.includes(sender)) {
              entry.userIds.push(sender);
              entry.eventIds[sender] = ev.getId()!;
            }
          }
        }

        if (type === "m.room.message") {
          const content = ev.getContent();
          const rel = content["m.relates_to"];
          if (rel?.rel_type === "m.replace" && rel.event_id) {
            const newContent = content["m.new_content"];
            if (newContent?.body) {
              editMap.set(rel.event_id as string, newContent.body as string);
            }
          }
        }
      }

      // Pass 2: Build message list (exclude edit events)
      const msgs: ChatMessage[] = timeline
        .filter((ev: MatrixEvent) => {
          if (ev.getType() !== "m.room.message") return false;
          const rel = ev.getContent()["m.relates_to"];
          if (rel?.rel_type === "m.replace") return false;
          return true;
        })
        .map((ev: MatrixEvent) => {
          const id = ev.getId()!;
          const redacted = ev.isRedacted();
          const content = redacted ? {} : ev.getContent();
          const editBody = editMap.get(id);
          const msgtype = (content.msgtype as string) || "m.text";

          let body: string;
          if (redacted) {
            body = "";
          } else if (editBody !== undefined) {
            body = editBody;
          } else {
            body = (content.body as string) || "";
          }

          let url: string | null = null;
          const mxcUrl = content.url as string | undefined;
          if (mxcUrl && !redacted) {
            const token = useAuthStore.getState().accessToken;
            url = mxcToHttp(mxcUrl, token);
          }

          const reactions: Reaction[] = [];
          const emojiMap = reactionMap.get(id);
          if (emojiMap) {
            for (const [emoji, entry] of emojiMap) {
              if (entry.userIds.length > 0) {
                reactions.push({
                  emoji,
                  count: entry.userIds.length,
                  userIds: entry.userIds,
                  eventIds: entry.eventIds,
                });
              }
            }
          }

          // Chart attachments ride on a namespaced custom field per Matrix
          // extensibility rules; they survive federation + reload natively.
          const chartRaw = redacted
            ? undefined
            : (content as Record<string, unknown>)["com.concord.chart"];

          return {
            id,
            sender: ev.getSender()!,
            body,
            timestamp: ev.getTs(),
            redacted,
            edited: editBody !== undefined,
            msgtype,
            url,
            info: redacted ? undefined : (content.info as ChatMessage["info"]),
            reactions,
            chartRaw,
          };
        });

      // Equality key includes reaction counts so we re-render on reaction changes
      const idsKey = msgs
        .map(
          (m) =>
            `${m.id}:${m.redacted}:${m.edited}:${m.body.length}:${m.chartRaw ? "c" : "."}:${m.reactions.map((r) => `${r.emoji}${r.count}`).join("")}`,
        )
        .join(",");
      if (idsKey !== lastIdsRef.current) {
        lastIdsRef.current = idsKey;
        setMessages(msgs);
      }
    };

    extractRef.current = extractMessages;

    const debouncedExtract = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(extractMessages, 50);
    };

    const onTimeline = (
      _event: MatrixEvent,
      room: Room | undefined,
    ) => {
      if (room?.roomId === roomId) debouncedExtract();
    };

    const onRedaction = (
      _event: MatrixEvent,
      room: Room | undefined,
    ) => {
      if (room?.roomId === roomId) debouncedExtract();
    };

    client.on(RoomEvent.Timeline, onTimeline);
    client.on(RoomEvent.Redaction, onRedaction);
    extractMessages();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      client.removeListener(RoomEvent.Timeline, onTimeline);
      client.removeListener(RoomEvent.Redaction, onRedaction);
    };
  }, [client, roomId]);

  // Use refs for pagination guards so loadMore stays referentially stable
  const isPaginatingRef = useRef(isPaginating);
  isPaginatingRef.current = isPaginating;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;

  const loadMore = useCallback(async () => {
    if (!client || !roomId || isPaginatingRef.current || !hasMoreRef.current) return;
    const room = client.getRoom(roomId);
    if (!room) return;

    setIsPaginating(true);
    try {
      const timeline = room.getLiveTimeline();
      const more = await client.paginateEventTimeline(timeline, {
        backwards: true,
        limit: 50,
      });
      setHasMore(more);
      extractRef.current();
    } catch (err) {
      console.error("Pagination failed:", err);
    } finally {
      setIsPaginating(false);
    }
  }, [client, roomId]);

  return { messages, isPaginating, hasMore, loadMore };
}

export function useSendMessage(roomId: string | null) {
  const client = useAuthStore((s) => s.client);

  return async (body: string) => {
    if (!client || !roomId) throw new Error("Not connected to a channel");

    try {
      await client.sendTextMessage(roomId, body);
    } catch (err: unknown) {
      // Auto-rejoin on 403 (membership lost after server restart) and retry once
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("M_FORBIDDEN") && msg.includes("membership")) {
        const { rejoinServerRooms } = await import("../api/concord");
        const { useServerStore } = await import("../stores/server");
        const token = useAuthStore.getState().accessToken;
        const serverId = useServerStore.getState().activeServerId;
        if (token && serverId) {
          await rejoinServerRooms(serverId, token);
          await client.sendTextMessage(roomId, body);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    // Fire-and-forget message stat increment
    try {
      const { incrementMessageCount } = await import("../api/concord");
      const { useServerStore } = await import("../stores/server");
      const token = useAuthStore.getState().accessToken;
      const serverId = useServerStore.getState().activeServerId;
      if (token && serverId) {
        incrementMessageCount(roomId, serverId, token);
      }
    } catch {
      // Stats tracking is non-critical
    }
  };
}

export function useDeleteMessage(roomId: string | null) {
  const client = useAuthStore((s) => s.client);

  return async (eventId: string) => {
    if (!client || !roomId) return;
    try {
      await client.redactEvent(roomId, eventId);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : "Failed to delete message",
        );
    }
  };
}

export function useEditMessage(roomId: string | null) {
  const client = useAuthStore((s) => s.client);

  return async (eventId: string, newBody: string) => {
    if (!client || !roomId) return;
    try {
      await client.sendEvent(roomId, EventType.RoomMessage, {
        "m.new_content": { msgtype: "m.text", body: newBody },
        "m.relates_to": { rel_type: RelationType.Replace, event_id: eventId },
        msgtype: "m.text",
        body: `* ${newBody}`,
      } as RoomMessageEventContent);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : "Failed to edit message",
        );
    }
  };
}

function getMsgtype(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "m.image";
  if (mimeType.startsWith("audio/")) return "m.audio";
  if (mimeType.startsWith("video/")) return "m.video";
  return "m.file";
}

export function useSendFile(roomId: string | null) {
  const client = useAuthStore((s) => s.client);
  const [uploading, setUploading] = useState(false);

  const sendFile = async (file: File) => {
    if (!client || !roomId) return;
    setUploading(true);
    try {
      const response = await client.uploadContent(file, { type: file.type });
      const mxcUrl = response.content_uri;
      const msgtype = getMsgtype(file.type);
      const info: { mimetype: string; size: number; w?: number; h?: number } = {
        mimetype: file.type,
        size: file.size,
      };

      if (file.type.startsWith("image/")) {
        const dims = await getImageDimensions(file);
        if (dims) {
          info.w = dims.w;
          info.h = dims.h;
        }
      }

      await client.sendMessage(roomId, {
        msgtype,
        body: file.name,
        url: mxcUrl,
        info,
      } as RoomMessageEventContent);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(err instanceof Error ? err.message : "Failed to upload file");
    } finally {
      setUploading(false);
    }
  };

  return { sendFile, uploading };
}

function getImageDimensions(
  file: File,
): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

export function useSendReaction(roomId: string | null) {
  const client = useAuthStore((s) => s.client);

  return async (eventId: string, emoji: string) => {
    if (!client || !roomId) return;
    try {
      await client.sendEvent(roomId, EventType.Reaction, {
        "m.relates_to": {
          rel_type: RelationType.Annotation,
          event_id: eventId,
          key: emoji,
        },
      } as ReactionEventContent);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : "Failed to send reaction",
        );
    }
  };
}

export function useRemoveReaction(roomId: string | null) {
  const client = useAuthStore((s) => s.client);

  return async (reactionEventId: string) => {
    if (!client || !roomId) return;
    try {
      await client.redactEvent(roomId, reactionEventId);
    } catch (err) {
      useToastStore
        .getState()
        .addToast(
          err instanceof Error ? err.message : "Failed to remove reaction",
        );
    }
  };
}
