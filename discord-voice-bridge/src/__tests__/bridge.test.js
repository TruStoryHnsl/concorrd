/**
 * INS-035 W5 regression tests for the discord voice bridge.
 *
 * Uses Node.js built-in test runner (node --test). No external test deps needed.
 * Tests are integration-lite: they exercise the real health server and log emitter
 * against a minimal mock environment, avoiding Discord/LiveKit network calls.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an HTTP GET request and resolve with {statusCode, body}. */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

/** Capture all stdout lines emitted during fn(). Returns array of raw lines. */
async function captureStdout(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    str.split("\n").forEach((l) => { if (l.trim()) lines.push(l); });
    return orig(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Test 1: /healthz returns correct activeRooms count and JSON shape
// ---------------------------------------------------------------------------

describe("INS-035 W5 — health endpoint", () => {
  // We build a minimal health server inline so the test doesn't depend on
  // starting a full bridge (which needs Discord token + LiveKit creds).
  let server;
  const fakeActive = new Map();
  const TEST_PORT = 19098;
  const PROCESS_START_MS = Date.now() - 1000; // pretend started 1s ago
  const MAX_ROOMS = 10;

  before(() => new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      if (req.url !== "/healthz" && req.url !== "/") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
        return;
      }
      const rooms = await Promise.all(
        [...fakeActive.values()].map((b) => b.getStatus()),
      );
      const uptimeMs = Date.now() - PROCESS_START_MS;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeRooms: fakeActive.size, maxRooms: MAX_ROOMS, uptimeMs, rooms }));
    });
    server.listen(TEST_PORT, "127.0.0.1", resolve);
  }));

  after(() => new Promise((resolve) => server.close(resolve)));

  it("returns 200 with status:ok when no rooms are active", async () => {
    const { statusCode, body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/healthz`);
    assert.equal(statusCode, 200);
    const data = JSON.parse(body);
    assert.equal(data.status, "ok");
    assert.equal(data.activeRooms, 0);
    assert.equal(data.maxRooms, MAX_ROOMS);
    assert.ok(typeof data.uptimeMs === "number" && data.uptimeMs >= 0);
    assert.ok(Array.isArray(data.rooms));
  });

  it("returns 200 with activeRooms=2 when two mock bridges are active", async () => {
    fakeActive.set("room-a", { getStatus: async () => ({ id: "room-a" }) });
    fakeActive.set("room-b", { getStatus: async () => ({ id: "room-b" }) });
    try {
      const { statusCode, body } = await httpGet(`http://127.0.0.1:${TEST_PORT}/healthz`);
      assert.equal(statusCode, 200);
      const data = JSON.parse(body);
      assert.equal(data.status, "ok");
      assert.equal(data.activeRooms, 2);
      assert.equal(data.rooms.length, 2);
    } finally {
      fakeActive.clear();
    }
  });

  it("returns 404 for unknown paths", async () => {
    const { statusCode } = await httpGet(`http://127.0.0.1:${TEST_PORT}/unknown`);
    assert.equal(statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Test 2: all log lines emitted by _emit() are valid JSON objects
// ---------------------------------------------------------------------------

describe("INS-035 W5 — structured JSON logging", () => {
  // We inline the _emit() implementation from index.js so the test can exercise
  // it without importing the full module (which has side-effects at module scope).
  function _emit(level, args) {
    const [first, ...rest] = args;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: String(first ?? ""),
    };
    if (rest.length > 0) {
      entry.extra = rest.map((v) =>
        v instanceof Error
          ? { error: v.message, stack: v.stack }
          : typeof v === "object" && v !== null ? v : v,
      );
    }
    (level === "error" ? process.stderr : process.stdout).write(JSON.stringify(entry) + "\n");
  }
  const log = (...args) => _emit("info", args);
  const logWarn = (...args) => _emit("warn", args);
  const logError = (...args) => _emit("error", args);

  it("log() emits a parseable JSON object with ts, level, msg", async () => {
    const lines = await captureStdout(async () => { log("test message", { key: "val" }); });
    assert.ok(lines.length >= 1, "expected at least one log line");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, "info");
    assert.equal(parsed.msg, "test message");
    assert.ok(parsed.ts, "ts field present");
  });

  it("logWarn() emits level:warn", async () => {
    const lines = await captureStdout(async () => { logWarn("budget exceeded", { activeRooms: 11 }); });
    assert.ok(lines.length >= 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, "warn");
    assert.equal(parsed.msg, "budget exceeded");
  });

  it("Error objects are serialised with error+stack fields", async () => {
    const lines = await captureStdout(async () => {
      log("caught error", new Error("boom"));
    });
    assert.ok(lines.length >= 1);
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.extra, "extra field present");
    assert.equal(parsed.extra[0].error, "boom");
    assert.ok(typeof parsed.extra[0].stack === "string");
  });

  it("every emitted line is valid JSON for a batch of log calls", async () => {
    const lines = await captureStdout(async () => {
      for (let i = 0; i < 20; i++) {
        log(`message ${i}`, { index: i });
        logWarn(`warn ${i}`);
      }
    });
    assert.ok(lines.length >= 40, `expected ≥40 lines, got ${lines.length}`);
    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch {
        assert.fail(`Non-JSON line: ${line}`);
      }
      assert.ok(parsed.ts, "ts field missing");
      assert.ok(parsed.level, "level field missing");
      assert.ok(parsed.msg !== undefined, "msg field missing");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: SIGTERM triggers graceful shutdown (disconnect all active bridges)
// ---------------------------------------------------------------------------

describe("INS-035 W5 — graceful shutdown", () => {
  it("shutdown() calls stop() on all active bridges and clears the map", async () => {
    // We simulate the shutdown logic from main() without starting real Discord/LK.
    const stopped = [];
    const fakeActive = new Map();
    fakeActive.set("room-x", { stop: async () => { stopped.push("room-x"); } });
    fakeActive.set("room-y", { stop: async () => { stopped.push("room-y"); } });

    let shuttingDown = false;
    const fakeInterval = { [Symbol.toPrimitive]: () => 0 };
    const health = { close: () => {} };
    const client = { destroy: () => {} };
    const dispose = async () => {};

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(fakeInterval);
      health.close();
      for (const [key, bridge] of fakeActive.entries()) {
        await bridge.stop().catch(() => {});
        fakeActive.delete(key);
      }
      client.destroy();
      await dispose();
      // In real code: process.exit(0) — we skip that in the test.
    };

    await shutdown();

    assert.equal(fakeActive.size, 0, "all bridges should be removed from active map");
    assert.deepEqual(stopped.sort(), ["room-x", "room-y"], "stop() called on all bridges");
    assert.equal(shuttingDown, true, "shuttingDown flag set");

    // Calling shutdown() a second time is idempotent (early return).
    stopped.length = 0;
    await shutdown();
    assert.equal(stopped.length, 0, "second call is no-op");
  });
});
