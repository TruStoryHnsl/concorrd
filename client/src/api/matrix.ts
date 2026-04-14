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
