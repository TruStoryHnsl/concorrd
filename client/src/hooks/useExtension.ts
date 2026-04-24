import { useEffect, useCallback } from "react";
import { RoomStateEvent } from "matrix-js-sdk";
import type { MatrixEvent } from "matrix-js-sdk";
import { useAuthStore } from "../stores/auth";
import {
  useExtensionStore,
  LEGACY_EXTENSION_EVENT_TYPE,
  LEGACY_EXTENSION_STATE_KEY,
  EXTENSION_SESSION_EVENT_TYPE,
  type ActiveExtension,
  type ExtensionBinding,
  type ExtensionInputPolicy,
  type ExtensionLaunchDescriptor,
  type ExtensionLaunchEntry,
  type ExtensionSessionMode,
  type ExtensionSessionStatus,
  type ExtensionSurface,
  type ExtensionVisibility,
} from "../stores/extension";

const SESSION_MODES = new Set<ExtensionSessionMode>([
  "shared",
  "shared_readonly",
  "shared_admin_input",
  "per_user",
  "hybrid",
]);

const SESSION_STATUSES = new Set<ExtensionSessionStatus>(["active", "ended"]);
const INPUT_POLICIES = new Set<ExtensionInputPolicy>([
  "none",
  "all",
  "host_only",
  "admins_only",
  "owner_only",
  "bound_users",
]);
const VISIBILITY_POLICIES = new Set<ExtensionVisibility>([
  "all",
  "host_only",
  "owner_only",
  "admins_only",
  "bound_users",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStateEvents(value: unknown): MatrixEvent[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as MatrixEvent[];
  return [value as MatrixEvent];
}

function normalizeCatalogPrefix(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function isAllowlistedLaunchUrl(catalogUrl: string, launchUrl: string): boolean {
  return launchUrl === catalogUrl || launchUrl.startsWith(normalizeCatalogPrefix(catalogUrl));
}

function normalizeLaunchEntries(
  catalogUrl: string,
  raw: unknown,
): Record<string, ExtensionLaunchEntry> | null {
  if (!isRecord(raw)) return null;
  const entries: Record<string, ExtensionLaunchEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.url !== "string") return null;
    if (!isAllowlistedLaunchUrl(catalogUrl, value.url)) return null;
    entries[key] = {
      url: value.url,
      allow_origin:
        typeof value.allow_origin === "string" ? value.allow_origin : "self",
      persist_profile: value.persist_profile === true,
    };
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

function normalizeSurfaces(raw: unknown): ExtensionSurface[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const surfaces: ExtensionSurface[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const visibleTo = item.visible_to;
    const inputPolicy = item.input_policy;
    if (
      item.kind !== "browser" ||
      typeof item.surface_id !== "string" ||
      typeof item.role !== "string" ||
      typeof item.launch_ref !== "string" ||
      typeof visibleTo !== "string" ||
      typeof inputPolicy !== "string" ||
      !VISIBILITY_POLICIES.has(visibleTo as ExtensionVisibility) ||
      !INPUT_POLICIES.has(inputPolicy as ExtensionInputPolicy)
    ) {
      return null;
    }
    const capabilities = isRecord(item.capabilities) ? item.capabilities : {};
    surfaces.push({
      surface_id: item.surface_id,
      kind: "browser",
      role: item.role,
      owner_user_id:
        typeof item.owner_user_id === "string" ? item.owner_user_id : null,
      launch_ref: item.launch_ref,
      visible_to: visibleTo as ExtensionVisibility,
      input_policy: inputPolicy as ExtensionInputPolicy,
      layout: isRecord(item.layout) ? item.layout : {},
      capabilities: {
        pointer: capabilities.pointer !== false,
        keyboard: capabilities.keyboard !== false,
        resize: capabilities.resize !== false,
        audio: capabilities.audio === true,
      },
    });
  }
  return surfaces;
}

function normalizeBindings(raw: unknown): ExtensionBinding[] | null {
  if (!Array.isArray(raw)) return null;
  const bindings: ExtensionBinding[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.binding_id !== "string" ||
      typeof item.user_id !== "string" ||
      !Array.isArray(item.surface_ids) ||
      !Array.isArray(item.input_on)
    ) {
      return null;
    }

    const role = item.role;
    if (
      role !== "host" &&
      role !== "admin" &&
      role !== "participant" &&
      role !== "spectator"
    ) {
      return null;
    }

    const surfaceIds = item.surface_ids.filter(
      (value): value is string => typeof value === "string",
    );
    const inputOn = item.input_on.filter(
      (value): value is string => typeof value === "string",
    );
    if (surfaceIds.length !== item.surface_ids.length) return null;
    if (inputOn.length !== item.input_on.length) return null;

    bindings.push({
      binding_id: item.binding_id,
      user_id: item.user_id,
      seat_id: typeof item.seat_id === "string" ? item.seat_id : null,
      role,
      surface_ids: surfaceIds,
      input_on: inputOn,
    });
  }
  return bindings;
}

function normalizeLaunch(
  catalogUrl: string,
  raw: unknown,
): ExtensionLaunchDescriptor | null {
  if (!isRecord(raw) || raw.kind !== "browser_surface") return null;
  const entries = normalizeLaunchEntries(catalogUrl, raw.entries);
  if (!entries) return null;
  return {
    kind: "browser_surface",
    entries,
    args: isRecord(raw.args) ? raw.args : {},
  };
}

function parseExtensionSessionContent(
  content: Record<string, unknown>,
  stateKey: string | undefined,
): ActiveExtension | null {
  if (content.status !== "active") return null;
  if (content.version !== 1) return null;

  const sessionId = typeof content.session_id === "string" ? content.session_id : stateKey;
  const extensionId = typeof content.extension_id === "string" ? content.extension_id : null;
  const hostUserId = typeof content.host_user_id === "string" ? content.host_user_id : null;
  const createdAt = typeof content.created_at === "number" ? content.created_at : null;
  const updatedAt = typeof content.updated_at === "number" ? content.updated_at : createdAt;
  const mode = typeof content.mode === "string" ? content.mode : null;
  const status = typeof content.status === "string" ? content.status : null;

  if (
    !sessionId ||
    !extensionId ||
    !hostUserId ||
    createdAt === null ||
    updatedAt === null ||
    !mode ||
    !status ||
    !SESSION_MODES.has(mode as ExtensionSessionMode) ||
    !SESSION_STATUSES.has(status as ExtensionSessionStatus)
  ) {
    return null;
  }

  if (stateKey && stateKey !== sessionId) return null;

  const catalogRef = isRecord(content.catalog) ? content.catalog : null;
  if (
    !catalogRef ||
    typeof catalogRef.url !== "string" ||
    typeof catalogRef.name !== "string"
  ) {
    return null;
  }

  const catalog = useExtensionStore.getState().catalog;
  const def = catalog.find(
    (entry) => entry.id === extensionId && entry.url === catalogRef.url,
  );
  if (!def) return null;

  const launch = normalizeLaunch(catalogRef.url, content.launch);
  const surfaces = normalizeSurfaces(content.surfaces);
  const bindings = normalizeBindings(content.bindings);
  if (!launch || !surfaces || !bindings) return null;

  const permissionsRecord = isRecord(content.permissions) ? content.permissions : {};
  const metaRecord = isRecord(content.meta) ? content.meta : {};

  return {
    source: "session",
    eventType: EXTENSION_SESSION_EVENT_TYPE,
    stateKey: sessionId,
    sessionId,
    extensionId,
    extensionUrl: catalogRef.url,
    extensionName: catalogRef.name,
    extensionIcon:
      typeof catalogRef.icon === "string" ? catalogRef.icon : def.icon,
    hostUserId,
    startedAt: createdAt,
    updatedAt,
    mode: mode as ExtensionSessionMode,
    status: status as ExtensionSessionStatus,
    launch,
    surfaces,
    bindings,
    permissions: {
      host_can_end: permissionsRecord.host_can_end !== false,
      admins_can_override: permissionsRecord.admins_can_override !== false,
      default_input_policy:
        typeof permissionsRecord.default_input_policy === "string" &&
        INPUT_POLICIES.has(
          permissionsRecord.default_input_policy as ExtensionInputPolicy,
        )
          ? (permissionsRecord.default_input_policy as ExtensionInputPolicy)
          : "host_only",
    },
    meta: {
      title:
        typeof metaRecord.title === "string" ? metaRecord.title : catalogRef.name,
      summary:
        typeof metaRecord.summary === "string"
          ? metaRecord.summary
          : def.description,
    },
  };
}

function parseLegacyExtensionContent(
  content: Record<string, unknown>,
): ActiveExtension | null {
  if (!content.active) return null;
  const extensionId = content.extension_id;
  const extensionUrl = content.extension_url;
  const extensionName = content.extension_name;
  const hostUserId = content.host_user_id;
  const startedAt = content.started_at;
  if (
    typeof extensionId !== "string" ||
    typeof extensionUrl !== "string" ||
    typeof extensionName !== "string" ||
    typeof hostUserId !== "string" ||
    typeof startedAt !== "number"
  ) {
    return null;
  }

  const catalog = useExtensionStore.getState().catalog;
  const def = catalog.find(
    (entry) => entry.id === extensionId && entry.url === extensionUrl,
  );
  if (!def) return null;

  return {
    source: "legacy",
    eventType: LEGACY_EXTENSION_EVENT_TYPE,
    stateKey: LEGACY_EXTENSION_STATE_KEY,
    sessionId: `legacy_${extensionId}_${startedAt}`,
    extensionId,
    extensionUrl,
    extensionName,
    extensionIcon: def.icon,
    hostUserId,
    startedAt,
    updatedAt: startedAt,
    mode: "shared_admin_input",
    status: "active",
    launch: {
      kind: "browser_surface",
      entries: {
        primary: {
          url: extensionUrl,
          allow_origin: "self",
          persist_profile: false,
        },
      },
      args: {},
    },
    surfaces: [
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
    ],
    bindings: [
      {
        binding_id: `bind_${hostUserId}`,
        user_id: hostUserId,
        seat_id: "seat_host",
        role: "host",
        surface_ids: ["surf_shared_main"],
        input_on: ["surf_shared_main"],
      },
    ],
    permissions: {
      host_can_end: true,
      admins_can_override: true,
      default_input_policy: "host_only",
    },
    meta: {
      title: extensionName,
      summary: def.description,
    },
  };
}

/**
 * Syncs extension state from Matrix room state for the given room.
 * Reads the new `com.concord.extension.session` schema first and only
 * falls back to the legacy singleton `com.concord.extension` event if no
 * active session-format state exists.
 */
export function useExtension(roomId: string | null) {
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const activeExtension = useExtensionStore(
    (s) => (roomId ? s.activeExtensions[roomId] : null) ?? null,
  );
  const startExtension = useExtensionStore((s) => s.startExtension);
  const stopExtension = useExtensionStore((s) => s.stopExtension);

  const readState = useCallback(() => {
    if (!client || !roomId) return;
    const room = client.getRoom(roomId);
    if (!room) return;

    const sessionEvents = normalizeStateEvents(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (room.currentState as any)?.getStateEvents?.(EXTENSION_SESSION_EVENT_TYPE),
    )
      .map((event) =>
        parseExtensionSessionContent(
          (event.getContent?.() ?? {}) as Record<string, unknown>,
          event.getStateKey?.(),
        ),
      )
      .filter((event): event is ActiveExtension => !!event)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    if (sessionEvents.length > 0) {
      useExtensionStore.getState().setActiveExtension(roomId, sessionEvents[0]);
      return;
    }

    const legacyStateEvent =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (room.currentState as any)?.getStateEvents?.(
        LEGACY_EXTENSION_EVENT_TYPE,
        LEGACY_EXTENSION_STATE_KEY,
      ) ?? null;

    if (!legacyStateEvent) {
      useExtensionStore.getState().setActiveExtension(roomId, null);
      return;
    }

    const parsed = parseLegacyExtensionContent(
      (legacyStateEvent.getContent?.() ?? {}) as Record<string, unknown>,
    );
    useExtensionStore.getState().setActiveExtension(roomId, parsed);
  }, [client, roomId]);

  useEffect(() => {
    readState();
  }, [readState]);

  useEffect(() => {
    if (!client || !roomId) return;
    const room = client.getRoom(roomId);
    if (!room?.currentState) return;

    const onStateEvent = (event: MatrixEvent) => {
      const eventType = event.getType();
      if (
        eventType === EXTENSION_SESSION_EVENT_TYPE ||
        eventType === LEGACY_EXTENSION_EVENT_TYPE
      ) {
        readState();
      }
    };

    room.currentState.on(RoomStateEvent.Events, onStateEvent);
    return () => {
      room.currentState.removeListener(RoomStateEvent.Events, onStateEvent);
    };
  }, [client, roomId, readState]);

  const isHost = !!(activeExtension && userId && activeExtension.hostUserId === userId);

  return {
    activeExtension,
    isHost,
    startExtension: useCallback(
      (extensionId: string) => {
        if (roomId) return startExtension(roomId, extensionId);
        return Promise.resolve();
      },
      [roomId, startExtension],
    ),
    stopExtension: useCallback(() => {
      if (roomId) return stopExtension(roomId);
      return Promise.resolve();
    }, [roomId, stopExtension]),
  };
}
