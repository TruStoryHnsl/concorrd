import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAuthStore } from "../../stores/auth";
import { useSettingsStore } from "../../stores/settings";
import { useSourcesStore, type ConcordSource } from "../../stores/sources";
import { usePeerStore } from "../../stores/peerStore";
import { useAvatarUrl } from "../../hooks/usePresence";
import {
  SourceBrandIcon,
  inferSourceBrand,
  type SourceBrand,
} from "../sources/sourceBrand";
import { SourceContextMenu } from "./SourceContextMenu";
import { disconnectSource } from "../../lib/disconnectSource";

const SOURCE_RAIL_STORAGE_KEY_PREFIX = "concord_source_rail_order";
const ADD_SOURCE_TILE_ID = "__add_source_tile__";
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

function readStoredRailOrder(userId: string | null): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      `${SOURCE_RAIL_STORAGE_KEY_PREFIX}:${userId ?? "anon"}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function writeStoredRailOrder(userId: string | null, order: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    `${SOURCE_RAIL_STORAGE_KEY_PREFIX}:${userId ?? "anon"}`,
    JSON.stringify(order),
  );
}

function normalizeRailOrder(sourceIds: string[], stored: string[] | null): string[] {
  // Replay stored order. When the + tile is encountered, inject any NEW
  // sources (not previously in stored) immediately BEFORE it so that
  // freshly-added Concord/Matrix sources always default to being
  // above the + tile rather than below it.
  const next: string[] = [];
  const seen = new Set<string>();

  for (const id of stored ?? []) {
    if (id === ADD_SOURCE_TILE_ID) {
      // Insert new sources that haven't been placed yet, then the + tile.
      for (const sid of sourceIds) {
        if (!seen.has(sid)) { next.push(sid); seen.add(sid); }
      }
      next.push(ADD_SOURCE_TILE_ID);
      seen.add(ADD_SOURCE_TILE_ID);
      continue;
    }
    if (!sourceIds.includes(id) || seen.has(id)) continue; // stale / dupe
    next.push(id);
    seen.add(id);
  }

  // Append any sources not yet placed (+ tile was absent from stored).
  for (const id of sourceIds) {
    if (!seen.has(id)) { next.push(id); seen.add(id); }
  }
  // Guarantee + tile exists.
  if (!seen.has(ADD_SOURCE_TILE_ID)) next.push(ADD_SOURCE_TILE_ID);

  return next;
}

function sourceTile(source: ConcordSource): {
  brand: SourceBrand;
  bg: string;
  bgStyle: CSSProperties | undefined;
  icon: ReactNode;
  label: string;
} {
  const label = source.instanceName ?? source.host;
  const brand = inferSourceBrand(source);

  // INS-069 — when the source advertises branding, paint the tile
  // with a tinted background derived from `primaryColor` and an
  // accent ring derived from `accentColor`. Falls back to the
  // default surface-container styling when branding is absent.
  // Uses `color-mix(in srgb, …)` so we don't have to hand-roll an
  // RGB blend for the tint.
  const branding = source.branding;
  let bg: string;
  let bgStyle: CSSProperties | undefined;
  if (branding) {
    bg = "ring-1";
    bgStyle = {
      backgroundColor: `color-mix(in srgb, ${branding.primaryColor} 22%, var(--color-surface-container-high))`,
      // `boxShadow: inset 0 0 0 1px <accent>` would also work; we
      // use the ring utility's `--tw-ring-color` analogue via a
      // direct boxShadow to bypass tailwind's runtime needs.
      boxShadow: `0 0 0 1px ${branding.accentColor}`,
    };
  } else {
    bg = "bg-surface-container-high ring-1 ring-outline-variant/15";
    bgStyle = undefined;
  }

  // Icon colour: when branding is set, prefer the accent colour so
  // the icon stays visually keyed to the instance even if the
  // primary tint is dim. Otherwise leave the default per-brand
  // styling intact.
  const iconColor = branding?.accentColor;

  switch (brand) {
    case "mozilla":
      return {
        brand,
        bg,
        bgStyle,
        icon: <SourceBrandIcon brand={brand} size={28} color={iconColor} />,
        label: `Mozilla — ${label}`,
      };
    case "matrix":
      return {
        brand,
        bg,
        bgStyle,
        icon: (
          <SourceBrandIcon
            brand={brand}
            size={28}
            className={iconColor ? undefined : "text-on-surface"}
            color={iconColor}
          />
        ),
        label: `Matrix — ${label}`,
      };
    default:
      return {
        brand,
        bg,
        bgStyle,
        icon: <SourceBrandIcon brand={brand} size={28} color={iconColor} />,
        label,
      };
  }
}

function SortableSourceTile({
  source,
  onToggle,
  onContextMenu,
}: {
  source: ConcordSource;
  onToggle: (id: string) => void;
  /**
   * Fired on right-click (or long-press on touch). Receives the source
   * and viewport-relative cursor coords so the parent can position a
   * context menu. The previous behavior — context-click opens the
   * source browser — moves to the menu's "Open" entry, which makes
   * the destructive "Close connection" entry safer to surface.
   */
  onContextMenu: (source: ConcordSource, x: number, y: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: source.id });
  const { bg, bgStyle, icon, label } = sourceTile(source);
  const constrainedTransform = transform ? { ...transform, x: 0 } : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(constrainedTransform),
        transition,
        opacity: isDragging ? 0.7 : 1,
      }}
      className="w-full flex items-center justify-center flex-shrink-0"
    >
      <button
        {...attributes}
        {...listeners}
        onClick={() => onToggle(source.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(source, event.clientX, event.clientY);
        }}
        title={source.isOwner ? `${label} (owner)` : label}
        data-testid={`source-tile-${source.id}`}
        style={bgStyle}
        className={`group relative w-8 h-8 flex items-center justify-center transition-all duration-150 ${bg} ${
          source.enabled
            ? "rounded-xl shadow-lg scale-100 text-on-surface"
            : "rounded-lg hover:rounded-xl scale-95 hover:scale-100 opacity-45 hover:opacity-80 grayscale"
        }`}
      >
        {icon}
        {source.isOwner ? (
          <span
            data-testid={`source-owner-badge-${source.id}`}
            className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-amber-400 ring-2 ring-surface flex items-center justify-center text-[8px] font-bold text-surface"
            title="You own this server"
            aria-label="Owner"
          >
            ★
          </span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * Porch tile — synthetic, intrinsic Sources-rail entry for the local
 * install's porch (per-install local server + lobby; design doc:
 * `docs/architecture/porch-design.md`). NOT in `useSourcesStore.sources`
 * because that store represents external connections — the porch is local
 * and exists from first boot.
 *
 * Visual contract:
 *  - Fixed at the TOP of the rail (above sortable sources).
 *  - Renders even with zero sources.
 *  - Avatar = user's Matrix profile picture when available, else a
 *    `home` material symbol (P2P-only profile / no Matrix session).
 *  - Bottom-right "home" badge so the user knows this is THEIR porch
 *    (NOT a friend's). Mirrors the `source-owner-badge` star pattern.
 *  - Online dot in corner: green when at least one paired peer's
 *    `lastSeen` is recent (≤60s), gray otherwise.
 *  - NOT draggable / NOT removable. Right-click → "Open" only.
 */
function PorchTile({
  onPorchOpen,
}: {
  onPorchOpen?: () => void;
}) {
  const userId = useAuthStore((s) => s.userId);
  const avatarUrl = useAvatarUrl(userId);
  // Peer list drives the "any paired peer online" dot. Loaded once
  // here so the tile reflects current state without forcing every
  // mount to re-IPC. The store is shared; `load()` is idempotent and
  // sets `error: 'native-only'` on web builds (we tolerate that).
  const knownPeers = usePeerStore((s) => s.knownPeers);
  const loadPeers = usePeerStore((s) => s.load);
  useEffect(() => {
    void loadPeers();
  }, [loadPeers]);

  // A peer is "online" when its `lastSeen` is within the last 60s.
  // The libp2p swarm-event mirror that lights this up live is a Phase
  // follow-up; in the meantime `lastSeen` is the cheapest signal that
  // does not require an additional IPC round-trip on every render.
  const anyPeerOnline = useMemo(() => {
    const now = Date.now();
    return knownPeers.some((peer) => {
      const t = Date.parse(peer.lastSeen);
      if (Number.isNaN(t)) return false;
      return now - t < 60_000;
    });
  }, [knownPeers]);

  return (
    <div
      className="w-full flex items-center justify-center flex-shrink-0"
      data-testid="porch-tile-wrapper"
    >
      <button
        type="button"
        onClick={() => onPorchOpen?.()}
        title="Your porch"
        data-testid="porch-tile"
        className="group relative w-8 h-8 flex items-center justify-center rounded-xl shadow-lg scale-100 text-on-surface bg-surface-container-high ring-1 ring-primary/40 transition-all duration-150 hover:ring-primary/60"
        style={{
          // Subtle inset tint so the porch reads as "local / mine" vs
          // the neutral remote-source tiles. Uses the primary token so
          // it follows the active theme.
          backgroundColor:
            "color-mix(in srgb, var(--color-primary, #4f9eff) 14%, var(--color-surface-container-high))",
        }}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="w-7 h-7 rounded-lg object-cover"
            data-testid="porch-tile-avatar"
          />
        ) : (
          <span
            className="material-symbols-outlined text-lg text-on-surface"
            data-testid="porch-tile-home-icon"
          >
            home
          </span>
        )}
        {/* Home badge — overlapping bottom-right so the user knows
            this is *their* porch (not a friend's). Mirrors the
            `source-owner-badge` star pattern, different icon. */}
        <span
          data-testid="porch-tile-home-badge"
          className="absolute -bottom-1 -right-1 w-3 h-3 rounded-full bg-primary ring-2 ring-surface flex items-center justify-center"
          title="Your porch"
          aria-label="Your porch"
        >
          <span className="material-symbols-outlined text-on-primary" style={{ fontSize: "8px" }}>
            home
          </span>
        </span>
        {/* Online indicator — green when at least one paired peer is
            currently online via libp2p (Phase 5+ peer-store). */}
        <span
          data-testid={`porch-tile-online-${anyPeerOnline ? "yes" : "no"}`}
          className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ring-2 ring-surface ${
            anyPeerOnline ? "bg-green-500" : "bg-on-surface-variant/50"
          }`}
          aria-label={anyPeerOnline ? "Peer online" : "No peers online"}
        />
      </button>
    </div>
  );
}

