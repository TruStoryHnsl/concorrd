import { create } from "zustand";
import { useAuthStore } from "./auth";
import { listExtensions, type ServerExtension } from "../api/concord";

/* ── Types ─────────────────────────────────────────────────────── */

export interface ExtensionDefinition {
  id: string;
  name: string;
  url: string;
  icon: string;
  description: string;
}

export type ExtensionSessionMode =
  | "shared"
  | "shared_readonly"
  | "shared_admin_input"
  | "per_user"
  | "hybrid";

export type ExtensionSessionStatus = "active" | "ended";

export type ExtensionVisibility =
  | "all"
  | "host_only"
  | "owner_only"
  | "admins_only"
  | "bound_users";

export type ExtensionInputPolicy =
  | "none"
  | "all"
  | "host_only"
  | "admins_only"
  | "owner_only"
  | "bound_users";

export interface ExtensionLaunchEntry {
  url: string;
  allow_origin: string;
  persist_profile: boolean;
}

export interface ExtensionLaunchDescriptor {
  kind: "browser_surface";
  entries: Record<string, ExtensionLaunchEntry>;
  args: Record<string, unknown>;
}

export interface ExtensionSurface {
  surface_id: string;
  kind: "browser";
  role: string;
  owner_user_id: string | null;
  launch_ref: string;
  visible_to: ExtensionVisibility;
  input_policy: ExtensionInputPolicy;
  layout: Record<string, unknown>;
  capabilities: {
    pointer: boolean;
    keyboard: boolean;
    resize: boolean;
    audio: boolean;
  };
}

export interface ExtensionBinding {
  binding_id: string;
  user_id: string;
  seat_id: string | null;
  role: "host" | "admin" | "participant" | "spectator";
  surface_ids: string[];
  input_on: string[];
}

export interface ExtensionPermissions {
  host_can_end: boolean;
  admins_can_override: boolean;
  default_input_policy: ExtensionInputPolicy;
}

export interface ActiveExtension {
  source: "legacy" | "session";
  eventType: string;
  stateKey: string;
  sessionId: string;
  extensionId: string;
  extensionUrl: string;
  extensionName: string;
  extensionIcon: string;
  hostUserId: string;
  startedAt: number;
  updatedAt: number;
  mode: ExtensionSessionMode;
  status: ExtensionSessionStatus;
  launch: ExtensionLaunchDescriptor;
  surfaces: ExtensionSurface[];
  bindings: ExtensionBinding[];
  permissions: ExtensionPermissions;
  meta: {
    title: string;
    summary: string;
  };
}

interface ExtensionState {
  /** Per-room active extension, keyed by matrix room ID */
  activeExtensions: Record<string, ActiveExtension | null>;
  /** Available extensions fetched from the server */
  catalog: ExtensionDefinition[];
  /** Whether the catalog has been loaded */
  catalogLoaded: boolean;
  /** Whether the extension picker menu is open */
  menuOpen: boolean;

  loadCatalog: (accessToken: string) => Promise<void>;
  setActiveExtension: (roomId: string, ext: ActiveExtension | null) => void;
  startExtension: (roomId: string, extensionId: string) => Promise<void>;
  stopExtension: (roomId: string) => Promise<void>;
  setMenuOpen: (open: boolean) => void;
}

/* ── Matrix event constants ────────────────────────────────────── */

export const LEGACY_EXTENSION_EVENT_TYPE = "com.concord.extension";
export const EXTENSION_SESSION_EVENT_TYPE = "com.concord.extension.session";
export const LEGACY_EXTENSION_STATE_KEY = "";

/* ── Session helpers ───────────────────────────────────────────── */

function createSessionId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `sess_${random}`;
}

