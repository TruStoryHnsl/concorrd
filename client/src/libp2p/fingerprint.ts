/**
 * Phase 9 — browser-side fingerprint helper.
 *
 * Mirrors `src-tauri/src/servitude/identity.rs::fingerprint_for` so the
 * docker/web build can display a Phase-2-equivalent short identity for
 * the per-tab ephemeral browser Ed25519 keypair returned by
 * `getBrowserIdentity()`.
 *
 * Algorithm: first 16 chars of `BASE32-NOPAD-UPPER(SHA-256(public_key))`.
 * `public_key` is the raw 32-byte Ed25519 public key, hex-encoded by the
 * browser identity layer; this helper decodes the hex back to bytes,
 * hashes, and base32-encodes. Stable for the lifetime of a public key:
 * same hex input always yields the same fingerprint string.
 *
 * Test vector pinned at `client/src/libp2p/__tests__/fingerprint.test.ts`
 * against the all-zero public key, cross-checked against the Rust
 * implementation manually before pinning.
 */

/**
 * RFC4648 base32 alphabet (uppercase, no padding) — must stay identical
 * to the `ALPHABET` constant in `identity.rs::base32_nopad_upper`. Even
 * a single-character shuffle would silently break cross-build equality.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Number of base32 chars the native side truncates the digest to. */
const FINGERPRINT_LEN = 16;

/**
 * Decode a hex string into a Uint8Array. Strict — rejects anything
 * that isn't an even-length string of `[0-9a-fA-F]`. Pure-stdlib so the
 * helper has zero runtime deps beyond `crypto.subtle` below.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex must have even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("hex contains non-hex characters");
    }
    out[i] = byte;
  }
  return out;
}

/**
 * RFC4648 base32 encode (uppercase alphabet, NO padding). Same bit-
 * packing math as `identity.rs::base32_nopad_upper` — each 5-bit group
 * indexes into the alphabet from the most-significant bit of the byte
 * stream.
 */
function base32NopadUpper(input: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Compute the deterministic short fingerprint for a given public key,
 * matching the native fingerprint formula bit-for-bit.
 *
 * Returns a 16-character base32 string. Stable for the lifetime of the
 * key — identical input always yields identical output.
 *
 * @param publicKeyHex 64-char hex-encoded Ed25519 public key.
 */
export async function fingerprintForHex(publicKeyHex: string): Promise<string> {
  if (publicKeyHex.length !== 64) {
    throw new Error(
      `publicKeyHex must be 64 hex chars (got ${publicKeyHex.length})`,
    );
  }
  const bytes = hexToBytes(publicKeyHex);
  // Browser-native SHA-256 — no extra dep, and identical bytes to what
  // the `sha2` crate produces on the native side. We pass `.buffer`
  // explicitly so the TS lib.dom typings narrow `Uint8Array<ArrayBufferLike>`
  // down to a `BufferSource` the SubtleCrypto API accepts. (Plain
  // `bytes` would type-check fine under default lib.dom but the
  // project's tsconfig enables stricter ArrayBuffer typing.)
  const digestBuffer = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  const digest = new Uint8Array(digestBuffer);
  const encoded = base32NopadUpper(digest);
  return encoded.substring(0, FINGERPRINT_LEN);
}