/**
 * Mobile porch row — same intrinsic-tile semantics as the desktop
 * PorchTile but rendered as a list row, matching the mobile source
 * list visual contract.
 */
function MobilePorchRow({ onPorchOpen }: { onPorchOpen?: () => void }) {
  const userId = useAuthStore((s) => s.userId);
  const avatarUrl = useAvatarUrl(userId);
  const knownPeers = usePeerStore((s) => s.knownPeers);
  const loadPeers = usePeerStore((s) => s.load);
  useEffect(() => {
    void loadPeers();
  }, [loadPeers]);
  const anyPeerOnline = useMemo(() => {
    const now = Date.now();
    return knownPeers.some((peer) => {
      const t = Date.parse(peer.lastSeen);
      if (Number.isNaN(t)) return false;
      return now - t < 60_000;
    });
  }, [knownPeers]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPorchOpen?.()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPorchOpen?.();
        }
      }}
      data-testid="porch-tile-mobile"
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-container-high transition-colors cursor-pointer border-l-2 border-primary/40"
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          anyPeerOnline ? "bg-green-500" : "bg-on-surface-variant/50"
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-on-surface truncate">
          Your porch
        </div>
        <div className="text-xs text-on-surface-variant truncate">
          {avatarUrl ? "Local lobby" : "Local lobby (sign in for avatar)"}
        </div>
      </div>
    </div>
  );
}

