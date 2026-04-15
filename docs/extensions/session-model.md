# Extension Session Model (INS-036 Wave 0)

**Status:** Design complete — Wire format chosen  
**Date:** 2026-04-14  
**Scope:** Replace `com.concord.extension` single-blob room state with a structured, multi-session extension model.

---

## 1. Motivation

The original `com.concord.extension` Matrix room state event stored the entire extension state as a single JSON blob keyed by extension ID. This breaks when:

- Multiple users run separate per-user instances of the same extension.
- An extension has distinct modes (shared whiteboard vs. per-user notepad).
- Different surfaces (embedded panel vs. modal overlay) host the same extension simultaneously.
- Access control must differ between hosts and read-only observers.

The structured session model replaces the single blob with first-class session objects, each self-describing their mode, participants, surfaces, and input permissions.

---

## 2. Session Model

### 2.1 Core Fields

| Field | Type | Description |
|---|---|---|
| `session_id` | `string` (UUIDv4) | Globally unique identifier for this session instance. |
| `extension_id` | `string` | Reverse-domain extension identifier, e.g. `com.concord.whiteboard`. |
| `mode` | `ModeEnum` | Interaction model — see §2.2. |
| `version` | `string` | SemVer of the extension that created this session. |
| `created_at` | `integer` (ms epoch) | When the session was created. |
| `created_by` | `string` | Matrix user ID of the session initiator. |
| `surfaces` | `Surface[]` | Where this session is rendered — see §2.3. |
| `participants` | `Participant[]` | Seat bindings for this session — see §2.4. |
| `launch_descriptor` | `LaunchDescriptor` | How to start the extension — see §2.5. |
| `input_permissions` | `InputPermissions` | Who can send input events — see §2.6. |
| `metadata` | `object` | Extension-defined opaque payload (max 4 KB). |

### 2.2 Mode Enum

```
shared               — One live state, all participants interact equally.
shared_readonly      — One live state, observers can see but not interact.
shared_admin_input   — One live state, only admins can interact; observers watch.
per_user             — Each participant gets an independent state instance.
hybrid               — Primary shared state + optional per-user sidebar state.
```

Mode determines which `InputPermissions` fields are meaningful and how the server should fan out state events.

### 2.3 Surface Descriptors

A session may be rendered in multiple surfaces simultaneously (e.g. pinned sidebar panel + floating modal for a presenter). Each surface descriptor is:

```json
{
  "surface_id": "<string, UUIDv4>",
  "type": "panel | modal | pip | fullscreen | background",
  "anchor": "left_sidebar | right_sidebar | bottom_bar | center | none",
  "min_width_px": 320,
  "min_height_px": 240,
  "preferred_aspect": "16:9",
  "z_index": 100
}
```

`type` values:
- `panel` — persistent sidebar embed
- `modal` — floating overlay with dismiss
- `pip` — picture-in-picture floating window
- `fullscreen` — takes full client view
- `background` — headless, no UI

### 2.4 Participant / Seat Bindings

```json
{
  "user_id": "@alice:example.com",
  "seat": "host | participant | observer | spectator",
  "joined_at": 1713052800000,
  "surface_id": "<surface_id this participant is on, or null>"
}
```

Seat roles:
- `host` — created the session; has admin input rights regardless of mode.
- `participant` — active, can interact per mode rules.
- `observer` — in the room but not in the session participant list; can see shared state if extension publishes it.
- `spectator` — explicitly added to a `shared_readonly` session for tracking purposes; no input even if mode would normally allow it.

### 2.5 Launch Descriptors

Describes how the client loads the extension:

```json
{
  "loader": "iframe | native | wasm | external_url",
  "src": "https://cdn.concord.app/ext/whiteboard/v2.3.1/index.html",
  "integrity": "sha384-<hash>",
  "csp_overrides": [],
  "initial_state_event_type": "com.concord.whiteboard.state",
  "capabilities_required": ["matrix.read", "matrix.send", "camera"],
  "capabilities_optional": ["screen_capture"]
}
```

`loader` values:
- `iframe` — sandboxed web iframe (default for web extensions)
- `native` — Tauri plugin or platform-native bundle
- `wasm` — WASM module loaded into a secure worker
- `external_url` — opens in system browser, no embedding

### 2.6 Input Permissions

