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
