# Reticulum Transport Integration — Main Build Design (INS-037)

**Status:** Architecture decided  
**Date:** 2026-04-14  
**Scope:** How Reticulum integrates into the main Concord build (not concord-beta).

---

## 1. Reticulum Ecosystem Survey

### 1.1 What Reticulum Is

Reticulum is a cryptography-based networking stack designed for reliable communication over low-bandwidth, high-latency, and physically diverse links (LoRa, packet radio, serial, TCP, I2P, etc.). Key properties:

- Transport-agnostic: runs over any byte-stream or packet interface.
- Built-in end-to-end encryption (X25519 + AES-256 + HMAC-SHA256).
- Supports announce-based peer discovery without a central server.
- Designed for resilient mesh topologies and DTN (delay-tolerant networking).
- Convergence layer architecture: each physical medium is a "link" that Reticulum abstracts.

### 1.2 Python Implementation (Reference)

**`rns`** (Reticulum Network Stack, Python) — the canonical implementation:
- Active, production-ready, maintained by `markqvist`.
- Provides `RNS.Interface`, `RNS.Destination`, `RNS.Link`, `RNS.Transport` Python classes.
- Ships a daemon (`rnsd`) that manages the network stack in the background.
- Python only; no official Rust port.

### 1.3 Rust Ecosystem

No official Rust port of Reticulum exists as of 2026-04. Community Rust efforts:

| Project | Status | Notes |
|---|---|---|
| `reticulum-rs` (various) | Experimental | Incomplete; no production users. Most repos are proof-of-concept for the cryptography layer only. |
| `rnsd` via subprocess | Viable | Run `rnsd` as a child process; communicate via stdin/stdout or local TCP socket. |
| FFI into `rns` Python | Fragile | Requires embedded Python interpreter (via `pyo3`). Significant binary size and startup cost. |

**Conclusion:** A native Rust Reticulum implementation does not yet exist in a shippable state. Integration into a Rust/Tauri binary must go through subprocess or FFI.

---

## 2. Integration Options

### Option A: Transport trait implementation (same path as libp2p)

Add a `Reticulum` variant to `TransportRuntime` that spawns `rnsd` as a child process and communicates via its local HTTP or socket API — exactly the pattern used by `MatrixFederationTransport` (which spawns `tuwunel`).

**Pros:**
- Architecturally consistent with existing transports.
- Lifecycle management (start/stop/health) already tested and working.
- Feature flag cleanly gates the variant without touching other transport code.
- `TransportRuntime` enum + `Transport` trait both support this with zero structural changes.

**Cons:**
- Reticulum does not expose a stable local HTTP API — communication would need to be via socket file or a thin shim.
- `rnsd` is a long-running daemon; managing its config and keystore on mobile targets adds complexity.

### Option B: Separate discovery/overlay layer (alongside Matrix, not inside Transport)

Reticulum runs as a standalone network overlay that provides peer discovery and encrypted transport. Concord's Matrix homeserver (tuwunel) peers over Reticulum-provided TCP tunnels. Reticulum is not managed by the `Transport` trait at all — it is a pre-existing network substrate.

**Pros:**
- Separation of concerns: Reticulum handles addressing and encryption; Matrix handles messaging protocol.
- Does not require changes to `TransportRuntime` enum structure.
- More faithful to how Reticulum is actually deployed (as a network layer, not an application transport).

**Cons:**
- Two daemons to manage (rnsd + tuwunel) with distinct lifecycle dependencies.
- The `Transport` trait's `is_healthy` / `start` / `stop` contract would need to be used externally, not via the existing enum dispatch.
- Harder to gate behind a single Cargo feature flag cleanly.

### Option C: Hybrid — Transport variant for lifecycle, overlay for routing

A `Reticulum` `TransportRuntime` variant manages the `rnsd` lifecycle (start/stop/health), but Reticulum's actual role is as a network overlay that tuwunel uses as one of its interface types. The `Transport` trait instance is purely a lifecycle handle; routing happens below the Matrix layer.

---

## 3. Architecture Decision

