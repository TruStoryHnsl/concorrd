/**
 * Address-kind detection for the unified create-server flow (Feature F2).
 *
 * One field in the AddSourceModal — "what's the address of the place?" —
 * accepts any of:
 *
 *   - A bare hostname (`matrix.org`, `chat.mozilla.org`, `chat.example.com`).
 *   - A `concord://peer/<base64url>` peer-card deeplink.
 *   - A `concord+pair://v1/?d=<base64url>` host-pairing URL.
 *   - A bare libp2p multiaddr (`/ip4/.../tcp/.../p2p/...`, `/dns4/.../...`).
 *   - A bare libp2p peer id (52+ base58 chars beginning with `Qm`/`12D`).
 *
 * The detection routine inspects the input shape first (cheap, zero
 * network), and only when the input looks like a plain hostname does it
 * issue parallel HTTPS probes for `/.well-known/matrix/client` and
 * `/.well-known/concord/client`. Precedence on a successful probe:
 *
 *   1. Concord HTTP — well-known/concord/client present → Concord
 *      federation source. Matches the "user typed their instance
 *      domain" intent; the Matrix homeserver is still reachable
 *      through the resulting source's `homeserverUrl`.
 *   2. Matrix only  — well-known/matrix/client present but no
 *      well-known/concord/client → Matrix homeserver login flow.
 *   3. Neither      — both probes 404. Caller must fall back to a
 *      manual "pick the protocol" affordance.
 *
 * The function is intentionally a pure async helper: it does not touch
 * any Zustand store, does not write to history, and does not log
 * persistent telemetry. The caller is responsible for routing the
 * resulting verdict into the correct screen of the AddSourceModal.
 *
 * Pure detection ⇒ trivially mockable via `globalThis.fetch`. Tests at
 * `client/src/lib/__tests__/detectAddress.test.ts` cover every branch.
 */

/**
 * Verdict returned by {@link detectAddressKind}. The `kind` discriminator
 * tells the modal which sub-flow to render; the optional fields carry
 * the parsed handle so the caller doesn't have to re-extract it.
 */
export type AddressKind =
  | {
      /** Concord HTTP federation source — `.well-known/concord/client` resolved. */
      kind: "concord-http";
      /** Canonical hostname (no scheme, no trailing slash). */
      host: string;
    }
  | {
      /** Matrix homeserver — `.well-known/matrix/client` resolved, no Concord. */
      kind: "matrix";
      /** Canonical hostname (no scheme, no trailing slash). */
      host: string;
    }
  | {
      /**
       * libp2p peer pairing payload — peer-card deeplink, pairing URL,
       * multiaddr, or bare peer id. The exact sub-shape is identified by
       * `subkind`; the modal routes all of them through the
       * `PeerCardScanner` paste path which already handles them.
       */
      kind: "concord-p2p";
      subkind:
        | "peer-card-deeplink"
        | "pair-url"
        | "multiaddr"
        | "peer-id";
      /** The trimmed input as the user typed it. */
      raw: string;
    }
  | {
      /** Both well-knowns 404'd. Caller falls back to the manual picker. */
      kind: "unknown";
      /** Canonical hostname (no scheme) so the manual picker can prefill it. */
      host: string;
      /**
       * Human-readable summary of what was tried. Surfaced as the
       * error body on the manual-fallback screen.
       */
      detail: string;
    }
  | {
      /**
       * The user typed gibberish that doesn't parse as any of the
       * known address shapes. Distinct from `unknown` (which means
       * "we probed a real host but got nothing"): this is a static
       * rejection. UI can show "doesn't look like an address" without
       * having issued any network calls.
       */
      kind: "invalid";
      detail: string;
    };

/**
 * Progress phase emitted by {@link detectAddressKind} via the optional
 * `onProgress` callback so the UI can render a contextual subtitle
 * during the detection round-trip (e.g. "Detecting Matrix..."). Phases
 * fire as the detector enters each probe stage; the final verdict is
 * the function return value, NOT a progress event.
 */
