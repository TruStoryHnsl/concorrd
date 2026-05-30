/**
 * Phase 9 — browser-side counterpart of the Phase 6 Matrix federation
 * protocol.
 *
 * Speaks `/concord/matrix-federation/1.0.0` over a libp2p stream
 * opened on the browser node. Wire format MUST match the Rust
 * `FederationHandler` in `src-tauri/src/servitude/federation/matrix.rs`:
 *
 *   - 4-byte BIG-ENDIAN length prefix.
 *   - JSON envelope body (UTF-8).
 *   - 16 MiB cap (`MAX_ENVELOPE_BYTES`) — anything larger is rejected
 *     before any allocation happens.
 *
 * `lpStream` from `@libp2p/utils` is intentionally NOT used here: it
 * uses a varint length prefix, but Phase 6 chose a fixed 4-byte BE
 * prefix to match the existing Matrix federation envelope habit
 * across the codebase. Hand-rolled framing keeps the wire format
 * symmetric with the Rust side without forcing the Rust handler to
 * grow a varint decoder.
 *
 * Phase 9 ships the outbound (`sendMatrixRequest`) half — the browser
 * acts as the initiator when federating with a native peer. Inbound
 * stream handling on the browser side (e.g. a native peer dialing
 * the browser back) is registered via `handleInboundMatrixRequest`,
 * which subscribes to `node.handle(...)` and wires each incoming
 * stream to a user-supplied resolver. Production wiring of that
 * resolver lives in Phase 9-follow-up work; the handler is exposed
 * here so tests prove the framing parses correctly in BOTH
 * directions.
 */

import type { Libp2p, PeerId, Stream } from "@libp2p/interface";
import type { Uint8ArrayList } from "uint8arraylist";
import { CONCORD_MATRIX_FEDERATION_PROTOCOL } from "./node";

/**
 * Outbound Matrix request envelope. Mirrors the Rust
 * `MatrixRequest` struct — the keys are snake_case on the wire to
 * match Rust's `#[serde(rename_all = "snake_case")]` default.
 */
export interface MatrixRequest {
  method: string;
  params: Record<string, unknown>;
  request_id: number;
}

/**
 * Inbound Matrix response envelope. Either `result` or `error` is
 * populated; both being absent is treated as a protocol violation by
 * the Rust side and surfaces as a parse failure here.
 */
