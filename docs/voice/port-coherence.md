# Voice Port Coherence Contract (INS-067)

**Status:** enforced by CI as of 2026-05-01.
**Audience:** anyone editing voice / TURN / LiveKit configuration.

The Concord voice flow depends on **four config files agreeing** on the
same UDP port range. A drift between any two of them causes a silent
failure mode where the HTTP API and signaling channel look healthy
(green checks, working chatroom join) while no media ever flows.

This file documents the contract, the keys that must agree, the CI
enforcement mechanism, and the 2026-05-01 incident as a worked example.

## The four files

| File                                | Key(s)                                      | Role                                                                 |
|-------------------------------------|---------------------------------------------|----------------------------------------------------------------------|
| `config/livekit.yaml`               | `rtc.port_range_start`, `rtc.port_range_end` | LiveKit's *internal* (container-side) UDP relay range.               |
| `docker-compose.yml`                | `livekit.ports[]` UDP entry                  | Host:container UDP port mapping that publishes the LiveKit range.    |
| `config/turnserver.conf`            | `min-port`, `max-port`, `allowed-peer-ip`    | coturn relay range and loopback peer permission.                     |
| `.env.example`                      | `LIVEKIT_UDP_START`, `LIVEKIT_UDP_END` advisory comments | Operator-facing default declarations.                              |

## The invariants

```
livekit.yaml.rtc.port_range_start
  == docker-compose.yml livekit.ports[].container_start
  == ${LIVEKIT_UDP_START:-DEFAULT}

livekit.yaml.rtc.port_range_end
  == docker-compose.yml livekit.ports[].container_end
  == ${LIVEKIT_UDP_END:-DEFAULT}

config/turnserver.conf.min-port..max-port
  is DISJOINT from the LiveKit host range
  AND
  config/turnserver.conf includes allowed-peer-ip=127.0.0.1
```

The current canonical values:
- LiveKit container range: **50000 – 50100/udp**
- LiveKit host published range default: **`${LIVEKIT_UDP_START:-50000}-${LIVEKIT_UDP_END:-50100}`**
- coturn relay range: **49152 – 49252** (disjoint from LiveKit; relays clients to the LiveKit UDP range on loopback)
- coturn allowed-peer-ip: **`127.0.0.1`** (so the relay can forward to host-published LiveKit ports)

## The enforcement mechanisms

Two CI jobs in `.github/workflows/ci.yml` enforce the contract:

### `config-lint` (fast static check)

`scripts/lint_config_coherence.py` parses each file with stdlib-only
regex and checks every invariant above. Runs in seconds. Fails the PR
on the first divergent edit. **Catches: most port-coherence drift before
any docker-compose boot is attempted.**

Manual run:
```bash
python3 scripts/lint_config_coherence.py
```

Output on success:
```
OK config coherence: livekit.yaml ↔ docker-compose.yml ↔ turnserver.conf ↔ .env.example all agree
```

Output on failure:
```
FAIL config coherence:
  [ERROR] config/livekit.yaml :: rtc.port_range_start :: expected=50000 actual=51000
```

### `voice-integration` (runtime check)

A separate CI job boots the full `docker-compose.yml +
docker-compose.dev.yml` stack on the GitHub runner, waits for
healthchecks (including the **UDP-aware LiveKit healthcheck** added in
INS-067 W3), TCP-probes coturn 3478, then runs
`scripts/turn_relay_smoke.py --target localhost --plaintext-port 3478`.
This catches edits the static linter cannot model — e.g., a new
config key, a healthcheck regression, or a coturn auth wiring break.

The UDP-aware healthcheck in `docker-compose.yml` for the `livekit`
service runs:
```sh
wget -qO- http://localhost:7880 >/dev/null \
  && awk '{print $2}' /proc/net/udp | grep -qi ':C350$'
```
The hex `C350` is decimal `50000`, the LiveKit `port_range_start`. A
LiveKit instance whose HTTP API is up but whose UDP socket is unbound
will fail the healthcheck and the integration job will fail — the same
failure mode that the 2026-05-01 incident produced silently.

## Worked example — the 2026-05-01 incident

A local hot-edit on the deployment host changed
`config/livekit.yaml`:

```diff
 rtc:
-  port_range_start: 50000
-  port_range_end: 50100
+  port_range_start: 51000
+  port_range_end: 51100
```

`docker-compose.yml` was not co-edited. The published port mapping
remained `50000-50100:50000-50100/udp`. After `docker compose up -d
livekit`:

| Channel        | Result                                                                  |
|----------------|-------------------------------------------------------------------------|
| HTTP `7880`    | Reachable. Health check (TCP-only) green.                                |
| Signaling WSS  | Worked end-to-end. Chatroom joins succeeded.                              |
| TURN allocate  | Succeeded — coturn was unaffected.                                        |
| Media RTP/RTCP | **Dropped silently.** LiveKit bound 51000-51100 inside the container; the host had nothing on 51000. Clients tried to relay through coturn → 127.0.0.1:50000-50100, which had no listener. |
| User report    | "Voice doesn't work."                                                    |

Diagnosis took hours because nothing in the existing health surface
contradicted "the voice stack is fine."

What INS-067 changes:

1. **Static lint catches this on the next PR**: the new
   `config-lint` job parses both files and refuses the change.
2. **Runtime UDP healthcheck catches it on next deploy**: the LiveKit
   container's healthcheck checks `/proc/net/udp` for the
   port_range_start UDP listener. A drifted livekit.yaml fails the
   healthcheck.
3. **Integration smoke catches it in CI before merge**: the
   `voice-integration` job exercises the full stack and a TURN auth
   handshake.

Three layers of defense; any one of them flips the silent failure into
a loud one.

## Editing the port range — the playbook

When changing the LiveKit UDP port range, update **all four files in
the same commit**:

1. `config/livekit.yaml` — `rtc.port_range_start`, `rtc.port_range_end`
2. `docker-compose.yml` — the `livekit.ports[]` UDP entry, both
   `${LIVEKIT_UDP_START:-N}-${LIVEKIT_UDP_END:-M}` defaults AND the
   `:N-M/udp` container side.
3. `config/turnserver.conf` — verify the new range stays disjoint from
   `min-port..max-port`. Adjust coturn range if it would overlap.
4. `.env.example` — update the commented-default advisory line.

Then run:

```bash
python3 scripts/lint_config_coherence.py
```

Locally, before committing.

## Cross-reference

- `scripts/lint_config_coherence.py` — the static check
- `scripts/turn_relay_smoke.py` — the runtime smoke (production AND
  `--target localhost` integration mode)
- `.github/workflows/ci.yml` — the `config-lint` and
  `voice-integration` jobs
- `config/livekit.yaml`, `config/turnserver.conf` — the LiveKit + TURN
  configs (each with a comment referencing this doc)