export type DetectPhase =
  | "inspect"
  | "probe-concord"
  | "probe-matrix";

/** Public detection options. `fetcher` exists for tests. */
export interface DetectAddressOptions {
  /** Called whenever the detector advances to a new probe phase. */
  onProgress?: (phase: DetectPhase) => void;
  /** Overrideable fetch implementation. Defaults to `globalThis.fetch`. */
  fetcher?: typeof fetch;
  /**
   * Per-probe timeout in ms. Each well-known probe is aborted after
   * this many ms so a slow host doesn't hang the modal indefinitely.
   * Default: 5000ms.
   */
  probeTimeoutMs?: number;
}

/**
 * Identifier patterns for the p2p / peer-pairing payloads. Order is
 * relevant: a `concord://peer/...` URL also matches the bare-scheme
 * `concord://` test, so the more specific pattern is checked first.
 */
const PEER_CARD_DEEPLINK_PREFIX = "concord://peer/";
const PAIR_URL_PREFIX = "concord+pair://";

/**
 * Detect whether a string looks like a libp2p multiaddr. We do not
 * fully parse it — that's done downstream by `@multiformats/multiaddr`
 * inside the pairing flow. We just need to recognize the shape so the
 * unified flow knows to route to the peer flow rather than try to
 * probe HTTPS well-knowns against `/ip4/...`.
 */
function looksLikeMultiaddr(input: string): boolean {
  // Multiaddrs always start with a transport tag followed by `/`. The
  // common forms are `/ip4/`, `/ip6/`, `/dns/`, `/dns4/`, `/dns6/`, or
  // `/unix/`. We anchor to the leading slash because a bare hostname
  // never begins with one.
  return /^\/(ip4|ip6|dns|dns4|dns6|unix)\//.test(input);
}

/**
 * Detect whether a string looks like a bare libp2p peer id. Multihash
 * peer ids are base58btc-encoded; legacy SHA-256 ids start with `Qm`
 * (46 chars), Ed25519 peer ids start with `12D3KooW` (52 chars). The
 * test is conservative — it rejects anything containing a `/` (so
 * multiaddrs land in the multiaddr branch) and anything outside the
 * base58 alphabet.
 *
 * We don't try to validate the multihash itself; downstream code
 * does that.
 */
function looksLikePeerId(input: string): boolean {
  if (input.includes("/") || input.includes("\\")) return false;
  // base58btc alphabet: 1-9, A-H, J-N, P-Z, a-k, m-z (no `0`, `O`, `I`, `l`).
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(input)) return false;
  // 46 = Qm... SHA-256, 52 = 12D3KooW... Ed25519. Allow either length
  // class to keep the detector forward-compatible with new key types
  // that share the base58 envelope.
  return input.length >= 46;
}

/**
 * Heuristic hostname check — a domain-shaped string with at least one
 * `.` separator, no whitespace, no slashes (other than a possible
 * scheme prefix stripped earlier), and no path component.
 *
 * Edge cases handled:
 *  - Strips `http://` / `https://` prefixes before testing.
 *  - Strips a trailing path (`example.com/foo` → `example.com`).
 *  - Rejects bare-IPv4 (`192.168.1.10`) — well-known probes against
 *    a numeric host are almost never what the user wants in the
 *    unified flow; they should use the multiaddr or peer-id branch
 *    instead.
 *
 * Returns the canonical hostname or `null` if it doesn't look like a
 * hostname.
 */
function tryHostname(input: string): string | null {
  // Drop scheme + trailing slash.
  const stripped = input.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // Take only the host portion if a path was included.
  const hostOnly = stripped.split("/")[0];
  if (!hostOnly) return null;
  // Reject if it contains characters that can't legally appear in a
  // hostname (whitespace, query chars, etc.).
  if (/[\s?#@]/.test(hostOnly)) return null;
  // Reject bare IPv4.
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(hostOnly)) return null;
  // Must contain at least one `.`-separated label and end with a
  // letter (TLD). A single label like `localhost` is intentionally
  // rejected — the unified flow targets public addresses; localhost
  // hosting goes through the LocalHostingControl entry point above
  // the picker.
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?$/.test(hostOnly)) return null;
  return hostOnly.toLowerCase();
}