export interface MatrixResponse {
  request_id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Hard cap on a single envelope, in bytes. MUST match the Rust constant. */
export const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

/**
 * Send a Matrix request to a native peer over libp2p and read the
 * response. Opens a fresh stream per request; the Rust handler closes
 * the stream after a single round-trip.
 *
 * Throws if:
 *   - the request body exceeds `MAX_ENVELOPE_BYTES`,
 *   - the response declares a length larger than `MAX_ENVELOPE_BYTES`,
 *   - the stream closes before either the length prefix or body
 *     finishes arriving.
 */
export async function sendMatrixRequest(
  node: Libp2p,
  peerId: PeerId,
  request: MatrixRequest,
): Promise<MatrixResponse> {
  const stream = await node.dialProtocol(
    peerId,
    CONCORD_MATRIX_FEDERATION_PROTOCOL,
  );
  try {
    const body = new TextEncoder().encode(JSON.stringify(request));
    if (body.length > MAX_ENVELOPE_BYTES) {
      throw new Error(
        `request envelope too large: ${body.length} > ${MAX_ENVELOPE_BYTES}`,
      );
    }
    const framed = frameEnvelope(body);
    // The MessageStream API may return false on backpressure. For a
    // single round-trip request that's almost never going to happen
    // (16 MiB is well under any sensible muxer buffer), so we don't
    // wait for `drain` here — if backpressure does surface, the next
    // send will simply queue, which is fine for a one-shot envelope.
    stream.send(framed);
    const responseBytes = await readLengthPrefixedEnvelope(stream);
    return JSON.parse(new TextDecoder().decode(responseBytes)) as MatrixResponse;
  } finally {
    try {
      await stream.close();
    } catch {
      // Closing twice / closing an already-closed stream is fine.
    }
  }
}

/**
 * Register the browser node as an inbound handler for
 * `/concord/matrix-federation/1.0.0`. The resolver receives the
 * parsed request and returns a response; this module frames + writes
 * the response onto the stream and closes it.
 *
 * Returns an unsubscribe function that removes the handler.
 */
export async function handleInboundMatrixRequest(
  node: Libp2p,
  resolver: (request: MatrixRequest, remotePeerId: PeerId) => Promise<MatrixResponse>,
): Promise<() => Promise<void>> {
  const handler = async (stream: Stream, remote: PeerId): Promise<void> => {
    try {
      const requestBytes = await readLengthPrefixedEnvelope(stream);
      const request = JSON.parse(
        new TextDecoder().decode(requestBytes),
      ) as MatrixRequest;
      const response = await resolver(request, remote);
      const responseBody = new TextEncoder().encode(JSON.stringify(response));
      if (responseBody.length > MAX_ENVELOPE_BYTES) {
        throw new Error(
          `response envelope too large: ${responseBody.length} > ${MAX_ENVELOPE_BYTES}`,
        );
      }
      stream.send(frameEnvelope(responseBody));
    } catch (err) {
      // Don't leak the error into a connection abort — the Rust side
      // tolerates a closed-without-body stream and surfaces its own
      // diagnostic. Logging here is enough for browser-side debug.
      console.debug("[libp2p] inbound matrix-federation handler error", err);
    } finally {
      try {
        await stream.close();
      } catch {
        /* idempotent close */
      }
    }
  };
  // js-libp2p v3 protocol handler signature is `(stream, connection)`
  // not `(stream, peerId)`. We resolve the remote PeerId from the
  // connection here.
  await node.handle(
    CONCORD_MATRIX_FEDERATION_PROTOCOL,
    async (stream, connection) => {
      await handler(stream, connection.remotePeer);
    },
  );
  return async () => {
    await node.unhandle(CONCORD_MATRIX_FEDERATION_PROTOCOL);
  };
}

/**
 * Wrap a JSON body with the 4-byte BE length prefix the Rust handler
 * expects. Exported for tests; production code goes through
 * `sendMatrixRequest` / `handleInboundMatrixRequest`.
 */
export function frameEnvelope(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  const view = new DataView(out.buffer, out.byteOffset, 4);
  view.setUint32(0, body.length, /* littleEndian */ false);
  out.set(body, 4);
  return out;
}

/**
 * Async-iterable reader: pull length-prefixed bytes off a libp2p
 * MessageStream and return the body. Rejects on closure mid-envelope
 * or on an oversized declaration.
 *
 * Exported for tests.
 */
export async function readLengthPrefixedEnvelope(
  source: AsyncIterable<Uint8Array | Uint8ArrayList>,
): Promise<Uint8Array> {
  const collected: number[] = [];
  let len: number | null = null;
  for await (const chunk of source) {
    const bytes = chunkToUint8Array(chunk);
    for (let i = 0; i < bytes.length; i++) collected.push(bytes[i]);
    if (len === null && collected.length >= 4) {
      const lenView = new DataView(Uint8Array.from(collected.slice(0, 4)).buffer);
      len = lenView.getUint32(0, /* littleEndian */ false);
      if (len > MAX_ENVELOPE_BYTES) {
        throw new Error(
          `response envelope too large: ${len} > ${MAX_ENVELOPE_BYTES}`,
        );
      }
    }
    if (len !== null && collected.length >= 4 + len) {
      return Uint8Array.from(collected.slice(4, 4 + len));
    }
  }
  if (len === null) {
    throw new Error("stream closed before length prefix");
  }
  throw new Error("stream closed mid-body");
}

function chunkToUint8Array(chunk: Uint8Array | Uint8ArrayList): Uint8Array {
  // `Uint8ArrayList` exposes a `.subarray()` that materializes a flat
  // `Uint8Array`; plain `Uint8Array` is already what we want.
  if (chunk instanceof Uint8Array) return chunk;
  return chunk.subarray();
}
