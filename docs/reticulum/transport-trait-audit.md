# Transport Trait Audit — Reticulum Hosting Feasibility (INS-034)

**Status:** Audit complete  
**Date:** 2026-04-14  
**Scope:** Can the existing `Transport` trait in `src-tauri/src/servitude/transport/mod.rs` host a Reticulum implementation without modification?

---

## 1. Source of Truth

File audited: `/home/corr/projects/concord/src-tauri/src/servitude/transport/mod.rs`

Note: The `beta/` directory referenced in the PLAN.md does not exist as a separate directory in this repository. The Transport abstraction lives in `src-tauri/src/servitude/transport/` as part of the main Tauri app. This audit covers that implementation.

---

## 2. Transport Trait Definition

```rust
#[async_trait]
pub trait Transport: Send + Sync {
    fn name(&self) -> &'static str;
    fn is_critical(&self) -> bool { true }
    async fn start(&mut self) -> Result<(), TransportError>;
    async fn stop(&mut self) -> Result<(), TransportError>;
    async fn is_healthy(&self) -> bool;
}
```

All methods are async-capable via `async_trait`. The trait is object-safe within `async_trait`'s constraints. `Send + Sync` bounds are required for use inside `tokio` tasks.

---

## 3. TransportRuntime Enum

The codebase uses **enum dispatch** rather than `Box<dyn Transport>`. The enum is:

```rust
pub enum TransportRuntime {
    MatrixFederation(matrix_federation::MatrixFederationTransport),
    DiscordBridge(discord_bridge::DiscordBridgeTransport),
    WireGuard,          // placeholder
    Mesh,               // placeholder
    Tunnel,             // placeholder
    #[doc(hidden)] Noop,
    #[doc(hidden)] NoopNonCritical,
    #[doc(hidden)] FailingNonCritical,
}
```

The `TransportRuntime` struct delegates `start`, `stop`, `is_healthy`, `is_critical`, and `name` to the inner type via match arms. Each new transport requires:

1. A new enum variant (1 line).
2. A match arm in each of the 5 dispatch methods (~5 lines each, 25 lines total).
3. A new arm in `for_variant` factory (3–5 lines).
4. A corresponding `TransportVariant` enum entry in `config.rs`.

Total addition for a new transport: ~40 lines of glue, plus the implementation struct itself.

---

## 4. Existing Transport Pattern (MatrixFederationTransport)

`MatrixFederationTransport` implements the pattern a Reticulum transport would follow:

- Stores binary path, config, and a `tokio::process::Child` handle.
- `start()`: resolves binary path → writes config file → spawns child → waits for health probe.
- `stop()`: sends SIGTERM → waits with timeout → sends SIGKILL if needed → cleans up temp files.
- `is_healthy()`: TCP probe or socket probe against a known port/path.
- `is_critical()`: returns `true` (Matrix federation is required for basic operation).

A `ReticulumTransport` would replicate this structure almost exactly, substituting:
- Binary: `rnsd` (Python-based, requires Python runtime or compiled binary)
- Config: Reticulum's TOML/config format
- Health probe: Reticulum management socket or a local TCP announce

---

## 5. Compatibility Assessment

### 5.1 Can the trait host Reticulum without modification?

**Yes.** The `Transport` trait requires no modification. All methods map cleanly:

| Trait method | Reticulum mapping | Notes |
|---|---|---|
| `name()` | `"reticulum"` | Static string |
| `is_critical()` | `false` (default override) | Reticulum is an overlay; Matrix still works without it |
| `start()` | Spawn `rnsd`, wait for management socket | Same pattern as tuwunel |
| `stop()` | SIGTERM → timeout → SIGKILL | Identical to existing pattern |
| `is_healthy()` | Probe management socket or TCP announce | Platform-dependent |

### 5.2 Does the TransportRuntime enum need modification?

**Yes, but trivially.** One new variant + match arms. This is expected — it is how all transports are added. No structural change to the enum dispatch pattern is required.

### 5.3 Does `config.rs` need modification?

**Yes.** A `TransportVariant::Reticulum` must be added to the config enum so users can enable Reticulum in their `servitude.toml`. This is a 1-line addition plus a TOML deserialization string.

### 5.4 Is the trait async contract compatible with Reticulum's lifecycle?

**Yes.** `rnsd` startup is async (spawn + health probe with timeout). `stop` is async (SIGTERM + wait). Both fit naturally into `async fn start/stop`. The `tokio` runtime used by Tauri's command handlers is already in place.

---

## 6. Gaps and Issues

### 6.1 Binary availability on mobile

`rnsd` is a Python package. On desktop (Linux/macOS/Windows), it can be installed system-wide or bundled as a compiled executable via PyInstaller/Nuitka. On Android and iOS, a Python runtime or pre-compiled binary must be bundled. This is a **deployment gap**, not a trait gap.

### 6.2 No stable local API from `rnsd`

`rnsd` exposes a management interface, but it is not a stable HTTP REST API — it is a custom binary protocol. The health check and control surface for `ReticulumTransport` will need to be implemented against this protocol or via a thin Python shim. This is an **implementation complexity**, not a trait incompatibility.

### 6.3 Config format mismatch

`ServitudeConfig` stores generic per-transport settings. Reticulum needs its own config file format (interfaces, encryption identity storage path, etc.). The existing `from_config(config: &ServitudeConfig)` factory pattern allows `ReticulumTransport` to derive its config from `ServitudeConfig`, but Reticulum-specific settings (interface types, storage path) will require new fields in `ServitudeConfig` or a separate config section. This is a **config schema gap**.

### 6.4 Identity / keystore management

Reticulum generates a cryptographic identity on first run and stores it on disk. This keystore must be:
- Stored in a platform-appropriate location (Tauri app data dir).
- Preserved across app restarts.
- Backed up alongside the user's Matrix credentials.

No current infrastructure handles this. **Gap: identity lifecycle not designed.**

### 6.5 Feature flag scaffolding

The `reticulum` Cargo feature is declared in `src-tauri/Cargo.toml` but the enum variant and implementation are not yet written. The feature flag gates compilation of the implementation; the placeholder `Reticulum` variant does not exist yet in `TransportRuntime`. **Gap: implementation not yet written (expected — Wave 1 work).**

---

## 7. Verdict

**The Transport trait can host a Reticulum implementation without any modification to the trait itself.** The `TransportRuntime` enum requires a new variant and match arms (trivial, ~40 lines). The larger gaps are in deployment (binary bundling), API stability (rnsd management protocol), config schema (Reticulum-specific settings), and identity lifecycle — all of which are Wave 1+ implementation work, not architectural blockers.

The existing `MatrixFederationTransport` is a near-perfect template for `ReticulumTransport`; the implementation is a substitution exercise.

---

## 8. References

- `src-tauri/src/servitude/transport/mod.rs` — Transport trait, TransportRuntime enum (audited above)
- `src-tauri/src/servitude/transport/matrix_federation.rs` — reference implementation pattern
- `src-tauri/src/servitude/config.rs` — ServitudeConfig, TransportVariant enum
- `docs/reticulum/main-build-integration.md` — architecture decision
- Reticulum Network Stack: https://reticulum.network
