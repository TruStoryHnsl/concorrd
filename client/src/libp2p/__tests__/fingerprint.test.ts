/**
 * Browser fingerprint helper tests.
 *
 * Pins the wire-format equality between the TS browser implementation
 * (`fingerprintForHex`) and the native Rust `fingerprint_for` formula
 * in `src-tauri/src/servitude/identity.rs`. The test vector below was
 * computed by hand against the all-zero 32-byte public key and
 * cross-checked against the native algorithm before pinning. If anyone
 * changes the hash, the truncation point, or the base32 alphabet, this
 * test fails loudly and the browser swarm's user-visible identity
 * stops matching native installs' identities.
 */
import { describe, expect, it } from "vitest";
import { fingerprintForHex } from "../fingerprint";

describe("browser libp2p fingerprintForHex", () => {
  /**
   * Test vector: 32 zero bytes as the public key. Same algorithm as
   * `fingerprint_for([0; 32])` in the native build, which produces the
   * first 16 chars of `BASE32-NOPAD-UPPER(SHA-256(zeros))`.
   *
   * The full base32 string for that digest is
   * `MZUHVLPYMK6XO3EPYGFY5H4OEAEJOFEFN3RDHM4QFJMR2DK7FESQ`; truncating
   * to 16 chars yields the expected value below.
   */
  it("matches the native fingerprint_for() for the all-zero public key", async () => {
    const zeroHex = "0".repeat(64);
    const fp = await fingerprintForHex(zeroHex);
    expect(fp).toBe("MZUHVLPYMK6XO3EP");
    expect(fp).toHaveLength(16);
  });

  it("is deterministic (same input → same output)", async () => {
    const hex =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const a = await fingerprintForHex(hex);
    const b = await fingerprintForHex(hex);
    expect(a).toBe(b);
    expect(a).toBe("MMG42KLGYQZWNEIS");
  });

  it("rejects hex strings of the wrong length", async () => {
    await expect(fingerprintForHex("abcd")).rejects.toThrow(
      /must be 64 hex chars/,
    );
  });
});
