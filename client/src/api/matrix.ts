import * as sdk from "matrix-js-sdk";
import { getHomeserverUrl } from "./serverUrl";

export type MatrixLoginFlowKind = "password" | "sso" | "token";

function buildStoreKey(userId: string, homeserverUrl: string): string {
  const scope = `${userId}|${homeserverUrl}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `concord_matrix_store_${scope}`;
}

export function createMatrixClient(
  accessToken: string,
  userId: string,
  deviceId: string,
  homeserverUrl = getHomeserverUrl(),
): sdk.MatrixClient {
  const baseUrl = homeserverUrl;
  const store =
    typeof window !== "undefined" &&
    typeof window.indexedDB !== "undefined" &&
    typeof window.localStorage !== "undefined"
      ? new sdk.IndexedDBStore({
          indexedDB: window.indexedDB,
          localStorage: window.localStorage,
          dbName: buildStoreKey(userId, baseUrl),
        })
      : undefined;

  const client = sdk.createClient({
    baseUrl,
    accessToken,
    userId,
    deviceId,
    store,
  });
  // Concord uses LiveKit for RTC. Disable matrix-js-sdk's built-in
  // Matrix VoIP TURN polling so login/startup doesn't hammer the
  // unsupported `/_matrix/client/v3/voip/turnServer` endpoint.
  (client as sdk.MatrixClient & { supportsVoip?: () => boolean }).supportsVoip = () => false;
  return client;
}

export async function fetchLoginFlows(
  homeserverUrl: string,
): Promise<MatrixLoginFlowKind[]> {
  const tempClient = sdk.createClient({ baseUrl: homeserverUrl });
  const response = await tempClient.loginFlows();
  const supported = new Set<MatrixLoginFlowKind>();
  for (const flow of response.flows ?? []) {
    if (flow.type === "m.login.password") supported.add("password");
    if (flow.type === "m.login.sso" || flow.type === "m.login.cas") {
      supported.add("sso");
    }
    if (flow.type === "m.login.token") supported.add("token");
  }
  return [...supported];
}

export function buildSsoRedirectUrl(
  homeserverUrl: string,
  redirectUrl: string,
  idpId?: string,
): string {
  const path = idpId
    ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idpId)}`
    : "/_matrix/client/v3/login/sso/redirect";
  const url = new URL(path, homeserverUrl.endsWith("/") ? homeserverUrl : `${homeserverUrl}/`);
  url.searchParams.set("redirectUrl", redirectUrl);
  return url.toString();
}

export async function loginWithPassword(
  username: string,
  password: string,
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  return loginWithPasswordAtBaseUrl(getHomeserverUrl(), username, password);
}

export async function loginWithPasswordAtBaseUrl(
  homeserverUrl: string,
  username: string,
  password: string,
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  const tempClient = sdk.createClient({ baseUrl: homeserverUrl });
  const response = await tempClient.login("m.login.password", {
    user: username,
    password,
    initial_device_display_name: "Concord Web",
  });
  return {
    accessToken: response.access_token,
    userId: response.user_id,
    deviceId: response.device_id,
  };
}

export async function loginWithTokenAtBaseUrl(
  homeserverUrl: string,
  loginToken: string,
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  const tempClient = sdk.createClient({ baseUrl: homeserverUrl });
  const response = await tempClient.login("m.login.token", {
    token: loginToken,
    initial_device_display_name: "Concord Source",
  });
  return {
    accessToken: response.access_token,
    userId: response.user_id,
    deviceId: response.device_id,
  };
}

export async function registerWithToken(
  username: string,
  password: string,
  registrationToken: string,
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  const tempClient = sdk.createClient({ baseUrl: getHomeserverUrl() });

  // Step 1: Initiate registration to get UIAA session
  let sessionId: string;
  try {
    await tempClient.registerRequest({ username, password });
    // If this succeeds without UIAA, registration is open (shouldn't happen)
    throw new Error("Unexpected: registration completed without UIAA");
  } catch (err: unknown) {
    const error = err as { data?: { session?: string } };
    if (error.data?.session) {
      sessionId = error.data.session;
    } else {
      throw err;
    }
  }

  // Step 2: Complete registration with token
  const response = await tempClient.registerRequest({
    username,
    password,
    auth: {
      type: "m.login.registration_token",
      token: registrationToken,
      session: sessionId!,
    },
    initial_device_display_name: "Concord Web",
  });

  return {
    accessToken: response.access_token!,
    userId: response.user_id,
    deviceId: response.device_id!,
  };
}

/**
 * Matrix user-directory search result. Shape matches the
 * `/_matrix/client/v3/user_directory/search` response's `results[]` array.
 *
 * Spec: https://spec.matrix.org/v1.10/client-server-api/#post_matrixclientv3user_directorysearch
 */
export interface MatrixDirectoryUser {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
}

/**
 * Search a Matrix homeserver's public user directory.
 *
 * Used by the "New DM" picker in `NewDMModal.tsx` to populate the user list
 * across ALL connected sources rather than only the user's own homeserver.
 * The Concord-API `/users/search` endpoint that backed the old single-list
 * behavior only sees users on the local Concord instance — federating to
 * Matrix's directory means a Concord user can DM a matrix.org user (or any
 * other federated peer) without having to switch sources first.
 *
 * Privacy considerations:
 *  - Matrix homeservers honor a per-user `m.user.directory.public` flag
 *    (set via account_data) — users opted out of the directory don't
 *    appear in `results`. We do NOT need to filter that on the client.
 *  - The endpoint returns `limited: true` when results were capped; UI
 *    surfaces this so the user knows to refine their search.
 *
 * @param homeserverUrl  Base URL of the source's Matrix homeserver, e.g.
 *                       `https://matrix.example.com`. Use the source's
 *                       `homeserverUrl` field from `useSourcesStore`.
 * @param accessToken    The source's `accessToken` (per-source — NOT the
 *                       global Concord access token; user-directory search
 *                       requires an auth'd session against the homeserver
 *                       hosting the user being looked up).
 * @param searchTerm     The query string. Empty string is allowed — most
 *                       homeservers return their top users by display name
 *                       when given an empty term.
 * @param limit          Max results per source. Default 10 keeps the
 *                       aggregated list digestible across N sources.
 * @returns `{ results, limited }` from the homeserver. Throws on network
 *           error / 4xx so callers can `Promise.allSettled` and skip the
 *           offline source without taking the whole modal down.
 */
export async function searchMatrixDirectory(
  homeserverUrl: string,
  accessToken: string,
  searchTerm: string,
  limit = 10,
): Promise<{ results: MatrixDirectoryUser[]; limited: boolean }> {
  const url = `${homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/user_directory/search`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ search_term: searchTerm, limit }),
  });
  if (!res.ok) {
    throw new Error(
      `user_directory/search failed (${res.status}): ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as {
    results?: MatrixDirectoryUser[];
    limited?: boolean;
  };
  return {
    results: Array.isArray(data.results) ? data.results : [],
    limited: Boolean(data.limited),
  };
}
