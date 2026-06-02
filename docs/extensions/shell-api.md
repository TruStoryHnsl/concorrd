# Concord Shell API — Extension postMessage Protocol (INS-036 Wave 4)

**Status:** Implemented  
**Date:** 2026-04-15  
**Scope:** Define the postMessage / RPC boundary between the Concord shell and extension iframes.

---

## 1. Overview

Extension surfaces run inside sandboxed iframes. They cannot directly access Concord internals (store, Matrix client, auth tokens). The shell communicates with extensions exclusively via `window.postMessage`.

**Protocol direction:**
- **Shell → Extension**: lifecycle and identity events (this document).
- **Extension → Shell**: input actions (handled by `InputRouter.ts` — see W2).

All shell messages share this envelope:

```ts
{
  type: "concord:<event>",  // string
  payload: <typed payload>,
  version: 1,               // protocol version — bump on breaking changes
}
```

---

## 2. Message Types

### 2.1 `concord:init`

Sent once to each iframe shortly after mount (100 ms defer to allow iframe load).

**Payload:**

```ts
{
  sessionId:    string;          // UUIDv4 session identifier
  extensionId:  string;          // e.g. "com.concord.whiteboard"
  mode:         Mode;            // "shared" | "shared_readonly" | "shared_admin_input" | "per_user" | "hybrid"
  participantId: string;         // Matrix user ID of the current user
  seat:         Seat;            // "host" | "participant" | "observer" | "spectator"
  surfaces:     SurfaceDescriptor[];  // All surfaces in this session
}
```

**When re-sent:** Any time `sessionId`, `participantId`, or `seat` changes (e.g. host transfer, reconnect).

**Extension usage:**

```ts
window.addEventListener("message", (e) => {
  if (!isConcordShellMessage(e.data)) return;
  if (e.data.type === "concord:init") {
    const { sessionId, mode, participantId, seat } = e.data.payload;
    // Initialise extension state here.
  }
});
```

### 2.2 `concord:participant_join`

Sent when a participant joins the session (Matrix room member event received).

```ts
{
  participantId: string;   // Matrix user ID of the joining participant
  seat:          Seat;     // Their assigned seat
}
```

### 2.3 `concord:participant_leave`

Sent when a participant leaves the session.

```ts
{
  participantId: string;   // Matrix user ID of the departing participant
}
```

### 2.4 `concord:host_transfer`

Sent when the host seat transfers to another participant.

```ts
{
  previousHostId: string;  // Matrix user ID of the old host
  newHostId:      string;  // Matrix user ID of the new host
  newSeat:        Seat;    // Always "host"
}
```

### 2.5 `concord:surface_resize`

Sent by `ResizeObserver` when the surface container dimensions change. Extensions use this to reflow their layout without polling `window.innerWidth`.

```ts
{
  surfaceId:  string;  // surface_id from the session model
  widthPx:   number;  // New width in logical pixels (integer)
  heightPx:  number;  // New height in logical pixels (integer)
}
```

---

## 3. Integrating the SDK

### 3.1 Shell side (Concord internal — `ExtensionSurfaceManager`)

Pass `sdkInit` to `ExtensionSurfaceManager`:

```tsx
<ExtensionSurfaceManager
  url={extensionUrl}
  extensionName="Whiteboard"
  hostUserId={hostId}
  isHost={isHost}
  onStop={handleStop}
  surfaces={sessionSurfaces}
  mode={sessionMode}
  participantSeat={mySeat}
  sdkInit={{
    sessionId,
    extensionId: "com.concord.whiteboard",
    mode: sessionMode,
    participantId: myUserId,
    seat: mySeat,
  }}
/>
```

For `concord:participant_join`, `concord:participant_leave`, and `concord:host_transfer`, use the helpers from `client/src/extensions/sdk.ts` directly and dispatch them to the relevant iframes:

```ts
import { postToFrame, buildParticipantJoinMessage } from "../../extensions/sdk";

// When a Matrix m.room.member event arrives for this session:
const msg = buildParticipantJoinMessage({ participantId, seat });
iframeRef.current && postToFrame(iframeRef.current, msg);
```

### 3.2 Extension side

Extensions import the type guard from the SDK (or implement their own check):