```json
{
  "send_state_events": ["host", "participant"],
  "send_to_device": ["host", "participant"],
  "react": ["host", "participant", "observer"],
  "pointer_events": ["host"],
  "admin_commands": ["host"]
}
```

Each field is an array of seat roles permitted to perform that action. Empty array = nobody. The server enforces these before forwarding extension-namespace events.

---

## 3. Wire Format

### 3.1 Matrix Room State Event

Extension sessions are stored as Matrix room state events in the room where the extension is running.

**Event type:** `com.concord.extension.session`  
**State key:** `<session_id>` (one event per session; supports multiple concurrent sessions of the same extension)

```json
{
  "type": "com.concord.extension.session",
  "state_key": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "content": {
    "session_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "extension_id": "com.concord.whiteboard",
    "mode": "shared",
    "version": "2.3.1",
    "created_at": 1713052800000,
    "created_by": "@alice:example.com",
    "surfaces": [
      {
        "surface_id": "a1b2c3d4-0000-0000-0000-000000000001",
        "type": "panel",
        "anchor": "right_sidebar",
        "min_width_px": 320,
        "min_height_px": 240,
        "preferred_aspect": null,
        "z_index": 50
      }
    ],
    "participants": [
      {
        "user_id": "@alice:example.com",
        "seat": "host",
        "joined_at": 1713052800000,
        "surface_id": "a1b2c3d4-0000-0000-0000-000000000001"
      }
    ],
    "launch_descriptor": {
      "loader": "iframe",
      "src": "https://cdn.concord.app/ext/whiteboard/v2.3.1/index.html",
      "integrity": "sha384-abc123",
      "csp_overrides": [],
      "initial_state_event_type": "com.concord.whiteboard.state",
      "capabilities_required": ["matrix.read", "matrix.send"],
      "capabilities_optional": ["screen_capture"]
    },
    "input_permissions": {
      "send_state_events": ["host", "participant"],
      "send_to_device": ["host", "participant"],
      "react": ["host", "participant", "observer"],
      "pointer_events": ["host", "participant"],
      "admin_commands": ["host"]
    },
    "metadata": {}
  }
}
```

### 3.2 Session Termination

To terminate a session, the host sends a state event with `content: {}` (tombstone / empty content). Clients treat an empty-content `com.concord.extension.session` as a session-closed signal.

### 3.3 Extension Runtime State

Extension-owned ephemeral/persistent state is stored in **separate** events namespaced to the extension:
- State events: `com.concord.<extension_id>.*` in the same room
- To-device messages: for per-user state that must not be readable by all room members

The session model event itself is NOT the state store — it is the control plane record.

---

## 4. Constraints and Invariants

1. **One session per session_id**: `state_key` = `session_id` enforces uniqueness at the homeserver level.
2. **Multiple sessions per extension per room are allowed**: Different `state_key` values = different concurrent sessions.
3. **Mode is immutable after creation**: Clients should reject state events that change `mode` on an existing session_id. If a mode change is needed, terminate and create a new session.
4. **`metadata` max 4 KB**: Extensions store heavy state via their own event types, not here.
5. **`capabilities_required` gates launch**: Clients must refuse to load an extension if they cannot grant all required capabilities.
6. **Server-side enforcement**: The Concord homeserver module (or a Matrix policy bot) reads `input_permissions` and drops non-permitted events before forwarding.

---

## 5. Migration from `com.concord.extension`

The legacy single-blob format stored state as:
```json
{
  "type": "com.concord.extension",
  "state_key": "<extension_id>",
  "content": { ... opaque blob ... }
}
```

Migration path:
1. Clients detect `com.concord.extension` events and auto-promote them to a `com.concord.extension.session` with `mode: "shared"`, a generated `session_id`, and `created_by` inferred from `sender`.
2. The legacy event is left in place; clients ignore it once the promoted session event is present.
3. New clients never write `com.concord.extension`; they only write `com.concord.extension.session`.
4. After a deprecation window (TBD in INS-036 Wave 1 implementation), the legacy event type is rejected by server policy.

---

## 6. References

- Matrix spec: `m.room.` state event format — https://spec.matrix.org/v1.9/
- INS-036 PLAN.md entry
- `docs/extensions/` — future Wave 1 implementation docs
