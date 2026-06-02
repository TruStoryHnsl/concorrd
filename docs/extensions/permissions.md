# Extension Permissions Registry (INS-066 W7)

**Status:** Implemented
**Date:** 2026-04-30
**Scope:** Defines the permission grammar that runtime-installed
extensions may declare in `manifest.json` and that the Concord shell
and server enforce at runtime.

---

## 1. Where permissions live

Each installed extension's `manifest.json` carries an array:

```json
{
  "id": "com.concord.orrdia-bridge",
  "version": "0.1.0",
  "permissions": ["state_events", "fetch:external"]
}
```

The server validates this list at install time (`POST
/api/extensions/install`) against the `ALLOWED_PERMISSIONS` registry in
`server/routers/extensions.py`. Permissions outside the registry reject
the install with HTTP 422 and the offending name(s) in the body.

The validated manifest (including the canonical permissions list) is
persisted to the `extensions.manifest` column. Downstream code reads the
permissions array via `routers.extensions.get_extension_manifest()`.

There is no silent permission inflation. The only way to grant an
extension a new permission is to (1) extend `ALLOWED_PERMISSIONS` in
the source code, (2) add it here in the registry, (3) wire enforcement
into whichever router or shell-side gate cares about it, then (4)
re-publish the manifest with the new permission and re-install.

## 2. The registry

| Permission | Granted to manifest | Shell-side enforcement | Server-side enforcement |
|---|---|---|---|
| `state_events` | Read AND send Matrix room state for the active session room. | `concord:state_event` is forwarded; `extension:send_state_event` is accepted (combined with InputRouter session/seat check). | — |
| `matrix.read` | Read-only Matrix events. Subset of `state_events`. | `concord:state_event` is forwarded; `extension:send_state_event` is rejected. | — |
| `matrix.send` | Send-only Matrix events. Subset of `state_events`. | `extension:send_state_event` is accepted; inbound Matrix events are NOT forwarded. | — |
| `fetch:external` | Use the per-extension `/api/ext-proxy/<id>/<provider>/...` proxy to reach upstream APIs. | — | `routers/ext_proxy.py` checks the manifest before allowing any proxied request. Without this permission the proxy returns 403. |
| `soundboard.play` | Trigger soundboard clips on the server. | — (UI only) | (Reserved — not yet enforced; declaring it is harmless but does not yet unlock anything.) |
| `media.read` | Read shared media files on the server. | — (UI only) | (Reserved — not yet enforced.) |

## 3. Combining permissions

The state-events gates are the most subtle. The shell uses a
"any-of" check:

- Outbound Matrix events to an extension iframe are gated by
  `state_events` OR `matrix.read`. Either is sufficient.
- Inbound `extension:send_state_event` verbs from an iframe are gated
  by `state_events` OR `matrix.send`. Either is sufficient.

This means `state_events` is a coarse, full-duplex permission;
`matrix.read` and `matrix.send` are split-permissions for extensions
that want a tighter declaration ("this extension only reads, never
writes" is a meaningful, observable property).

## 4. Failure modes

When the gate fails:

- Outbound (`concord:state_event`): the message is silently dropped.
  The extension never sees those events.
- Inbound (`extension:send_state_event`): the shell posts back
  `concord:permission_denied` with `reason: "manifest_missing_permission"`
  and `detail: "state_events|matrix.send"` (the gate options).
- Server proxy (`fetch:external`): HTTP 403 with body
  `{"error": "permission_denied", "permission": "fetch:external", "extension_id": "<id>"}`.

## 5. Extending the registry

To add a new permission:

1. Add the literal to `ALLOWED_PERMISSIONS` in
   `server/routers/extensions.py`.
2. Add the row to the table in §2 above with concrete enforcement
   behavior. The "Reserved — not yet enforced" placeholder is only
   acceptable when an enforcement landing is imminent and tracked in
   `PLAN.md`.
3. Land the enforcement code (shell-side gate or server router check).
4. Update INS-066 W7 acceptance criteria in `PLAN.md` if behavior
   changes for existing extensions.
