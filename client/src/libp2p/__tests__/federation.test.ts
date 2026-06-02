/**
 * Phase 9 — `federation.ts` framing tests.
 *
 * Verifies the wire format the Rust Phase 6 handler expects on the
 * `/concord/matrix-federation/1.0.0` protocol:
 *
 *   - 4-byte BIG-ENDIAN length prefix.
 *   - JSON envelope body.
 *   - 16 MiB cap.
 *
 * No real libp2p swarm is spun up; tests assert against the framing
 * helpers directly + an in-memory async-iterable mock. Real wire
 * round-trips are covered by the Rust integration tests (Phase 6)
 * and the Phase 9 follow-up Playwright session.
 */
import { describe, expect, it } from "vitest";
import {
  frameEnvelope,
  readLengthPrefixedEnvelope,
  MAX_ENVELOPE_BYTES,
} from "../federation";

function asyncIterableOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
      };
    },
  };
}

describe("federation framing", () => {
  it("frameEnvelope writes a 4-byte big-endian length prefix followed by the body", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ method: "ping", params: {}, request_id: 42 }),
    );
    const framed = frameEnvelope(body);
    expect(framed.length).toBe(4 + body.length);
    const view = new DataView(
      framed.buffer,
      framed.byteOffset,
      framed.byteLength,
    );
    expect(view.getUint32(0, /* littleEndian */ false)).toBe(body.length);
    // The remaining bytes must be the body verbatim. Compare as plain
    // arrays so vitest's deep-equality doesn't trip on TypedArray
    // buffer-offset metadata.
    expect(Array.from(framed.slice(4))).toEqual(Array.from(body));
  });

  it("readLengthPrefixedEnvelope parses a single-chunk envelope correctly", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ request_id: 7, result: { ok: true } }),
    );
    const framed = frameEnvelope(payload);
    const body = await readLengthPrefixedEnvelope(asyncIterableOf(framed));
    const decoded = JSON.parse(new TextDecoder().decode(body));
    expect(decoded).toEqual({ request_id: 7, result: { ok: true } });
  });

  it("readLengthPrefixedEnvelope tolerates a length prefix split across chunks", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ request_id: 9, result: { value: "split" } }),
    );
    const framed = frameEnvelope(payload);
    // Chunk boundary lands inside the length prefix.
    const a = framed.slice(0, 2);
    const b = framed.slice(2, 6);
    const c = framed.slice(6);
    const body = await readLengthPrefixedEnvelope(asyncIterableOf(a, b, c));
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      request_id: 9,
      result: { value: "split" },
    });
  });

  it("readLengthPrefixedEnvelope rejects an oversized declared length", async () => {
    // Hand-craft a length prefix that declares (cap + 1) bytes — the
    // body never has to actually exist; the read must fail at the
    // length-check step.
    const lenPrefix = new Uint8Array(4);
    new DataView(lenPrefix.buffer).setUint32(0, MAX_ENVELOPE_BYTES + 1, false);
    await expect(
      readLengthPrefixedEnvelope(asyncIterableOf(lenPrefix)),
    ).rejects.toThrow(/too large/);
  });
});
