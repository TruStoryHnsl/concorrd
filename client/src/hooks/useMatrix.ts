import { useEffect, useState, useRef, useCallback } from "react";
import type { Room, MatrixEvent, RoomMember } from "matrix-js-sdk";
import type { RoomMessageEventContent, ReactionEventContent } from "matrix-js-sdk/lib/@types/events";
import { ClientEvent, RoomEvent, RoomMemberEvent, EventType, RelationType, type SyncState, type SyncStateData } from "matrix-js-sdk";
import { useAuthStore } from "../stores/auth";
import { useToastStore } from "../stores/toast";
import { mxcToHttp } from "../api/media";
import { parseWidgetComposerCommand } from "../components/chat/chatWidgets";

const storeStartupByClient = new WeakMap<object, Promise<void>>();

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
  const [syncing, setSyncingLocal] = useState(false);
  // Keep local state + auth store in sync so consumers that read
  // connection state from the store (e.g. ServerSidebar) don't have
  // to re-subscribe to ClientEvent.Sync themselves and duplicate
  // this hook's federated-hydration side effects. Zustand's setState
  // is stable so reading it through `getState()` avoids subscribing
  // to store changes and also sidesteps the exhaustive-deps lint
  // that would want `setSyncing` in every effect below.
  const setSyncing = (value: boolean) => {
    setSyncingLocal(value);
    useAuthStore.getState().setSyncing(value);
  };

  useEffect(() => {
    if (!client) return;

    // DIAGNOSTIC (INS-028 follow-up): expose a window-global debug
    // function that dumps the federated-room classifier input on
    // demand. Lets a user (or Claude) reproduce the diagnostic
    // without having to catch the once-per-sync log group — just
    // open devtools, type `concordDebug()`, hit enter, and paste
    // the result.
    //
    // Exposed on `window.concordDebug` rather than on a Concord
    // namespace to keep the console typing short. Deliberately
    // non-optional / non-lazy so it's discoverable via
    // `Object.keys(window)` grep if someone forgets the name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).concordDebug = () => {
      const rooms = client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join")
        .map((r) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const state = (r as any).currentState;
          const parents = (
            state?.getStateEvents?.("m.space.parent") ?? []
          )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((e: any) => e.getStateKey?.())
            .filter((x: unknown) => typeof x === "string");
          const children = (
            state?.getStateEvents?.("m.space.child") ?? []
          )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((e: any) => e.getStateKey?.())
            .filter((x: unknown) => typeof x === "string");
          return {
            id: r.roomId,
            name: r.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type: (r as any).getType?.() ?? "(regular)",
            parents,
            childCount: children.length,
          };
        });
      const payload = {
        userId: client.getUserId?.() ?? null,
        joinedCount: rooms.length,
        rooms,
      };
      // eslint-disable-next-line no-console
      console.log("%c=== concordDebug() ===", "font-weight:bold;color:#4ade80");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    };

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

    const startPromise = (() => {
      const store = (client as unknown as { store?: { startup?: () => Promise<void> } }).store;
      const startup =
        store?.startup
          ? storeStartupByClient.get(client) ??
            store.startup()
              .catch((err) => {
                console.warn("Matrix store startup failed, continuing without cache:", err);
              })
              .then(() => {})
          : Promise.resolve();
      if (store?.startup && !storeStartupByClient.has(client)) {
        storeStartupByClient.set(client, startup);
      }
      return startup.then(() =>
        client.startClient({
          initialSyncLimit: 20,
          lazyLoadMembers: true,
          // 20s long-poll, deliberately under the typical 30s
          // idle timeout on Cloudflare Tunnel and most CDN paths.
          // Previous 30s was right at or beyond the edge cutoff,
          // so every empty-poll completion came back as a NetworkError
          // ("sync /sync error ... fetch failed"). 20s gives the SDK
          // a clean response, then immediately re-issues the next
          // poll. The cost is ~50% more sync requests on idle
          // accounts, all empty {} responses; trivially cheap and
          // a vastly cleaner console.
          pollTimeout: 20000,
        }),
      );
    })();

    startPromise.catch((err) => {
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

    // Federated-room hydration loop.
    //
    // Matrix sync events fire the classifier + catalog updaters
    // so the federated-tile sidebar reflects the current
    // joined-room state as soon as matrix-js-sdk has caught up.
    //
    // The previous implementation lived in `useRooms()`, but that
    // hook was never actually consumed by any component — it was
    // dead code. Federated hydration only fired when ExploreModal
    // explicitly called `hydrateFederatedRooms` after a join,
    // which is why page reloads left the sidebar stuck with
    // placeholder tiles until the user joined something new.
    // Moving the subscription into `useMatrixSync` (which IS
    // called from ChatLayout) means hydration runs on every sync
    // event, as it was always meant to.
    //
    // De-dup via a local `prevIdsSig` string so we only re-hydrate
    // when the set of joined rooms actually changes — sync events
    // fire every few seconds during idle and we don't need to
    // rebuild the synthetic servers unless something changed.
    let prevIdsSig = "";
    const hydrateFederated = () => {
      const joined = client.getRooms().filter(
        (r) => r.getMyMembership() === "join",
      );
      const sig = joined
        .map((r) => r.roomId)
        .sort()
        .join(",");
      if (sig === prevIdsSig) return;
      prevIdsSig = sig;
      // Dynamic import so this file doesn't pull the whole
      // server store into every consumer of useMatrixSync.
      import("../stores/server")
        .then(({ useServerStore }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          useServerStore.getState().hydrateFederatedRooms(client as any);
        })
        .catch((err) => {
          console.warn("federated hydration failed:", err);
        });
    };
    client.on(ClientEvent.Sync, hydrateFederated);
    client.on(ClientEvent.Room, hydrateFederated);
    // Also fire once immediately in case the client already has
    // joined rooms in its cache from a prior session — matrix-js-sdk
    // seeds the Room list synchronously when recovering from
    // persisted state, and we want those rooms to render before
    // the first sync tick completes.
    hydrateFederated();

    return () => {
      clearInterval(trimInterval);
      client.removeListener(ClientEvent.Sync, onSync);
      client.removeListener(ClientEvent.Sync, hydrateFederated);
      client.removeListener(ClientEvent.Room, hydrateFederated);
      client.removeListener(RoomMemberEvent.Membership, onMembership);
      // NOTE: do NOT call client.stopClient() here.
      //
      // React StrictMode in dev mode runs this effect twice in
      // quick succession (mount → cleanup → re-mount). matrix-js-sdk
      // 41.0.0-rc.0 has a bug where stopClient() sets
      // `callEventHandler = undefined` but the internal sync-listener
      // that's supposed to call `callEventHandler.start()` stays
      // attached. On the second mount, the re-run of startClient()
      // does NOT re-initialize callEventHandler (the constructor did
      // that, once, at creation time) — so the next sync fires
      // `this.callEventHandler!.start()` on undefined and the whole
      // sync loop aborts with:
      //
      //   TypeError: Can't access property "start",
      //   this.callEventHandler is undefined
      //
      // Leaving stopClient() out of the cleanup path means the
      // client keeps syncing across the StrictMode double-effect,
      // which is what we actually want — there's no point stopping
      // and restarting a fresh client. Actual logout is handled by
      // `useAuthStore.logout()` which calls `stopClient()` at the
      // real end of the session.
    };
  }, [client]);

  return syncing;
}

