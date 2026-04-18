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
    const message = typeof error.detail === "string" ? error.detail : "Failed to get voice token";
    throw new Error(message);
  }

  return resp.json();
}
