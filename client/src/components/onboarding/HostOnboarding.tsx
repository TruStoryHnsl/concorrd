/**
 * HostOnboarding — drives the four-step bring-up of a freshly-hosted
 * Concord instance on the local device (W2-06).
 *
 *   Step 1: ServerNameForm — display name like "My Living Room".
 *   Step 2: OwnerAccountForm — display name (defaults from step 1),
 *           username, password. Above the form, prominent line:
 *           "This account will be the OWNER and ADMIN of your Concord
 *           server. Subsequent users you invite will be regular
 *           members unless you promote them."
 *   Step 3: SpinnerWithStatus — invokes `servitude_start`, polls
 *           `servitude_status` until Running, fetches the
 *           registration token, registers the owner via Matrix
 *           `m.login.registration_token`, elevates to admin (best-
 *           effort empirical mechanism — see ELEVATE_OWNER below),
 *           logs in, persists a source with isOwner=true.
 *   Step 4: Routes to chat UI with the new source selected.
 *
 * Cancellation/back support at each step. Errors are surfaced
 * visibly (no silent retries — feedback_prove_root_cause_first
 * applies).
 *
 * INSTRUMENTATION: every step logs to console with `[HostOnboarding]`
 * prefix when `localStorage.host_onboarding_debug === '1'`. This
 * follows the diagnostic-deploy-pattern from
 * feedback_diagnostic_deploy_pattern — cheap empirical data when a
 * user reports a bug we can't reproduce locally.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSourcesStore } from "../../stores/sources";
import { useServerConfigStore } from "../../stores/serverConfig";

export interface HostOnboardingProps {
  onCancel: () => void;
  onConnected: () => void;
}

type Step = "name" | "account" | "spinning" | "error";

interface ServerNameState {
  displayName: string;
}

interface OwnerAccountState {
  ownerDisplayName: string;
  username: string;
  password: string;
}

interface SpinnerStatus {
  phase:
    | "starting_servitude"
    | "waiting_for_running"
    | "fetching_token"
    | "registering_owner"
    | "elevating_admin"
    | "logging_in"
    | "persisting"
    | "done";
  detail?: string;
}

const debugLog = (...args: unknown[]) => {
  if (
    typeof window !== "undefined" &&
    window.localStorage?.getItem("host_onboarding_debug") === "1"
  ) {
    // eslint-disable-next-line no-console
    console.log("[HostOnboarding]", ...args);
  }
};

/**
 * Servitude status payload shape from the Rust side. Keep this in
 * sync with `servitude_status` in src-tauri/src/lib.rs.
 */
interface ServitudeStatusPayload {
  state: "Stopped" | "Starting" | "Running" | "Stopping" | "Failed";
  degraded_transports: Record<string, string>;
}