function buildActiveSession(
  def: ExtensionDefinition,
  userId: string,
): ActiveExtension {
  const sessionId = createSessionId();
  const now = Date.now();
  const launch: ExtensionLaunchDescriptor = {
    kind: "browser_surface",
    entries: {
      primary: {
        url: def.url,
        allow_origin: "self",
        persist_profile: false,
      },
    },
    args: {},
  };

  const surfaces: ExtensionSurface[] = [
    {
      surface_id: "surf_shared_main",
      kind: "browser",
      role: "shared_main",
      owner_user_id: null,
      launch_ref: "primary",
      visible_to: "all",
      input_policy: "host_only",
      layout: { region: "main" },
      capabilities: {
        pointer: true,
        keyboard: true,
        resize: true,
        audio: false,
      },
    },
  ];

  const bindings: ExtensionBinding[] = [
    {
      binding_id: `bind_${userId}`,
      user_id: userId,
      seat_id: "seat_host",
      role: "host",
      surface_ids: surfaces.map((surface) => surface.surface_id),
      input_on: ["surf_shared_main"],
    },
  ];

  return {
    source: "session",
    eventType: EXTENSION_SESSION_EVENT_TYPE,
    stateKey: sessionId,
    sessionId,
    extensionId: def.id,
    extensionUrl: def.url,
    extensionName: def.name,
    extensionIcon: def.icon,
    hostUserId: userId,
    startedAt: now,
    updatedAt: now,
    mode: "shared_admin_input",
    status: "active",
    launch,
    surfaces,
    bindings,
    permissions: {
      host_can_end: true,
      admins_can_override: true,
      default_input_policy: "host_only",
    },
    meta: {
      title: def.name,
      summary: def.description,
    },
  };
}

function serializeSessionContent(
  ext: ActiveExtension,
  status: ExtensionSessionStatus,
): Record<string, unknown> {
  const updatedAt = Date.now();
  return {
    version: 1,
    session_id: ext.sessionId,
    extension_id: ext.extensionId,
    mode: ext.mode,
    status,
    host_user_id: ext.hostUserId,
    created_at: ext.startedAt,
    updated_at: updatedAt,
    catalog: {
      url: ext.extensionUrl,
      name: ext.extensionName,
      icon: ext.extensionIcon,
    },
    launch: ext.launch,
    surfaces: ext.surfaces,
    bindings: ext.bindings,
    permissions: ext.permissions,
    meta: {
      title: ext.meta.title,
      summary: ext.meta.summary,
    },
  };
}

/* ── Store ──────────────────────────────────────────────────────── */

export const useExtensionStore = create<ExtensionState>((set, get) => ({
  activeExtensions: {},
  catalog: [],
  catalogLoaded: false,
  menuOpen: false,

  loadCatalog: async (accessToken) => {
    if (get().catalogLoaded) return;
    try {
      const exts: ServerExtension[] = await listExtensions(accessToken);
      set({
        catalog: exts.map((e) => ({
          id: e.id,
          name: e.name,
          url: e.url,
          icon: e.icon,
          description: e.description,
        })),
        catalogLoaded: true,
      });
    } catch (err) {
      console.warn("[extensions] Failed to load catalog from server:", err);
    }
  },

  setActiveExtension: (roomId, ext) =>
    set((s) => ({
      activeExtensions: { ...s.activeExtensions, [roomId]: ext },
    })),

  startExtension: async (roomId, extensionId) => {
    const client = useAuthStore.getState().client;
    const userId = useAuthStore.getState().userId;
    if (!client || !userId) return;

    const def = get().catalog.find((d) => d.id === extensionId);
    if (!def) return;

    const session = buildActiveSession(def, userId);

    set((s) => ({
      activeExtensions: {
        ...s.activeExtensions,
        [roomId]: session,
      },
      menuOpen: false,
    }));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).sendStateEvent(
        roomId,
        EXTENSION_SESSION_EVENT_TYPE,
        serializeSessionContent(session, "active"),
        session.stateKey,
      );
    } catch (err) {
      console.warn(
        "[extensions] Session state event failed (extension still active locally):",
        err,
      );
    }
  },

  stopExtension: async (roomId) => {
    const client = useAuthStore.getState().client;
    if (!client) return;

    const active = get().activeExtensions[roomId] ?? null;

    set((s) => ({
      activeExtensions: { ...s.activeExtensions, [roomId]: null },
    }));

    try {
      if (active?.source === "session") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as any).sendStateEvent(
          roomId,
          EXTENSION_SESSION_EVENT_TYPE,
          serializeSessionContent(active, "ended"),
          active.stateKey,
        );
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).sendStateEvent(
        roomId,
        LEGACY_EXTENSION_EVENT_TYPE,
        { active: false },
        LEGACY_EXTENSION_STATE_KEY,
      );
    } catch (err) {
      console.error("[extensions] Failed to clear extension state event:", err);
    }
  },

  setMenuOpen: (menuOpen) => set({ menuOpen }),
}));
