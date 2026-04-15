# Discord Video Bridge — Feasibility Gate (INS-035 Wave 0)

**Status:** COMPLETE — Go verdict with constraints  
**Date:** 2026-04-14  
**Scope:** Determine whether Discord's current voice/video transport stack allows external bot clients to receive and publish video/screen-share streams.

---

## 1. Background

The current `concord-discord-voice-bridge` (`discord-voice-bridge/`) is an **audio-only** relay built on:

- `discord.js@14` — Discord gateway/REST client
- `@discordjs/voice@0.19` — Bot voice channel membership, Opus audio send/receive
- `@livekit/rtc-node@0.13` — LiveKit room publish/subscribe (audio tracks only)

The bridge joins a Discord voice channel as a bot participant, receives per-user Opus audio streams, mixes them, and publishes a single audio track into a mapped LiveKit room. It also pulls a single LiveKit audio track and plays it back into Discord. Video is not touched at any layer.

---

## 2. Discord DAVE Protocol — What It Is

**DAVE** (Discord Audio/Video E2EE) is Discord's end-to-end encryption layer for voice and video, deployed in late 2024. Key properties:

- Built on MLS (RFC 9420) — group key agreement where each participant holds a private key leaf.
- Media streams (audio + video) are encrypted with per-sender AES-GCM keys derived from the MLS epoch.
- Metadata (who is speaking, who has video enabled) travels over the existing Discord gateway WebSocket and UDP voice connection — these are NOT E2EE.
- The media transport itself is still WebRTC (SRTP over UDP).

**Critical implication for bots:** Discord's official bot API (`@discordjs/voice`) does **not** implement DAVE. The bot voice subsystem uses an older non-E2EE path that Discord maintains for backward compatibility with bots. Bots join voice channels without MLS key exchange. This means:

- Bots can still send and receive audio (Opus RTP) on non-E2EE channels.
- Bots are **excluded from E2EE voice/video** — they cannot receive DAVE-encrypted media because they have no MLS leaf key.
- Discord has stated no timeline for bot DAVE support.
- If a guild/channel has E2EE enforced, bots will be present in the channel UI but receive silence (audio) and no video frames.

For channels without DAVE enforced (the majority of public and community servers), bots receive the full unencrypted audio stream. **Video is a different story — see section 4.**

---

## 3. Library Survey

### 3.1 `@discordjs/voice` (current, Node.js)

| Capability | Status |
|---|---|
| Join voice channel as bot | Yes |
| Send audio (Opus) | Yes |
| Receive per-user audio (Opus) | Yes |
| Send video (H.264/VP8) | **No** — not implemented |
| Receive video | **No** — not implemented |
| Screen share | **No** |
| DAVE E2EE | **No** |

The library explicitly scopes to audio only. Video RTP handling is absent from the codebase. No roadmap item for video exists in the discord.js org as of early 2026.

### 3.2 `discord.py` / `pycord` (Python)

Same audio-only limitation. `pycord` has a `voice_recv` branch that exposes raw RTP packets (audio), but video is not decoded or exposed. No DAVE implementation.

### 3.3 `discord-video-stream` (Node.js, community)

- Repo: `dank074/discord-video-stream` (npm: `@dank074/discord-video-stream`)
- **Actively maintained as of 2025-2026.**
- Uses a **selfbot** (user account token, not bot token) to join voice channels.
- Sends H.264 video + Opus audio over Discord's RTP voice connection.
- Uses `ffmpeg` for encoding; supports screen capture and file/stream input.
- Can send camera video and screen share.
- **Receive-side video:** partial support — the library can subscribe to video streams from other participants.

**Critical caveat:** This library operates as a selfbot — it authenticates as a Discord user account, not a bot application. Discord's Terms of Service explicitly prohibit automated selfbots. Accounts using selfbots risk permanent ban. This is a **production deployment blocker** for a commercial product.

### 3.4 `Lavalink` / `Wavelink`

Audio playback servers for Discord bots. Not relevant to video bridging.

### 3.5 `discord-video-stream` bot-mode forks

Several forks attempt to adapt `discord-video-stream` for bot tokens. As of 2026-04, none are stable or feature-complete. Discord's bot API RTP handshake differs from user-client RTP negotiation, and video encoding via bots is not officially supported.

### 3.6 Native Discord client (reverse-engineered protocol)

Discord's Electron/mobile clients implement full video/screenshare via:
- Voice gateway opcode 12 (VIDEO) for track signaling
- H.264 / VP8 / VP9 / AV1 video over RTP/SRTP
- Screen capture via opcode 18 (STREAM_CREATE) / `Stream` feature

These opcodes are **not documented in the official bot API**. Some community projects (e.g., `discord.io` forks, `discordgo` video branch) implement them, but they depend on undocumented protocol internals that Discord can and does change without notice.

