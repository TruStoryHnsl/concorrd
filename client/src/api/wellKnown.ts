/**
 * Pluggable server discovery helpers for native Concord apps (INS-027).
 *
 * Native apps (iOS, Android, desktop standalone) don't have a canonical
 * origin the way a browser build does — they need to resolve the correct
 * homeserver and Concord API endpoints for an arbitrary user-entered
 * hostname at first-launch time.
 *
 * This module does that resolution purely over HTTPS by reading two
 * well-known JSON documents published by the target host:
 *
 *   1. `/.well-known/matrix/client` — the standard Matrix client-server
 *      discovery document. Shape: `{"m.homeserver": {"base_url": string},
 *      "m.identity_server"?: {"base_url": string}}`. If this is absent
 *      (HTTP 404), we fall back to `https://<host>` per the Matrix spec's
 *      "NO_SERVER" rule, so any vanilla Matrix homeserver still works.
 *
 *   2. `/.well-known/concord/client` — a Concord-specific extension
 *      document that tells the client where to find the Concord API,
 *      LiveKit SFU, the instance's human-readable name, and an optional
 *      feature list. If this is absent (HTTP 404), we fall back to
 *      `https://<host>/api` for `api_base`, so a plain Matrix homeserver
 *      that doesn't run Concord still gets a sensible default and the
 *      discovery flow completes without erroring.
 *
 * All resolved URLs are validated as well-formed HTTPS; plain `http://`
 * is rejected so downgrade attempts can't tunnel the client onto an
 * insecure endpoint.
 *
 * The error classes below are distinct (rather than a single generic
 * `DiscoveryError`) so the server-picker UI can surface specific,
 * actionable messages per failure mode — "couldn't resolve that host"
 * reads very differently from "that host answered but with garbage".
 *
 * This module is intentionally a pure function of `fetch`. It does NOT
 * touch any Zustand store, does NOT cache, and does NOT mutate global
 * state — those responsibilities belong to the caller (see
 * `serverConfig.ts` + `ServerPickerScreen.tsx`).
 */

/**
 * INS-069 — per-instance branding surfaced via `.well-known/concord/client`.
 *
 * The server-side wire model uses snake_case (`primary_color`,
 * `accent_color`, `logo_url`) while the client-side mirrors it in
 * camelCase to match every other interface in this module's public API.
 * The mapping happens once in {@link discoverHomeserver} so callers
 * never have to think about wire-vs-client casing.
 */
export interface HomeserverBranding {
  /** Six-digit hex string `#rrggbb` — tile's tinted background base. */
  primaryColor: string;
  /** Six-digit hex string `#rrggbb` — tile's accent ring. */
  accentColor: string;
  /** Optional HTTP/HTTPS logo URL. Falls back to the default Source brand icon. */
  logoUrl?: string;
}

/**
 * Fully resolved endpoint configuration for a target Concord instance.
 * Produced by {@link discoverHomeserver}. Serializable — safe to persist
 * in a store or IPC between the main process and UI.
 */
export interface HomeserverConfig {
  /** The raw hostname the user entered (no scheme). */
  host: string;
  /** Matrix homeserver base URL (from `.well-known/matrix/client`). */
  homeserver_url: string;
  /** Canonical Matrix server_name when the deployment advertises one. */
  server_name?: string;
  /** Concord API base URL (from `.well-known/concord/client`, or fallback). */
  api_base: string;
  /** Optional Matrix identity server URL. */
  identity_server_url?: string;
  /** Optional LiveKit signaling URL (wss:// or https://). */
  livekit_url?: string;
  /** Optional human-readable instance name (e.g. "Example Community"). */
  instance_name?: string;
  /** Optional list of advertised feature flags. */
  features?: string[];
  /** Optional STUN/TURN server hints for pre-auth connectivity checks. */
  turn_servers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  /** Optional node role for Concord hosting (e.g. "anchor", "leaf"). */
  node_role?: string;
  /** Whether this instance acts as a tunnel anchor for other nodes. */
  tunnel_anchor?: boolean;
  /**
   * INS-069 — per-instance branding (primary/accent colours + optional logo).
   * Absent when the operator has not configured branding; clients fall
   * back to the default Source tile styling.
   */
  branding?: HomeserverBranding;
}