```ts
import { isConcordShellMessage } from "@concord/sdk"; // future npm package
// or inline:
function isConcordShellMessage(data) {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.type === "string" &&
    data.type.startsWith("concord:") &&
    data.version === 1
  );
}

window.addEventListener("message", (event) => {
  if (!isConcordShellMessage(event.data)) return;

  switch (event.data.type) {
    case "concord:init":
      initExtension(event.data.payload);
      break;
    case "concord:participant_join":
      addParticipant(event.data.payload.participantId, event.data.payload.seat);
      break;
    case "concord:participant_leave":
      removeParticipant(event.data.payload.participantId);
      break;
    case "concord:host_transfer":
      updateHost(event.data.payload.newHostId);
      break;
    case "concord:surface_resize":
      reflow(event.data.payload.widthPx, event.data.payload.heightPx);
      break;
  }
});
```

---

## 4. Security Model

- Shell always posts with `targetOrigin: "*"` — iframes are sandboxed (`allow-scripts allow-same-origin` for panel/modal; `allow-scripts` only for browser surfaces).
- Extensions MUST NOT use shell messages to infer secrets — no tokens, passwords, or Matrix access tokens are ever included in the payload.
- Extensions SHOULD verify `event.origin` matches their own origin if they need to authenticate callers. For sandboxed iframes, `event.origin` may be `"null"`.
- The `version` field allows extensions to reject messages from incompatible shell versions.

---

## 5. Lifecycle Hooks Summary

| Hook | Trigger | Who sends |
|---|---|---|
| `concord:init` | iframe mount; session/identity change | Shell (automatic via sdkInit prop) |
| `concord:participant_join` | m.room.member join event | Shell caller (manual postToFrame call) |
| `concord:participant_leave` | m.room.member leave event | Shell caller (manual postToFrame call) |
| `concord:host_transfer` | host seat change | Shell caller (manual postToFrame call) |
| `concord:surface_resize` | ResizeObserver fires | Shell (automatic via containerRef) |
| `concord:state_event` | Matrix room event observed (W5) | Shell (automatic via subscribeRoomEvents prop) |
| `concord:permission_denied` | extension verb rejected (W6) | Shell (auto reply to inbound message) |

---

## 6. INS-066 Additions

### 6.1 `concord:state_event` — Matrix event delivery (shell → iframe)

The shell forwards Matrix room state/timeline events to the extension iframe IFF the extension's manifest permissions include `state_events` OR `matrix.read`. Without those, the iframe never sees this message — fail-closed.

**Payload:**

```ts
{
  roomId:         string;                    // Matrix room ID
  eventType:      string;                    // e.g. "m.room.message"
  content:        Record<string, unknown>;   // raw event content
  sender:         string;                    // Matrix user ID
  originServerTs: number;                    // ms since epoch
  stateKey?:      string;                    // present on state events
}
```

### 6.2 `extension:send_state_event` — Matrix emit (iframe → shell)

Inbound verb. The extension requests the shell emit a Matrix state event on its behalf. Two gates apply:

1. **InputRouter** — the participant's seat must be permitted to perform `send_state_events` in the current session mode (see [`session-model.md`](./session-model.md) §2.6).
2. **Manifest** — the extension's manifest permissions must include `state_events` OR `matrix.send`.

**Payload:**

```ts
{
  roomId?:    string;                    // optional; defaults to current session room.
                                         // Cross-room sends are rejected.
  eventType:  string;                    // Matrix event type to emit
  stateKey?:  string;                    // defaults to ""
  content:    Record<string, unknown>;   // event content
}
```

**Envelope shape (note the `extension:` prefix):**

```ts
{
  type:    "extension:send_state_event",
  payload: <see above>,
  version: 1,
}
```

### 6.3 `concord:permission_denied` — verb rejection (shell → iframe)

When an inbound `extension:*` verb is rejected, the shell posts this back to the originating iframe.

**Payload:**

```ts
{
  action:  string;   // the rejected verb, e.g. "extension:send_state_event"
  reason:  string;   // stable identifier — see below
  detail?: string;   // optional context (e.g. missing permission name)
}
```

Stable `reason` values:

| reason | meaning |
|---|---|
| `manifest_unknown` | Shell has no manifest record for this extension. |
| `manifest_missing_permission` | Manifest didn't request the required permission. `detail` lists the gate options. |
| `session_role_forbidden` | InputRouter denied the seat for this action, or a cross-room send was attempted. |
| `invalid_payload` | Payload shape was wrong. |
| `backend_error` | Host's emit failed. `detail` carries the error message. |

---

## 7. Protocol Version History

| Version | Date | Changes |
|---|---|---|
| 1 | 2026-04-15 | Initial protocol: init, participant join/leave, host_transfer, surface_resize |
| 1 | 2026-04-30 | INS-066 additive: state_event, permission_denied (out); extension:send_state_event (in). Same envelope version — extensions that ignore unknown types stay compatible. |