function statusDot(source: ConcordSource) {
  switch (source.status) {
    case "connected":
      return <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />;
    case "connecting":
      return <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />;
    case "error":
      return <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />;
    default:
      return <span className="w-2 h-2 rounded-full bg-outline-variant flex-shrink-0" />;
  }
}

export function SourcesPanel({
  onAddSource,
  onSourceSelect,
  onSourceOpen,
  onPorchOpen,
  onExplore,
  mobile = false,
}: {
  onAddSource: () => void;
  onSourceSelect?: (sourceId: string) => void;
  /** Called when a tile is clicked — opens the source browser for that source. */
  onSourceOpen?: (sourceId: string) => void;
  /**
   * Called when the intrinsic Porch tile is clicked. The porch is local
   * to this install — see `docs/architecture/porch-design.md` — so the
   * parent should route the main view to the local `PorchView` rather
   * than the SourceServerBrowser modal. Optional so existing test
   * mounts still work without supplying the callback.
   */
  onPorchOpen?: () => void;
  onExplore?: () => void;
  mobile?: boolean;
}) {
  const currentUserId = useAuthStore((s) => s.userId);
  const rawSources = useSourcesStore((s) => s.sources);
  const toggleSource = useSourcesStore((s) => s.toggleSource);
  const setSourceOrder = useSourcesStore((s) => s.setSourceOrder);
  const updateSource = useSourcesStore((s) => s.updateSource);
  const openServerSettings = useSettingsStore((s) => s.openServerSettings);
  const openSettings = useSettingsStore((s) => s.openSettings);

  // Right-click / long-press surface. We keep the menu state local
  // because nothing else in the app needs to inspect "is a source
  // context menu open" — it's purely a per-panel affordance.
  const [contextMenu, setContextMenu] = useState<{
    source: ConcordSource;
    x: number;
    y: number;
  } | null>(null);

  const sources = rawSources;

  // INS-069 — lazy-fetch per-instance branding for any source whose
  // `branding` field is undefined. This populates the rail tile with
  // the upstream operator's chosen colours on first render after a
  // migration (v5 → v6 sources have undefined branding) or for any
  // source added before INS-069 shipped. We do NOT re-fetch when
  // branding is already populated — operators rotate branding rarely
  // and a stale cache is far cheaper than a fetch storm.
  //
  // Skipped for reticulum (no Concord well-known) and for hosts that
  // can't be parsed as URLs (the discoverHomeserver fetch would 500).
  useEffect(() => {
    let cancelled = false;
    const candidates = sources.filter(
      (s) =>
        s.branding === undefined &&
        s.platform !== "reticulum" &&
        typeof s.host === "string" &&
        s.host.length > 0,
    );
    if (candidates.length === 0) return;
    void (async () => {
      const { discoverHomeserver } = await import("../../api/wellKnown");
      for (const source of candidates) {
        if (cancelled) return;
        try {
          const config = await discoverHomeserver(source.host);
          if (cancelled) return;
          if (config.branding) {
            updateSource(source.id, { branding: config.branding });
          }
          // Note: when no branding is upstream, we leave `branding`
          // undefined in the store so a future operator-side
          // configuration becomes visible without a manual refresh.
          // This is a deliberate trade-off vs. a "fetched, none found"
          // sentinel — re-fetch traffic per source-tile mount is
          // negligible and the UX win is stronger.
        } catch {
          // Ignore — discovery failures shouldn't block the rail.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.length]);

  const isTouchDevice =
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0);
  const sensors = useSensors(
    ...(isTouchDevice
      ? [useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } })]
      : [useSensor(PointerSensor, { activationConstraint: { distance: 6 } })]),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleToggle = (id: string) => {
    toggleSource(id);
    onSourceSelect?.(id);
  };

  const [railOrder, setRailOrder] = useState<string[]>(() =>
    normalizeRailOrder(
      sources.map((source) => source.id),
      readStoredRailOrder(currentUserId),
    ),
  );

  useEffect(() => {
    setRailOrder((current) => {
      const next = normalizeRailOrder(
        sources.map((source) => source.id),
        current.length > 0 ? current : readStoredRailOrder(currentUserId),
      );
      // Belt-and-suspenders: if the computed order matches the current
      // order item-for-item, return the SAME reference so React skips
      // the re-render entirely. The useMemo on `sources` above is the
      // primary loop-break, but this guard makes the effect cheap even
      // when `sources` legitimately changes (e.g. enable/disable toggle).
      if (
        next.length === current.length &&
        next.every((id, i) => id === current[i])
      ) {
        return current;
      }
      writeStoredRailOrder(currentUserId, next);
      return next;
    });
  }, [currentUserId, sources]);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setRailOrder((current) => {
      const from = current.indexOf(String(active.id));
      const to = current.indexOf(String(over.id));
      if (from === -1 || to === -1) return current;
      const next = arrayMove(current, from, to);
      writeStoredRailOrder(currentUserId, next);
      setSourceOrder(next.filter((id) => id !== ADD_SOURCE_TILE_ID));
      return next;
    });
  };

  const topRailIds = useMemo(() => {
    const split = railOrder.indexOf(ADD_SOURCE_TILE_ID);
    return split === -1 ? railOrder : railOrder.slice(0, split);
  }, [railOrder]);
  const bottomRailIds = useMemo(() => {
    const split = railOrder.indexOf(ADD_SOURCE_TILE_ID);
    return split === -1 ? [ADD_SOURCE_TILE_ID] : railOrder.slice(split);
  }, [railOrder]);

  const renderRailTile = (id: string) => {
    if (id === ADD_SOURCE_TILE_ID) {
      return (
        <SortableAddSourceTile
          key={id}
          onAddSource={onAddSource}
        />
      );
    }
    const source = sources.find((entry) => entry.id === id);
    if (!source) return null;
    return (
      <SortableSourceTile
        key={source.id}
        source={source}
        onToggle={handleToggle}
        onContextMenu={(src, x, y) => setContextMenu({ source: src, x, y })}
      />
    );
  };

  // Shared between desktop + mobile returns. Position:fixed inside the
  // menu means it renders at viewport coords regardless of where in the
  // tree we place it; we mount it inside both layouts so the parent
  // doesn't need to know about it.
  const handleCloseConnection = (sourceId: string) => {
    // `disconnectSource` does the right thing whether the source is
    // the active Matrix session (full logout: stop client, reset
    // servers, clear localStorage, bindToUser(null)) or just one of
    // many catalog entries (drop the row). See its docstring for the
    // bug it was added to fix — without the session-aware teardown,
    // disconnecting the source-you-logged-in-with left the chats
    // visible because the live MatrixClient kept syncing.
    disconnectSource(sourceId);
  };
  const handleOpenSettings = (source: ConcordSource) => {
    if (source.platform === "concord") {
      openServerSettings(source.id);
    } else {
      // Matrix / Reticulum / other: route to the Connections tab,
      // where the per-source row lives. The user can adjust from
      // there until per-source detail panes exist for those platforms.
      openSettings("connections");
    }
  };
  const contextMenuOverlay = contextMenu ? (
    <SourceContextMenu
      source={contextMenu.source}
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={() => setContextMenu(null)}
      onOpen={(id) => onSourceOpen?.(id)}
      onOpenSettings={(id) => {
        const src = sources.find((s) => s.id === id);
        if (src) handleOpenSettings(src);
      }}
      onCloseConnection={handleCloseConnection}
    />
  ) : null;

  if (mobile) {
    return (
      <div className="h-full w-full bg-surface flex flex-col">
        {/* Header */}
        <div className="flex-shrink-0 px-4 py-3 border-b border-outline-variant/20">
          <span className="text-sm font-semibold text-on-surface-variant uppercase tracking-wide">Sources</span>
        </div>

        {/* Source list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Intrinsic Porch row — always FIRST, even when sources is empty.
              Local-only; not part of useSourcesStore.sources. */}
          <MobilePorchRow onPorchOpen={onPorchOpen} />
          {sources.map((source) => {
            // Outer container: <div role="button"> instead of <button>. HTML
            // forbids interactive elements nested inside <button>, and the
            // "more_vert" affordance below is a real <button>. Keyboard
            // affordance preserved via role + tabIndex + Enter/Space handler.
            return (
              <div
                key={source.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  onSourceSelect?.(source.id);
                  onSourceOpen?.(source.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSourceSelect?.(source.id);
                    onSourceOpen?.(source.id);
                  }
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-container-high transition-colors cursor-pointer ${
                  source.enabled ? "opacity-100" : "opacity-40"
                }`}
              >
                {statusDot(source)}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-on-surface truncate">
                    {source.instanceName || source.host}
                  </div>
                  <div className="text-xs text-on-surface-variant truncate">{source.host}</div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSourceOpen?.(source.id);
                  }}
                  className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  <span className="material-symbols-outlined text-base">more_vert</span>
                </button>
              </div>
            );
          })}
        </div>

        {/* Divider */}
        <div className="flex-shrink-0 h-px bg-outline-variant/20 mx-4" />

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3">
          {onExplore && (
            <button
              onClick={onExplore}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-sm text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined text-base">explore</span>
              Explore
            </button>
          )}
          <button
            onClick={onAddSource}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-sm text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <span className="material-symbols-outlined text-base">add</span>
            Add Source
          </button>
        </div>
        {contextMenuOverlay}
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-surface flex flex-col items-center py-3 pl-[3px] gap-0">
      <div className="flex-shrink-0 flex flex-col items-center gap-1.5 pb-2 pt-1">
        {onExplore && (
          <button
            onClick={onExplore}
            title="Explore"
            className="w-8 h-8 rounded-xl hover:rounded-lg bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-all duration-150"
          >
            <span className="material-symbols-outlined text-lg">explore</span>
          </button>
        )}
      </div>

      {(onExplore || sources.length > 0) && (
        <div className="w-8 h-px bg-outline-variant/20 flex-shrink-0 my-1" />
      )}

      {/* Intrinsic Porch tile — always rendered at the TOP of the rail,
          above the sortable sources. NOT a row in useSourcesStore.sources
          (the porch is local, not a remote connection). NOT draggable —
          intentionally outside the SortableContext below. */}
      <div className="w-full flex flex-col items-center gap-1.5 pb-1.5 flex-shrink-0">
        <PorchTile onPorchOpen={onPorchOpen} />
      </div>

      {/* Source tiles — scrollable, top-down */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={railOrder}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex-1 min-h-0 w-full flex flex-col items-center py-1">
            <div className="w-full flex flex-col items-center gap-1.5">
              {topRailIds.map(renderRailTile)}
            </div>
            <div className="flex-1 min-h-4" aria-hidden="true" />
            <div className="w-full flex flex-col items-center gap-1.5 pb-1">
              {bottomRailIds.map(renderRailTile)}
            </div>
          </div>
        </SortableContext>
      </DndContext>
      {contextMenuOverlay}
    </div>
  );
}

function SortableAddSourceTile({
  onAddSource,
}: {
  onAddSource: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: ADD_SOURCE_TILE_ID });
  const constrainedTransform = transform ? { ...transform, x: 0 } : null;
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(constrainedTransform),
        transition,
        opacity: isDragging ? 0.7 : 1,
      }}
      className="w-full flex items-center justify-center flex-shrink-0"
    >
      <button
        {...attributes}
        {...listeners}
        onClick={onAddSource}
        title="Add Source"
        className="w-8 h-8 rounded-xl hover:rounded-lg bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-all duration-150"
      >
        <span className="material-symbols-outlined text-lg">add</span>
      </button>
    </div>
  );
}
