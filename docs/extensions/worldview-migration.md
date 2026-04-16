# Worldview Extension — Session Model Migration (INS-036 Wave 5)

**Status:** Reference implementation scaffold complete  
**Date:** 2026-04-15  
**Scope:** Migrate Worldview onto the INS-036 session model; provide a reference for future extension authors.

---

## 1. Background

Before INS-036, extension state was stored as a single opaque JSON blob in a Matrix room state event under the key `com.concord.extension`. There was no concept of session IDs, modes, surface types, or seat-based input permissions.

Worldview (`ext/worldview/`) is the first extension migrated to the new session model. It serves as a reference implementation showing extension authors how to:
1. Receive identity and session context via `concord:init`.
2. Handle participant join/leave and host transfer events.
3. Implement seat-aware input (host vs participant vs observer).
4. Respond to surface resize events.
5. Send state-change actions back to the shell via the W2 InputRouter protocol.

---

## 2. What Changed

### Before (pre-INS-036)

```json
// Matrix room state: com.concord.extension
{
  "extension_id": "com.concord.worldview",
  "data": { "counter": 42 }
}
```

- Single shared blob, no participant binding.
- No mode concept — everyone had equal input.
- No surface descriptor — always rendered as a full-width sidebar panel.

### After (INS-036 session model)

```json
// Matrix room state: com.concord.extension.session.<session_id>
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "extension_id": "com.concord.worldview",
  "mode": "shared",
  "version": "0.1.0",
  "created_at": 1713168000000,
  "created_by": "@alice:concord.example.com",
  "surfaces": [
    {
      "surface_id": "550e8400-...-surface-0",
      "type": "panel",
      "anchor": "right_sidebar"
    }
  ],
  "participants": [
    { "participant_id": "@alice:...", "seat": "host" }
  ],
  "launch_descriptor": { "url": "https://worldview.concord.app/index.html" },
  "input_permissions": {
    "send_state_events": ["host", "participant"],
    "admin_commands": ["host"]
  },
  "metadata": {}
}
```

---

## 3. Migration Steps

### Step 1 — Receive `concord:init`

Before INS-036, extensions had no identity context. Now the shell sends a `concord:init` message to the iframe after mount:

```ts
window.addEventListener("message", (e) => {
  if (!isConcordShellMessage(e.data)) return;
  if (e.data.type === "concord:init") {
    const { sessionId, mode, participantId, seat, surfaces } = e.data.payload;
    // Store locally and render.
  }
});
```

### Step 2 — Replace global state assumptions with seat checks

The old Worldview treated every visitor identically. Replace unconditional renders with seat-aware guards:

```ts
// Before:
function canIncrement(): boolean { return true; }

// After:
function canIncrement(): boolean {
  if (seat === "observer" || seat === "spectator") return false;
  if (mode === "shared_admin_input" && seat !== "host") return false;
  if (mode === "shared_readonly") return false;
  return true;
}
```

### Step 3 — Handle participant lifecycle events

The session model delivers participant join/leave and host transfers as shell messages:

```ts
case "concord:participant_join":
  addParticipant(e.data.payload.participantId, e.data.payload.seat);
  break;
case "concord:participant_leave":
  removeParticipant(e.data.payload.participantId);
  break;
case "concord:host_transfer":
  updateHost(e.data.payload.newHostId);
  // Update your own seat if you are the old or new host.
  break;
```

### Step 4 — Handle `concord:surface_resize`

Use the resize event to adapt layout to the surface dimensions:

```ts
case "concord:surface_resize":
  root.classList.toggle("narrow", e.data.payload.widthPx < 400);
  break;
```

### Step 5 — Send state-change actions back to the shell

Use the W2 InputRouter protocol to notify the shell of state changes:

```ts
window.parent.postMessage(
  { type: "extension_action", action: "send_state_events", data: { counter } },
  "*",
);
```

The shell validates the action against `InputPermissions` before forwarding or persisting it.

---

## 4. Reference Implementation

The full reference implementation is at `ext/worldview/src/index.ts`. It demonstrates:

- **Shared counter**: all `host`/`participant` seats can increment; only `host` can reset.
- **Read-only mode**: `observer`/`spectator` seats and `shared_readonly` mode suppress all input buttons.
- **Participant list**: live presence display updated on join/leave/transfer.
- **Responsive layout**: `narrow` CSS class toggled via `concord:surface_resize`.

### Build

```bash
cd ext/worldview
npm install
npm run build   # esbuild → dist/index.js
```

### Type-check only

```bash
npm run typecheck
```

---

## 5. Simple Party-Game Prototype — Feasibility

The Worldview counter demonstrates that the session model is sufficient for a simple party game:

**What works today:**
- Seat-based access control (host controls game state, participants see and interact, observers watch).
- Live participant roster updates.
- State fan-out via `send_state_events` action through the shell.

**What the session model does NOT handle directly (game engine concerns):**
- Real-time state synchronisation between participants (the session model's `send_state_events` action goes to the shell, which persists to Matrix room state — this is event-sourced, not low-latency CRDT).
- For party games where sub-100ms latency matters (Pictionary drawing, Poker card reveal), the bridge SDK would need a supplementary WebRTC data channel or a LiveKit data track alongside the Matrix event bus.

**Recommendation:** Use the session model as the **session management layer** (who is playing, what mode, seat assignments). Use a LiveKit data channel for the **game event bus** (card flips, drawing strokes, cursor positions). The Worldview extension wires them together — `concord:init` gives you the LiveKit room token; the extension connects directly to LiveKit for game events while using Matrix room state for durable game state (score, round number, who won).

---

## 6. Roll20 Companion Feasibility

As of 2026-04-15, direct Roll20 web embedding is **unproven / likely blocked** by Roll20's framing restrictions (`X-Frame-Options: SAMEORIGIN` or equivalent CSP). The Worldview session model does not change this. Recommendations:

1. Build a native Roll20 companion browser extension (not an iframe embed) that communicates with Concord via the shell API.
2. Or, partner with Roll20 for an official Concord integration that whitelists `*.concord.app` origins.
3. Do not assume iframe embedding is feasible until current framing restrictions are validated per the INS-036 W3 non-goal statement.