export function useRooms() {
  // NOTE: this hook is currently unused by any consumer in the
  // project. It exists as a lightweight "give me the joined room
  // list" utility for future use. The federated-room hydration
  // that USED to live here has moved into `useMatrixSync` above,
  // because that's the hook that's actually called by ChatLayout
  // and thus actually runs during a normal page load. Before the
  // move, federated hydration never fired on refresh — it only
  // ran when the user joined a new room via ExploreModal — and
  // the sidebar was stuck showing stale placeholder tiles. Don't
  // re-add hydration logic here without also adding a consumer.
  const client = useAuthStore((s) => s.client);
  const [rooms, setRooms] = useState<Room[]>([]);
  const prevIdsRef = useRef<string>("");

  useEffect(() => {
    if (!client) return;

    const updateRooms = () => {
      const joined = client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join");
      const ids = joined.map((r) => r.roomId).join(",");
      if (ids !== prevIdsRef.current) {
        prevIdsRef.current = ids;
        setRooms(joined);
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
  /** Raw pinned-widget payload as received from Matrix (untrusted). */
  widgetRaw?: unknown;
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
          const widgetRaw = redacted
            ? undefined
            : (content as Record<string, unknown>)["com.concord.widget"];

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
            widgetRaw,
          };
        });

      // Equality key includes reaction counts so we re-render on reaction changes
      const idsKey = msgs
        .map(
          (m) =>
            `${m.id}:${m.redacted}:${m.edited}:${m.body.length}:${m.chartRaw ? "c" : "."}:${m.widgetRaw ? "w" : "."}:${m.reactions.map((r) => `${r.emoji}${r.count}`).join("")}`,
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

    // Auto-backfill initial scrollback when a room is first opened with an
    // empty live timeline. Typical for federated rooms the user just joined
    // via Explore: matrix-js-sdk's /sync only delivers forward events on a
    // newly-joined room, so history stays empty until someone calls
    // /messages?dir=b. MessageList's top-sentinel IntersectionObserver can't
    // help because its sentinel div is behind an `if (messages.length === 0)`
    // early return — no messages means no sentinel means the observer never
    // fires and the room reads as "No messages yet" forever.
    //
    // We bridge that gap here: if the freshly-bound room has zero events in
    // its live timeline, fire one scrollback eagerly, update hasMore from
    // the result, then re-extract. The `cancelled` guard keeps a slow join
    // on an abandoned roomId from clobbering state for the room the user
    // has since moved to.
    const room = client.getRoom(roomId);
    let cancelled = false;
    const timelineEvents = room?.getLiveTimeline().getEvents() ?? [];
    const hasMessages = timelineEvents.some((e) => e.getType() === "m.room.message");
    if (room && !hasMessages) {
      setIsPaginating(true);
      const timeline = room.getLiveTimeline();
      client
        .paginateEventTimeline(timeline, { backwards: true, limit: 50 })
        .then((more) => {
          if (cancelled) return;
          setHasMore(more);
          extractMessages();
        })
        .catch((err) => {
          if (!cancelled) {
            console.warn(
              `Initial scrollback failed for ${roomId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        })
        .finally(() => {
          if (!cancelled) setIsPaginating(false);
        });
    }

    return () => {
      cancelled = true;
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

    const parsed = parseWidgetComposerCommand(body);
    const sendCurrentMessage = async () => {
      if (parsed.widget) {
        await client.sendMessage(roomId, {
          msgtype: "m.text",
          body: parsed.body,
          "com.concord.widget": parsed.widget,
        } as RoomMessageEventContent);
        return;
      }
      await client.sendTextMessage(roomId, parsed.body);
    };

    try {
      await sendCurrentMessage();
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
          await sendCurrentMessage();
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