---

## 4. What Media Directions Are Actually Possible

### Bot account (official API)

| Direction | Audio | Video | Screen share |
|---|---|---|---|
| Bot → Discord | Yes (Opus) | **No** | **No** |
| Discord → Bot (per-user) | Yes (Opus) | **No** | **No** |

### User account / selfbot (`discord-video-stream`)

| Direction | Audio | Video | Screen share |
|---|---|---|---|
| Self → Discord | Yes | Yes (H.264) | Yes |
| Discord → Self | Yes | Partial | Partial |

**Summary:** Official bot API = audio only. Video requires either selfbot (ToS violation, ban risk) or undocumented opcodes (fragile, breakage risk).

---

## 5. DAVE Impact on Video Bridging

Even if a video-capable client path existed:

- DAVE E2EE encrypts video frames at the sender with their MLS leaf key.
- A bridge participant without an MLS leaf receives encrypted RTP it cannot decrypt.
- Even selfbot clients must participate in MLS key exchange — some selfbot libraries implement this; others do not, silently receiving garbage frames.
- For channels with DAVE disabled (legacy mode), this is not a blocker.

**Practical impact:** DAVE-enforced channels are increasingly common but not universal. A bridge would need to detect DAVE negotiation and degrade gracefully (audio-only fallback) or refuse to join the channel.

---

## 6. Go / No-Go Verdict

### Verdict: **CONDITIONAL GO**

Video bridging is technically feasible but only under specific constraints. Full unrestricted go is blocked by the selfbot ToS risk.

| Path | Feasible | Risk | Recommendation |
|---|---|---|---|
| Official bot API + video | **No** | — | Blocked by API |
| Selfbot + `discord-video-stream` | Yes | High (ToS, ban) | Do not use in production |
| Undocumented opcodes via bot | Partial | High (protocol breakage) | Research-only |
| **One-way ingest only (Discord → Concord)** | **Yes** | Low | **Recommended** |
| **DAVE-off channels only** | **Yes** | Medium | Acceptable constraint |

### Recommended approach (if go)

**Implement a one-directional ingest bridge: Discord video → Concord LiveKit only.**

Rationale:
1. The `discord-video-stream` library's receive-side (subscribing to other users' streams) is the less ToS-risky direction — it mirrors what a Discord client does when watching someone's stream. However, it still requires a user account token.
2. An alternative using the undocumented bot video opcodes (opcode 12 + stream subscription) avoids ToS risk but requires protocol reverse-engineering and maintenance.
3. **Outbound (Concord → Discord video projection)** should be explicitly deferred until Discord adds official bot video API support, which has been a community request for years.

### Concrete recommended architecture (Wave 1 input)

```
Discord voice channel participants
  │
  │  video/audio RTP streams
  ▼
discord-video-stream (user-account client OR future bot opcode impl)
  │
  │  per-user video tracks (H.264/VP8)
  │  per-user audio tracks (Opus)
  ▼
LiveKit room (mapped)
  per-participant synthetic identity: "discord-video:<user_id>"
  separate video track + audio track per Discord participant
```

**Audio direction (bidirectional):** Keep existing behavior — mix or per-user relay as per INS-035 Wave 1.

**Video direction (inbound only):** Subscribe to Discord video streams, publish to LiveKit as separate tracks per participant.

**Outbound video (Concord → Discord):** Blocked pending official bot API support. Placeholder: no-op or silent drop.

### Constraints that must be documented before Wave 1

1. **DAVE channel detection:** Bridge must detect E2EE enforcement and refuse video ingest or degrade to audio-only.
2. **User-account token requirement:** If using `discord-video-stream`, document that this requires a dedicated Discord user account (not a bot application) and the associated ToS risk. The operator must acknowledge this.
3. **Undocumented opcode fragility:** If pursuing the bot-opcode path, pin the Discord gateway version and add a circuit breaker that kills video and falls back to audio on protocol errors.
4. **Video codec negotiation:** Discord supports H.264, VP8, VP9, and AV1. The bridge must negotiate a codec that `@livekit/rtc-node` can transcode or passthrough. H.264 is the safest common denominator.

---

## 7. References

- `discord-voice-bridge/src/index.js` — current audio-only implementation
- `@discordjs/voice` docs: https://discord.js.org/docs/packages/voice/main
- DAVE/MLS spec: https://daveprotocol.com (Discord internal spec, partial public disclosure)
- `discord-video-stream`: https://github.com/dank074/discord-video-stream
- LiveKit Node SDK video track API: https://docs.livekit.io/reference/client-sdk-js/
- Discord bot video opcode tracker: discord.js GitHub issues #10337, #9820
