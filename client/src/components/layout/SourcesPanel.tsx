import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { useSourcesStore, type ConcordSource } from "../../stores/sources";
import {
  SourceBrandIcon,
  inferSourceBrand,
  type SourceBrand,
} from "../sources/sourceBrand";

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
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of stored ?? []) {
    if (id !== ADD_SOURCE_TILE_ID && !sourceIds.includes(id)) continue;
    if (seen.has(id)) continue;
    next.push(id);
    seen.add(id);
  }
  for (const id of sourceIds) {
    if (!seen.has(id)) {
      next.push(id);
      seen.add(id);
    }
  }
  if (!seen.has(ADD_SOURCE_TILE_ID)) next.push(ADD_SOURCE_TILE_ID);
  return next;
}

function sourceTile(source: ConcordSource): {
  brand: SourceBrand;
  bg: string;
  icon: ReactNode;
  label: string;
} {
  const label = source.instanceName ?? source.host;
  const brand = inferSourceBrand(source);
  const bg = "bg-surface-container-high ring-1 ring-outline-variant/15";
  switch (brand) {
    case "discord":
      return {
        brand,
        bg,
        icon: <SourceBrandIcon brand={brand} size={28} className="text-[#5865F2]" />,
        label:
          source.platform === "discord-account"
            ? `Discord Account — ${label}`
            : `Discord Bridge — ${label}`,
      };
    case "mozilla":
      return {
        brand,
        bg,
        icon: <SourceBrandIcon brand={brand} size={28} />,
        label: `Mozilla — ${label}`,
      };
    case "matrix":
      return {
        brand,
        bg,
        icon: <SourceBrandIcon brand={brand} size={28} className="text-on-surface" />,
        label: `Matrix — ${label}`,
      };
    default:
      return {
        brand,
        bg,
        icon: <SourceBrandIcon brand={brand} size={28} />,
        label,
      };
  }
}

function SortableSourceTile({
  source,
  onToggle,
  onSourceOpen,
}: {
  source: ConcordSource;
  onToggle: (id: string) => void;
  onSourceOpen?: (sourceId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: source.id });
  const { bg, icon, label } = sourceTile(source);
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
          onSourceOpen?.(source.id);
        }}
        title={label}
        className={`group w-8 h-8 flex items-center justify-center transition-all duration-150 ${bg} ${
          source.enabled
            ? "rounded-xl shadow-lg scale-100 text-on-surface"
            : "rounded-lg hover:rounded-xl scale-95 hover:scale-100 opacity-45 hover:opacity-80 grayscale"
        }`}
      >
        {icon}
      </button>
    </div>
  );
}

export function SourcesPanel({
  onAddSource,
  onSourceSelect,
  onSourceOpen,
  onExplore,
}: {
  onAddSource: () => void;
  onSourceSelect?: (sourceId: string) => void;
  /** Called when a tile is clicked — opens the source browser for that source. */
  onSourceOpen?: (sourceId: string) => void;
  onExplore?: () => void;
}) {
  const currentUserId = useAuthStore((s) => s.userId);
  const sources = useSourcesStore((s) => s.sources);
  const toggleSource = useSourcesStore((s) => s.toggleSource);
  const setSourceOrder = useSourcesStore((s) => s.setSourceOrder);

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
        onSourceOpen={onSourceOpen}
      />
    );
  };

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
