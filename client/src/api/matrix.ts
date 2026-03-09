import * as sdk from "matrix-js-sdk";

const HOMESERVER_URL = window.location.origin;

export function createMatrixClient(
  accessToken: string,
  userId: string,
  deviceId: string,
): sdk.MatrixClient {
  const client = sdk.createClient({
    baseUrl: HOMESERVER_URL,
    accessToken,
    userId,
    deviceId,
  });
  return client;
}

export async function loginWithPassword(
  username: string,
  password: string,
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });
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

export async function registerWithToken(
  username: string,
  password: string,
  registrationToken: string,
): Promise<{ accessToken: string; userId: string; deviceId: string }> {
  const tempClient = sdk.createClient({ baseUrl: HOMESERVER_URL });

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