async function pollUntilRunning(
  timeoutMs: number,
  intervalMs: number,
  onTick: (status: ServitudeStatusPayload) => void,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await invoke<string>("servitude_status");
    const parsed = JSON.parse(raw) as ServitudeStatusPayload;
    onTick(parsed);
    debugLog("servitude_status", parsed);
    if (parsed.state === "Running") return;
    if (parsed.state === "Failed" || parsed.state === "Stopped") {
      throw new Error(
        `servitude entered terminal state ${parsed.state} during startup`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`servitude did not reach Running within ${timeoutMs}ms`);
}

/**
 * Owner-registration response shape returned by the Rust-side
 * `servitude_register_owner` Tauri command. Wave 3 sprint W3-05
 * moved the per-backend registration mechanic out of the frontend:
 *
 *   * Linux/macOS (tuwunel): backend drives the
 *     `m.login.registration_token` UIA dance.
 *   * Windows (dendrite): backend shells out to bundled
 *     `create-account.exe -admin` then `/login`.
 *
 * The frontend NEVER touches the per-backend protocol anymore —
 * just calls servitude_register_owner once and reads this shape.
 */
interface RegisterOwnerResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

/**
 * "Elevate to admin" — empirical TODO. tuwunel inherits Conduwuit's
 * !admin room: the FIRST user to register on a clean server is
 * automatically invited to the admin room and granted PL 100 there.
 * This means owner-registration is *implicitly* admin in
 * Conduwuit/tuwunel — there is no explicit "elevate" Matrix call to
 * make. We log the assumption for empirical confirmation in the
 * W2-13 E2E.
 *
 * If a future tuwunel release breaks this assumption, this function
 * is the canonical place to add an admin-room join + admin command
 * issuance.
 */
function noteAdminElevation(userId: string): void {
  debugLog(
    `assuming first-user-becomes-admin convention for ${userId}; ` +
      "the W2-13 E2E will empirically confirm that the !admin room invite " +
      "lands and PL 100 is granted on tuwunel v1.5.1+.",
  );
}

export function HostOnboarding({
  onCancel,
  onConnected,
}: HostOnboardingProps) {
  const [step, setStep] = useState<Step>("name");
  const [serverName, setServerName] = useState<ServerNameState>({
    displayName: "",
  });
  const [account, setAccount] = useState<OwnerAccountState>({
    ownerDisplayName: "",
    username: "",
    password: "",
  });
  const [spinnerStatus, setSpinnerStatus] = useState<SpinnerStatus>({
    phase: "starting_servitude",
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The bring-up promise; ref-tracked so a stale step transition
  // (user clicking back) can ignore late settlements.
  const bringUpRef = useRef<Promise<void> | null>(null);

  const handleBringUp = useCallback(async () => {
    setSpinnerStatus({ phase: "starting_servitude" });
    debugLog("invoke servitude_start");
    await invoke<void>("servitude_start");

    setSpinnerStatus({ phase: "waiting_for_running" });
    await pollUntilRunning(60_000, 500, (s) => {
      setSpinnerStatus({
        phase: "waiting_for_running",
        detail: s.state,
      });
    });

    // The embedded homeserver binds 127.0.0.1:<configured port>. The
    // default port is 8448 for tuwunel-on-Linux/macOS and dendrite-
    // on-Windows alike (matched in ServitudeConfig::default).
    const homeserverUrl = "http://127.0.0.1:8448";

    setSpinnerStatus({ phase: "registering_owner" });
    // Wave 3 sprint W3-07: the frontend NEVER drives the per-backend
    // registration protocol anymore. servitude_register_owner picks
    // the right path internally (tuwunel UIA on Linux/macOS, dendrite
    // create-account CLI on Windows) and returns the same response
    // shape on every platform.
    const session = await invoke<RegisterOwnerResponse>(
      "servitude_register_owner",
      {
        username: account.username,
        password: account.password,
      },
    );
    debugLog("registered owner", session.user_id);

    setSpinnerStatus({ phase: "elevating_admin" });
    noteAdminElevation(session.user_id);

    setSpinnerStatus({ phase: "logging_in" });
    // Owner is already logged in via the register response — the
    // backend handled /login internally.

    setSpinnerStatus({ phase: "persisting" });
    const id = useSourcesStore.getState().addSource({
      host: "127.0.0.1",
      instanceName: serverName.displayName || "My Concord",
      inviteToken: "",
      apiBase: homeserverUrl,
      homeserverUrl,
      accessToken: session.access_token,
      userId: session.user_id,
      deviceId: session.device_id,
      status: "connected",
      enabled: true,
      platform: "concord",
      ownerUserId: session.user_id,
      isOwner: true,
    });
    useSourcesStore.getState().markOwner(id, true);

    // Mirror to the legacy single-active-source pointer so the rest
    // of the app's API resolution targets the new local homeserver.
    useServerConfigStore.getState().setHomeserver({
      host: "127.0.0.1",
      homeserver_url: homeserverUrl,
      api_base: homeserverUrl,
      instance_name: serverName.displayName || "My Concord",
      features: ["chat"],
    });

    setSpinnerStatus({ phase: "done" });
    onConnected();
  }, [account, serverName, onConnected]);

  // Trigger bring-up the first time we land on the spinning step.
  useEffect(() => {
    if (step !== "spinning") return;
    if (bringUpRef.current) return;
    bringUpRef.current = handleBringUp().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("bring-up failed:", msg);
      setErrorMsg(msg);
      setStep("error");
    });
  }, [step, handleBringUp]);

  if (step === "name") {
    return (
      <div
        data-testid="host-onboarding-name"
        className="h-full w-full bg-surface mesh-background flex items-center justify-center"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!serverName.displayName.trim()) return;
            // Pre-fill ownerDisplayName so the OwnerAccountForm has a
            // sensible default per the spec.
            setAccount((prev) => ({
              ...prev,
              ownerDisplayName:
                prev.ownerDisplayName || serverName.displayName.trim(),
            }));
            setStep("account");
          }}
          className="max-w-md w-full px-8 py-12 flex flex-col gap-6"
        >
          <h2 className="text-3xl font-bold text-text-primary">
            Name your server
          </h2>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-text-secondary">
              Display name (e.g. "My Living Room")
            </span>
            <input
              type="text"
              data-testid="host-onboarding-displayname"
              autoFocus
              value={serverName.displayName}
              onChange={(e) =>
                setServerName({ displayName: e.target.value })
              }
              className="px-4 py-3 rounded-xl bg-surface-elevated border border-border-soft text-text-primary"
            />
          </label>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="host-onboarding-name-next"
              disabled={!serverName.displayName.trim()}
              className="px-4 py-2 rounded-lg bg-accent text-on-accent disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (step === "account") {
    return (
      <div
        data-testid="host-onboarding-account"
        className="h-full w-full bg-surface mesh-background flex items-center justify-center"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !account.username.trim() ||
              account.password.length < 8
            ) {
              return;
            }
            setStep("spinning");
          }}
          className="max-w-md w-full px-8 py-12 flex flex-col gap-6"
        >
          <h2 className="text-3xl font-bold text-text-primary">
            Owner account
          </h2>
          <p
            data-testid="host-onboarding-owner-explainer"
            className="text-sm font-semibold text-accent bg-accent/10 px-4 py-3 rounded-xl border border-accent/30"
          >
            This account will be the OWNER and ADMIN of your Concord
            server. Subsequent users you invite will be regular members
            unless you promote them.
          </p>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-text-secondary">Display name</span>
            <input
              type="text"
              data-testid="host-onboarding-account-displayname"
              value={account.ownerDisplayName}
              onChange={(e) =>
                setAccount({ ...account, ownerDisplayName: e.target.value })
              }
              className="px-4 py-3 rounded-xl bg-surface-elevated border border-border-soft text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-text-secondary">Username</span>
            <input
              type="text"
              data-testid="host-onboarding-account-username"
              value={account.username}
              onChange={(e) =>
                setAccount({ ...account, username: e.target.value })
              }
              autoCapitalize="none"
              autoCorrect="off"
              className="px-4 py-3 rounded-xl bg-surface-elevated border border-border-soft text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-text-secondary">
              Password (8+ characters)
            </span>
            <input
              type="password"
              data-testid="host-onboarding-account-password"
              value={account.password}
              onChange={(e) =>
                setAccount({ ...account, password: e.target.value })
              }
              className="px-4 py-3 rounded-xl bg-surface-elevated border border-border-soft text-text-primary"
            />
          </label>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={() => setStep("name")}
              className="px-4 py-2 rounded-lg text-text-secondary hover:text-text-primary"
            >
              Back
            </button>
            <button
              type="submit"
              data-testid="host-onboarding-account-submit"
              disabled={
                !account.username.trim() || account.password.length < 8
              }
              className="px-4 py-2 rounded-lg bg-accent text-on-accent disabled:opacity-50"
            >
              Create owner & start
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (step === "spinning") {
    return (
      <div
        data-testid="host-onboarding-spinner"
        className="h-full w-full bg-surface mesh-background flex items-center justify-center"
      >
        <div className="max-w-md w-full px-8 py-12 flex flex-col items-center gap-6">
          <div className="w-12 h-12 rounded-full border-4 border-border-soft border-t-accent animate-spin" />
          <div className="flex flex-col items-center gap-1">
            <h2 className="text-2xl font-bold text-text-primary">
              Bringing up your Concord
            </h2>
            <p
              data-testid="host-onboarding-spinner-phase"
              className="text-sm text-text-secondary"
            >
              {humanizePhase(spinnerStatus.phase)}
              {spinnerStatus.detail ? ` (${spinnerStatus.detail})` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // step === "error"
  return (
    <div
      data-testid="host-onboarding-error"
      className="h-full w-full bg-surface mesh-background flex items-center justify-center"
    >
      <div className="max-w-md w-full px-8 py-12 flex flex-col gap-6">
        <h2 className="text-3xl font-bold text-text-primary">
          Hosting failed
        </h2>
        <p
          data-testid="host-onboarding-error-message"
          className="text-sm text-text-secondary whitespace-pre-wrap break-words"
        >
          {errorMsg ?? "An unknown error occurred."}
        </p>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-text-secondary hover:text-text-primary"
          >
            Back to Welcome
          </button>
          <button
            type="button"
            onClick={() => {
              bringUpRef.current = null;
              setErrorMsg(null);
              setStep("spinning");
            }}
            className="px-4 py-2 rounded-lg bg-accent text-on-accent"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

function humanizePhase(phase: SpinnerStatus["phase"]): string {
  switch (phase) {
    case "starting_servitude":
      return "Starting embedded server…";
    case "waiting_for_running":
      return "Waiting for homeserver to come online…";
    case "fetching_token":
      return "Reading registration token…";
    case "registering_owner":
      return "Registering owner account…";
    case "elevating_admin":
      return "Granting admin rights…";
    case "logging_in":
      return "Signing in…";
    case "persisting":
      return "Saving your server…";
    case "done":
      return "Done.";
  }
}
