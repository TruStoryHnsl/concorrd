/**
 * Peer-card encode/decode (Phase 5 — peer pairing).
 *
 * A peer card is the public-only triple `{ peerId, publicKeyHex,
 * multiaddrs[] }` — everything another install needs to dial this one
 * over libp2p. The encoded form is:
 *
 *     concord://peer/<base64url-of-JSON>
 *
 * That same URL is both the QR payload and the deeplink — the QR is just
 * a transport for the URL. The Tauri-side deeplink handler in
 * `src-tauri/src/lib.rs` (Wave 1) parses the same shape on inbound URL
 * open events.
 *
 * Validation: the decoder NEVER throws on malformed input — it returns a
 * discriminated union (`{ ok: true; card }` or `{ ok: false; error }`).
 * The UI consumes this and surfaces the error string verbatim. Throwing
 * here would force every call site to wrap in try/catch and the React
 * tree would surface unhelpful "Uncaught (in promise)" warnings.
 */

const SCHEME = "concord://peer/";

/** Public-only peer card shape. Must stay structurally identical to
 *  `PeerCard` in `../api/peerStore.ts` — duplicated here to avoid an
 *  import cycle between the API and lib layers. */
export interface PeerCard {
  peerId: string;
  publicKeyHex: string;
  multiaddrs: string[];
}

/** Discriminated-union result type for the decoder. */
export type DecodeResult =
  | { ok: true; card: PeerCard }
  | { ok: false; error: string };

/**
 * base64url encode (RFC 4648 §5 — no padding, `-_` instead of `+/`).
 * Small inline helper rather than pulling `js-base64` because the input
 * is a JSON string in our control and the size never matters here.
 */
function base64urlEncode(text: string): string {
  // `btoa` is ASCII-only — convert UTF-8 to a byte string first via
  // TextEncoder so non-ASCII multiaddrs (theoretically rare but
  // syntactically possible in IPv6 zone IDs) round-trip cleanly.
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * base64url decode. Throws on malformed input — wrapped by the caller
 * so the public decoder returns a discriminated union.
 */
function base64urlDecode(text: string): string {
  let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a peer card into its `concord://peer/<base64url>` deeplink form.
 * The JSON shape uses the same camelCase keys as the rest of the TS
 * surface — Wave 1's deeplink handler accepts both camelCase
 * (`peerId` / `publicKeyHex`) and snake_case (`peer_id` /
 * `public_key_hex`) on the wire, so this form is safe both for our own
 * scanner and for the native deeplink path.
 */
export function encodeToDeeplink(card: PeerCard): string {
  // Only encode the three documented fields — explicit object literal
  // (NOT a spread of `card`) so we don't accidentally leak any extra
  // properties a caller might have attached to the input object.
  const payload = JSON.stringify({
    peerId: card.peerId,
    publicKeyHex: card.publicKeyHex,
    multiaddrs: card.multiaddrs,
  });
  return SCHEME + base64urlEncode(payload);
}

/**
 * Validate that a parsed JSON object is structurally a peer card.
 * Returns the validated card on success, or an error string on failure.
 */
function validateCard(
  parsed: unknown,
): { ok: true; card: PeerCard } | { ok: false; error: string } {
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: "payload is not an object" };
  }
  const obj = parsed as Record<string, unknown>;

  const peerId = obj.peerId;
  if (typeof peerId !== "string" || peerId.length === 0) {
    return { ok: false, error: "peerId missing or empty" };
  }

  const publicKeyHex = obj.publicKeyHex;
  if (typeof publicKeyHex !== "string") {
    return { ok: false, error: "publicKeyHex missing" };
  }
  // Ed25519 public keys are 32 bytes → 64 hex chars exactly. Same check
  // the Rust side enforces in `peer_store.rs::validate`.
  if (publicKeyHex.length !== 64) {
    return {
      ok: false,
      error: `publicKeyHex must be 64 hex chars (got ${publicKeyHex.length})`,
    };
  }
  if (!/^[0-9a-fA-F]+$/.test(publicKeyHex)) {
    return { ok: false, error: "publicKeyHex must be hexadecimal" };
  }

  const multiaddrs = obj.multiaddrs;
  if (!Array.isArray(multiaddrs)) {
    return { ok: false, error: "multiaddrs missing or not an array" };
  }
  if (multiaddrs.length === 0) {
    return { ok: false, error: "multiaddrs must not be empty" };
  }
  for (const addr of multiaddrs) {
    if (typeof addr !== "string" || addr.length === 0) {
      return { ok: false, error: "multiaddrs must be non-empty strings" };
    }
  }

  // Explicit field-by-field copy — defence-in-depth against extra
  // properties on the parsed JSON. The same pattern as the API wrapper.
  return {
    ok: true,
    card: {
      peerId,
      publicKeyHex,
      multiaddrs: multiaddrs.slice(),
    },
  };
}

/**
 * Decode a `concord://peer/<base64url>` URL into a peer card. Never
 * throws — returns a discriminated union. Callers should branch on
 * `result.ok` and surface `result.error` directly in the UI.
 */
export function decodeFromDeeplink(url: string): DecodeResult {
  if (typeof url !== "string") {
    return { ok: false, error: "input is not a string" };
  }
  if (!url.startsWith(SCHEME)) {
    return { ok: false, error: `URL must start with '${SCHEME}'` };
  }
  const tail = url.slice(SCHEME.length);
  if (tail.length === 0) {
    return { ok: false, error: "URL has no payload" };
  }

  let json: string;
  try {
    json = base64urlDecode(tail);
  } catch {
    return { ok: false, error: "payload is not valid base64url" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "payload is not valid JSON" };
  }

  return validateCard(parsed);
}

/**
 * Encode a peer card into the QR payload form. The QR text is the same
 * `concord://peer/...` URL the deeplink handler accepts — keeping a
 * single canonical form means a QR scan and an OS-level URL open dispatch
 * through identical decode logic.
 */
export function encodeToQrPayload(card: PeerCard): string {
  return encodeToDeeplink(card);
}

/**
 * Decode a QR scan result. Identical to `decodeFromDeeplink` — the
 * separate name is purely for caller-side readability so a scanner
 * component doesn't have to import a "deeplink" helper to handle its
 * QR payload.
 */
export function decodeFromQrPayload(text: string): DecodeResult {
  return decodeFromDeeplink(text);
}
