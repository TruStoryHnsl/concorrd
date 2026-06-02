import { getApiBase } from "./serverUrl";

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface VoiceTokenResponse {
  token: string;
  livekit_url: string;
  ice_servers: IceServer[];
}

export interface TurnCheckResult {
  turn_configured: boolean;
  turn_reachable: boolean;
  turn_latency_ms: number | null;
  turn_host: string | null;
  turn_ports: string[];
  livekit_healthy: boolean;
  diagnostics: string;
}

export async function checkTurnHealth(
  accessToken: string,
): Promise<TurnCheckResult> {
  const resp = await fetch(`${getApiBase()}/voice/turn-check`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error("TURN health check failed");
  }
  return resp.json();
}

export async function getVoiceToken(
  roomName: string,
  accessToken: string,
): Promise<VoiceTokenResponse> {
  const resp = await fetch(`${getApiBase()}/voice/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ room_name: roomName }),
  });

  if (!resp.ok) {
    const error = await resp.json().catch(() => ({ detail: resp.statusText }));
    // The API has two error shapes in flight:
    //   * legacy FastAPI HTTPException: { detail: "..." }
    //   * ConcordError (server/errors.py): { error_code, message, details }
    // The /api/voice/token endpoint returns the ConcordError shape for the
    // VOICE_SUBSYSTEM_UNAVAILABLE 503 — reading only `.detail` here meant
    // the actionable server message was discarded and the generic fallback
    // string "Failed to get voice token" leaked out, which then matched
    // a heuristic in VoiceChannel.tsx and was mislabeled as "Authentication
    // failed." Prefer the ConcordError fields when present.
    const concordCode = typeof error.error_code === "string" ? error.error_code : null;
    const serverMessage =
      (typeof error.message === "string" && error.message) ||
      (typeof error.detail === "string" && error.detail) ||
      "Failed to get voice token";
    const err = new Error(serverMessage);
    // Surface the structured fields so the caller can classify without
    // string-matching on the human-readable message.
    (err as Error & { status?: number; errorCode?: string | null }).status = resp.status;
    (err as Error & { status?: number; errorCode?: string | null }).errorCode = concordCode;
    throw err;
  }

  return resp.json();
}