/**
 * Probe a single well-known endpoint. Returns:
 *   - `present` when the document was served with 2xx and JSON-ish
 *     content type (the body isn't inspected; presence is the signal).
 *   - `absent` for 404, 5xx, CORS, or any non-JSON / network failure.
 *
 * Deliberately tolerant of failure: this routine is a detection
 * heuristic, not the full discoverer (that work happens downstream in
 * `discoverHomeserver` once we know which protocol to use).
 */
async function probeWellKnown(
  fetcher: typeof fetch,
  host: string,
  path: string,
  timeoutMs: number,
): Promise<"present" | "absent"> {
  const url = `https://${host}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      credentials: "omit",
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) return "absent";
    // Don't be picky about the exact content type — `application/json`
    // is the spec, but plenty of misconfigured deployments return
    // `text/plain` for the JSON document. We only refuse when the body
    // is clearly HTML (an SPA 200-fallback), since that's a
    // false-positive for "the well-known is present".
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) return "absent";
    return "present";
  } catch {
    return "absent";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the detection routine against an arbitrary user-typed string.
 * See the module-level doc for the ordering and precedence rules.
 *
 * The function is exhaustive in its return type — callers can switch
 * on `kind` and TypeScript will narrow the additional fields.
 */
export async function detectAddressKind(
  rawInput: string,
  options: DetectAddressOptions = {},
): Promise<AddressKind> {
  const {
    onProgress,
    fetcher = globalThis.fetch.bind(globalThis),
    probeTimeoutMs = 5000,
  } = options;

  const input = rawInput.trim();
  if (input.length === 0) {
    return { kind: "invalid", detail: "Address is empty." };
  }

  onProgress?.("inspect");

  // Cheap shape checks — every branch below returns before any network
  // call. Concord-specific peer schemes win over hostname parsing
  // because `concord://peer/...` and `concord+pair://...` both contain
  // a `.`-shaped tail and would otherwise accidentally satisfy the
  // hostname regex when stripped.
  if (input.startsWith(PEER_CARD_DEEPLINK_PREFIX)) {
    return { kind: "concord-p2p", subkind: "peer-card-deeplink", raw: input };
  }
  if (input.startsWith(PAIR_URL_PREFIX)) {
    return { kind: "concord-p2p", subkind: "pair-url", raw: input };
  }
  if (looksLikeMultiaddr(input)) {
    return { kind: "concord-p2p", subkind: "multiaddr", raw: input };
  }
  if (looksLikePeerId(input)) {
    return { kind: "concord-p2p", subkind: "peer-id", raw: input };
  }

  const host = tryHostname(input);
  if (!host) {
    return {
      kind: "invalid",
      detail:
        "Doesn't look like a hostname, peer link, or multiaddr. Try `chat.example.com` or paste a `concord://` link.",
    };
  }

  // Network phase. Run both probes in parallel so an unresponsive
  // endpoint never doubles the total wait time. The precedence rule
  // (Concord HTTP wins when both are present) is enforced by reading
  // the Concord result first.
  onProgress?.("probe-concord");
  const concordPromise = probeWellKnown(
    fetcher,
    host,
    "/.well-known/concord/client",
    probeTimeoutMs,
  );
  onProgress?.("probe-matrix");
  const matrixPromise = probeWellKnown(
    fetcher,
    host,
    "/.well-known/matrix/client",
    probeTimeoutMs,
  );
  const [concordResult, matrixResult] = await Promise.all([
    concordPromise,
    matrixPromise,
  ]);

  if (concordResult === "present") return { kind: "concord-http", host };
  if (matrixResult === "present") return { kind: "matrix", host };

  return {
    kind: "unknown",
    host,
    detail:
      `No Concord or Matrix well-known endpoint at ${host}. ` +
      `Pick the protocol manually below, or double-check the address.`,
  };
}