**Chosen: Option A — Transport trait implementation.**

Rationale:

1. **Structural consistency**: The existing `Transport` trait + `TransportRuntime` enum is already the lifecycle management seam for all Concord subprocesses. Adding Reticulum as another `TransportRuntime` variant is 20 lines of code in a pattern that is already tested, not a new pattern.

2. **Feature flag gating**: With Option A, `#[cfg(feature = "reticulum")]` gates exactly the new enum variant and its `impl Transport` block. Option B would require gating a more diffuse set of lifecycle wiring.

3. **Mobile feasibility**: Reticulum's `rnsd` ships as a Python package. On mobile, this means either a bundled Python runtime or a compiled `rnsd` binary. Option A puts that complexity inside one `Transport` implementation file, not spread across the network layer.

4. **Precedent**: `MatrixFederationTransport` spawns `tuwunel`; `DiscordBridgeTransport` spawns `mautrix-discord` via `bubblewrap`. Spawning `rnsd` follows the same pattern.

5. **No structural changes to the trait**: The existing `Transport` trait (§4 of `transport-trait-audit.md`) requires no modification to host a Reticulum implementation. The enum needs one new variant; the `for_variant` factory needs one new match arm.

---

## 4. Chosen Architecture

```
ServitudeHandle
  │
  ├── MatrixFederationTransport  (tuwunel child process)
  ├── DiscordBridgeTransport     (mautrix-discord child process)
  └── ReticulumTransport         (rnsd child process)  ← NEW, feature-gated
        │
        │  rnsd manages its own interfaces (LoRa, TCP, etc.)
        │  exposes a local management socket
        │
        └── tuwunel can be configured to peer over a Reticulum TCP interface
            (configuration-level coupling, not code-level coupling)
```

### 4.1 ReticulumTransport responsibilities

- Locate the `rnsd` binary (bundled or system PATH, same discovery logic as tuwunel).
- Write a minimal `rnsd` config (interfaces, storage path) derived from `ServitudeConfig`.
- Spawn `rnsd` as a child process with `tokio::process::Command`.
- Health-check via the `rnsd` local management socket (or a simple TCP announce probe).
- Graceful stop: SIGTERM with a timeout, SIGKILL fallback — same pattern as `MatrixFederationTransport`.

### 4.2 What Reticulum is NOT responsible for (in Wave 1)

- Replacing Matrix for messaging (Reticulum is an overlay/transport, not a messaging protocol).
- Coordinating peer discovery for non-Matrix protocols (that is the concord-beta track).
- Mobile-specific interface management (deferred to Wave 2+).

---

## 5. Feature Flag

A `reticulum` Cargo feature in `src-tauri/Cargo.toml` gates:
- The `ReticulumTransport` struct and its `impl Transport`.
- The `TransportRuntime::Reticulum(ReticulumTransport)` enum variant.
- The `for_variant` match arm for `TransportVariant::Reticulum`.

When the flag is OFF (default), none of the Reticulum code compiles. Existing tests and builds are unaffected.

See `src-tauri/Cargo.toml` `[features]` section for the declaration.

---

## 6. Wave Sequencing

| Wave | Work | Blocker |
|---|---|---|
| W0 | This doc + feature flag scaffold | None — done |
| W1 | `ReticulumTransport` implementation; `rnsd` binary bundling | `rnsd` binary available for target platform |
| W2 | tuwunel ↔ Reticulum interface config; peering over Reticulum links | W1 complete |
| W3 | Mobile: bundled Python or compiled rnsd; foreground service config | Mobile SDK work unblocked |
| W4 | Announce-based peer discovery for serverless Concord rooms | W2 complete |

---

## 7. References

- `src-tauri/src/servitude/transport/mod.rs` — Transport trait + TransportRuntime enum
- `src-tauri/src/servitude/transport/matrix_federation.rs` — child-process transport pattern
- `docs/reticulum/transport-trait-audit.md` — audit of trait compatibility
- Reticulum Network Stack: https://reticulum.network
- `rns` Python package: https://github.com/markqvist/Reticulum