/** Raised when the target host cannot be reached at all (DNS/network). */
export class DnsResolutionError extends Error {
  constructor(host: string, cause?: unknown) {
    super(`Could not reach ${host} — DNS lookup or network failure`);
    this.name = "DnsResolutionError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Raised when BOTH well-known documents return 404. The fallback path
 * below still produces a valid HomeserverConfig for a vanilla Matrix
 * host, but the caller may want to warn the user that Concord-specific
 * endpoints are missing.
 */
export class HttpNotFoundError extends Error {
  constructor(host: string) {
    super(`No well-known documents found at ${host}`);
    this.name = "HttpNotFoundError";
  }
}

/** Raised when a well-known fetch returns 5xx. */
export class HttpServerError extends Error {
  constructor(host: string, status: number) {
    super(`${host} returned HTTP ${status}`);
    this.name = "HttpServerError";
  }
}

/** Raised when the response body wasn't valid JSON. */
export class JsonParseError extends Error {
  constructor(url: string, cause?: unknown) {
    super(`${url} returned invalid JSON`);
    this.name = "JsonParseError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Raised when a URL parsed from a well-known document is not a valid
 * HTTPS URL. Plain `http://` is rejected to prevent downgrade attacks.
 */
export class InvalidUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Invalid URL ${url}: ${reason}`);
    this.name = "InvalidUrlError";
  }
}

/**
 * Validate a string is a well-formed HTTPS URL. Returns the normalized
 * URL without a trailing slash, or throws {@link InvalidUrlError}.
 */
function assertHttpsUrl(raw: unknown, sourceLabel: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InvalidUrlError(String(raw), `${sourceLabel} is not a string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidUrlError(raw, `${sourceLabel} is not a parsable URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidUrlError(
      raw,
      `${sourceLabel} must use https:// (got ${parsed.protocol})`,
    );
  }
  // Strip trailing slash for canonical form — makes string equality
  // checks and persisted values stable across discovery calls.
  return raw.replace(/\/+$/, "");
}

/**
 * Shape of `.well-known/matrix/client`. Only the fields we actually
 * consume are listed; unknown keys are ignored per spec.
 */
interface MatrixClientWellKnown {
  "m.homeserver"?: { base_url?: string; server_name?: string };
  "m.identity_server"?: { base_url?: string };
}

/**
 * Shape of `.well-known/concord/client`. All fields are optional on the
 * wire — the helper fills in fallbacks where the wire is silent.
 */
interface ConcordClientWellKnown {
  api_base?: string;
  livekit_url?: string;
  instance_name?: string;
  features?: string[];
  turn_servers?: Array<{ urls: string | string[] }>;
  node_role?: unknown;
  tunnel_anchor?: unknown;
  /**
   * INS-069 — server-side wire shape (snake_case). Mapped to
   * camelCase {@link HomeserverBranding} during parse.
   */
  branding?: {
    primary_color?: unknown;
    accent_color?: unknown;
    logo_url?: unknown;
  } | null;
}

/**
 * Validate a hex colour string (six-digit `#rrggbb`) — the same
 * pattern the server enforces. Defensive: the wire is supposed to be
 * pre-validated, but accepting whatever the server claims and shoving
 * it into an inline-style attribute is a recipe for silent corruption
 * if anyone ever ships an unvalidated branding write path.
 */
function isHexColor(raw: unknown): raw is string {
  return typeof raw === "string" && /^#[0-9A-Fa-f]{6}$/.test(raw);
}

interface ElementWebConfig {
  default_server_config?: MatrixClientWellKnown;
}

/**
 * Result of trying to read one well-known document: either a parsed
 * body, or a sentinel telling the caller that the doc was absent (404)
 * so it should fall back to defaults rather than erroring.
 */
type WellKnownResult<T> =
  | { status: "ok"; body: T }
  | { status: "absent" };

/**
 * Fetch and parse a well-known JSON document. Distinct error classes
 * are thrown for each failure mode so the UI can render targeted
 * messages.
 */
async function fetchWellKnown<T>(
  host: string,
  path: string,
  label: string,
): Promise<WellKnownResult<T>> {
  const url = `https://${host}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      // Well-known docs are public and small — cache defaults are fine,
      // but explicitly no credentials so we never leak cookies cross-host.
      credentials: "omit",
      redirect: "follow",
    });
  } catch (err) {
    // `fetch` throws a TypeError for network-level failures (DNS,
    // connection refused, abort). We treat all of these as "host
    // unreachable" rather than trying to distinguish sub-cases that
    // don't exist at the DOM fetch layer.
    console.error(`[wellKnown] fetch failed for ${url}:`, err);
    throw new DnsResolutionError(host, err);
  }

  if (response.status === 404) {
    return { status: "absent" };
  }
  if (response.status >= 500) {
    throw new HttpServerError(host, response.status);
  }
  if (!response.ok) {
    // 4xx other than 404 — treat as absent rather than error. A host
    // that returns 403 or 401 on a public discovery document is
    // misconfigured, but that's recoverable via fallback.
    return { status: "absent" };
  }

  // Guard: if the server returned HTML (e.g. SPA fallback) instead of
  // JSON, treat it as absent rather than crashing on JSON.parse.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return { status: "absent" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new JsonParseError(`${label} at ${url}`, err);
  }
  if (body === null || typeof body !== "object") {
    throw new JsonParseError(
      `${label} at ${url}`,
      new Error("top-level JSON value is not an object"),
    );
  }
  return { status: "ok", body: body as T };
}

/**
 * Discover the homeserver + Concord API endpoints for `host`.
 *
 * @param host User-entered hostname, no scheme prefix (e.g. `chat.example.com`).
 * @returns A fully-populated {@link HomeserverConfig}.
 *
 * @throws {@link DnsResolutionError} if the host cannot be reached at all.
 * @throws {@link HttpServerError} if a well-known returned 5xx.
 * @throws {@link JsonParseError} if a well-known body isn't valid JSON.
 * @throws {@link InvalidUrlError} if any resolved URL is not HTTPS.
 * @throws {@link HttpNotFoundError} if BOTH well-knowns returned 404.
 *   Note the fallback path is still produced before this throws —
 *   callers that want to tolerate missing well-knowns should NOT
 *   rely on this error being raised; it's only for diagnostic use.
 *   The current implementation does NOT throw this because the
 *   fallback path is fully specified by the spec — see the comment
 *   in-body.
 */
export async function discoverHomeserver(
  host: string,
): Promise<HomeserverConfig> {
  const trimmed = host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new InvalidUrlError(host, "hostname is empty");
  }

  // Validate hostname shape — must be a parsable URL host component.
  // We construct `https://<host>` and read back `.host` so the URL
  // parser handles port suffixes, IDN, etc.
  let canonicalHost: string;
  try {
    canonicalHost = new URL(`https://${trimmed}`).host;
  } catch {
    throw new InvalidUrlError(trimmed, "hostname is not well-formed");
  }
  if (!canonicalHost) {
    throw new InvalidUrlError(trimmed, "hostname is empty after parsing");
  }

  // Run both discovery fetches in parallel. The matrix well-known is
  // the critical path; the concord well-known is optional (provides
  // api_base, livekit_url, etc. but we can fall back without it).
  // Use Promise.allSettled so a CORS or network failure on one
  // endpoint doesn't kill the other — WebKitGTK on Linux blocks
  // cross-origin responses that lack Access-Control-Allow-Origin,
  // which is common for the concord well-known on deployments that
  // only add CORS to the matrix well-known inline response.
  const [matrixSettled, concordSettled, elementConfigSettled] = await Promise.allSettled([
    fetchWellKnown<MatrixClientWellKnown>(
      canonicalHost,
      "/.well-known/matrix/client",
      "matrix/client",
    ),
    fetchWellKnown<ConcordClientWellKnown>(
      canonicalHost,
      "/.well-known/concord/client",
      "concord/client",
    ),
    fetchWellKnown<ElementWebConfig>(
      canonicalHost,
      "/config.json",
      "element-web config",
    ),
  ]);

  // If the matrix well-known itself failed at the network level,
  // propagate that — the host is genuinely unreachable.
  if (matrixSettled.status === "rejected") {
    throw matrixSettled.reason;
  }
  const matrixResult = matrixSettled.value;

  // Concord well-known failures (CORS, network, etc.) are non-fatal —
  // treat as absent and fall back to defaults.
  const concordResult: WellKnownResult<ConcordClientWellKnown> =
    concordSettled.status === "fulfilled"
      ? concordSettled.value
      : { status: "absent" };
  const elementConfigResult: WellKnownResult<ElementWebConfig> =
    elementConfigSettled.status === "fulfilled"
      ? elementConfigSettled.value
      : { status: "absent" };

  // ---------------------------------------------------------------
  // Matrix homeserver URL resolution
  // ---------------------------------------------------------------
  // Per spec, if `.well-known/matrix/client` is absent, fall back to
  // `https://<host>` as the homeserver base URL. If present, the
  // `m.homeserver.base_url` field is REQUIRED — a present-but-malformed
  // well-known is a hard error, not something we silently ignore.
  const matrixConfig =
    matrixResult.status === "ok"
      ? matrixResult.body
      : elementConfigResult.status === "ok"
        ? elementConfigResult.body.default_server_config
        : undefined;
  let homeserverUrl: string;
  let identityServerUrl: string | undefined;
  let serverName: string | undefined;
  if (matrixConfig) {
    const raw = matrixConfig["m.homeserver"]?.base_url;
    if (raw === undefined) {
      // Present but missing the required field → treat as fallback.
      // This is the safest reading of the spec: a half-filled document
      // is effectively "no hint at all".
      homeserverUrl = assertHttpsUrl(
        `https://${canonicalHost}`,
        "homeserver fallback",
      );
    } else {
      homeserverUrl = assertHttpsUrl(raw, "m.homeserver.base_url");
    }
    const advertisedServerName = matrixConfig["m.homeserver"]?.server_name;
    if (typeof advertisedServerName === "string" && advertisedServerName.length > 0) {
      serverName = advertisedServerName.trim().toLowerCase();
    }
    const idRaw = matrixConfig["m.identity_server"]?.base_url;
    if (idRaw !== undefined) {
      identityServerUrl = assertHttpsUrl(idRaw, "m.identity_server.base_url");
    }
  } else {
    homeserverUrl = assertHttpsUrl(
      `https://${canonicalHost}`,
      "homeserver fallback",
    );
  }

  // ---------------------------------------------------------------
  // Concord API base resolution
  // ---------------------------------------------------------------
  // If the Concord well-known is absent (vanilla Matrix homeserver),
  // fall back to `https://<host>/api`. This keeps the helper
  // backwards-compatible with the standard deployment topology where
  // Caddy routes `/api/*` to the Concord container.
  let apiBase: string;
  let livekitUrl: string | undefined;
  let instanceName: string | undefined;
  let features: string[] | undefined;
  let turnServers: HomeserverConfig["turn_servers"] | undefined;
  let nodeRole: string | undefined;
  let tunnelAnchor: boolean | undefined;
  let branding: HomeserverBranding | undefined;
  if (concordResult.status === "ok") {
    const body = concordResult.body;
    if (typeof body.api_base === "string" && body.api_base.length > 0) {
      apiBase = assertHttpsUrl(body.api_base, "api_base");
    } else {
      apiBase = assertHttpsUrl(
        `https://${canonicalHost}/api`,
        "api_base fallback",
      );
    }
    if (typeof body.livekit_url === "string" && body.livekit_url.length > 0) {
      // LiveKit URLs may be wss://, not https://. Validate separately.
      let parsed: URL;
      try {
        parsed = new URL(body.livekit_url);
      } catch {
        throw new InvalidUrlError(body.livekit_url, "livekit_url is not a parsable URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") {
        throw new InvalidUrlError(
          body.livekit_url,
          `livekit_url must use https:// or wss:// (got ${parsed.protocol})`,
        );
      }
      livekitUrl = body.livekit_url.replace(/\/+$/, "");
    }
    if (typeof body.instance_name === "string" && body.instance_name.length > 0) {
      instanceName = body.instance_name;
    }
    if (Array.isArray(body.features)) {
      // Defensive copy; reject non-string entries rather than silently
      // coerce them, to catch well-known authoring bugs early.
      features = body.features.filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      );
    }
    if (Array.isArray(body.turn_servers)) {
      turnServers = body.turn_servers.filter(
        (s): s is { urls: string | string[] } =>
          s !== null && typeof s === "object" && "urls" in s,
      );
    }
    if (
      typeof body.node_role === "string" &&
      ["anchor", "leaf", "hybrid"].includes(body.node_role)
    ) {
      nodeRole = body.node_role;
    }
    if (typeof body.tunnel_anchor === "boolean") {
      tunnelAnchor = body.tunnel_anchor;
    }
    // INS-069 — per-instance branding. Server pre-validates, but we
    // re-check the hex pattern on the way in so bad upstream values
    // can never leak into a CSS-injected inline style.
    if (body.branding && typeof body.branding === "object") {
      const b = body.branding;
      if (isHexColor(b.primary_color) && isHexColor(b.accent_color)) {
        const logoRaw = b.logo_url;
        const logo =
          typeof logoRaw === "string" && /^https?:\/\/.+/.test(logoRaw)
            ? logoRaw
            : undefined;
        branding = {
          primaryColor: b.primary_color,
          accentColor: b.accent_color,
          logoUrl: logo,
        };
      }
    }
  } else {
    apiBase = assertHttpsUrl(
      `https://${canonicalHost}/api`,
      "api_base fallback",
    );
  }

  return {
    host: canonicalHost,
    homeserver_url: homeserverUrl,
    server_name: serverName,
    api_base: apiBase,
    identity_server_url: identityServerUrl,
    livekit_url: livekitUrl,
    instance_name: instanceName,
    features,
    turn_servers: turnServers,
    node_role: nodeRole,
    tunnel_anchor: tunnelAnchor,
    branding,
  };
}
