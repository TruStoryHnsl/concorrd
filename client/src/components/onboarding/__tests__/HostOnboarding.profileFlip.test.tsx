/**
 * Regression test — empirically-proven bug (2026-05-31):
 *
 * On a fresh native install the deployment profile defaults to
 * `p2p_only`, which materializes ONLY the libp2p baseline transport and
 * SKIPS the embedded Matrix homeserver (the `MatrixFederation` /
 * tuwunel transport — see Phase 7 gating in
 * `src-tauri/src/servitude/mod.rs::new_with_identity`). The Host
 * onboarding wizard called `servitude_start` directly without first
 * flipping the profile to the host-capable `web_first`, so the
 * homeserver never came up and the subsequent `servitude_register_owner`
 * failed with:
 *
 *   "transport error: transport not yet implemented: no MatrixFederation
 *    transport configured for register_owner"
 *
 * The user saw a "Hosting failed" screen carrying that message.
 *
 * This test simulates the backend faithfully: `servitude_register_owner`
 * only succeeds if the handle was (re)built from a `web_first` profile,
 * exactly as the real Rust gating behaves. It drives the wizard from a
 * user-oriented perspective — fill the forms, press "Create owner &
 * start" — and asserts the user reaches a HOSTED instance (onConnected
 * fires, no "Hosting failed" screen). The only way that can pass is if
 * the wizard persists `web_first` BEFORE starting servitude.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

// Faithful in-memory stand-in for the Rust servitude backend. The
// shared `backend` state is hoisted so the `@tauri-apps/api/core` mock
// factory (hoisted above imports by Vitest) can reach it.
const { backend, invokeSpy } = vi.hoisted(() => {
  const backend = {
    persistedProfile: "p2p_only" as "p2p_only" | "web_first",
    // The profile the running handle was built from. `null` while the
    // handle is Stopped/absent. Mirrors the Rust recreate-on-restart
    // contract: the handle captures the profile at construction time.
    startedProfile: null as null | "p2p_only" | "web_first",
    calls: [] as string[],
  };
  const invokeSpy = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    backend.calls.push(cmd);
    switch (cmd) {
      case "set_servitude_profile":
        backend.persistedProfile = args?.profile as "p2p_only" | "web_first";
        return undefined;
      case "servitude_start":
        // Building the handle materializes transports per the persisted
        // profile. p2p_only => no MatrixFederation runtime.
        backend.startedProfile = backend.persistedProfile;
        return undefined;
      case "servitude_stop":
        backend.startedProfile = null;
        return undefined;
      case "servitude_status":
        return {
          state: backend.startedProfile ? "running" : "stopped",
          degraded_transports: {},
        };
      case "servitude_register_owner":
        if (backend.startedProfile !== "web_first") {
          // The exact error the user saw in the bug report.
          throw new Error(
            "transport error: transport not yet implemented: no " +
              "MatrixFederation transport configured for register_owner",
          );
        }
        return {
          user_id: "@owner:127.0.0.1",
          access_token: "owner-access-token",
          device_id: "OWNERDEVICE",
        };
      default:
        return undefined;
    }
  });
  return { backend, invokeSpy };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy }));

// Isolate the test to the bring-up sequence — the success path writes
// into the sources / serverConfig stores, which we don't exercise here.
const addSource = vi.fn(() => "source-1");
const markOwner = vi.fn();
const setHomeserver = vi.fn();
vi.mock("../../../stores/sources", () => ({
  useSourcesStore: { getState: () => ({ addSource, markOwner }) },
}));
vi.mock("../../../stores/serverConfig", () => ({
  useServerConfigStore: { getState: () => ({ setHomeserver }) },
}));

import { HostOnboarding } from "../HostOnboarding";

async function fillWizardAndSubmit() {
  const user = userEvent.setup();
  await user.type(
    await screen.findByTestId("host-onboarding-displayname"),
    "My Living Room",
  );
  await user.click(screen.getByTestId("host-onboarding-name-next"));
  await user.type(
    await screen.findByTestId("host-onboarding-account-username"),
    "owner",
  );
  await user.type(
    screen.getByTestId("host-onboarding-account-password"),
    "hunter2hunter2",
  );
  await user.click(screen.getByTestId("host-onboarding-account-submit"));
}

describe("HostOnboarding — fresh-install hosting bring-up (profile flip)", () => {
  beforeEach(() => {
    backend.persistedProfile = "p2p_only";
    backend.startedProfile = null;
    backend.calls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("brings up a hosted instance on a default p2p_only install (no Hosting failed)", async () => {
    const onConnected = vi.fn();
    render(<HostOnboarding onCancel={() => {}} onConnected={onConnected} />);

    await fillWizardAndSubmit();

    // The user-observable success signal: the wizard reached the end and
    // handed control back to the app with a live hosted source.
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });

    // The "Hosting failed" screen never appeared.
    expect(
      screen.queryByTestId("host-onboarding-error"),
    ).not.toBeInTheDocument();
  });

  it("persists the host-capable web_first profile BEFORE starting servitude", async () => {
    render(<HostOnboarding onCancel={() => {}} onConnected={() => {}} />);
    await fillWizardAndSubmit();

    await waitFor(
      () => expect(backend.calls).toContain("servitude_register_owner"),
      { timeout: 4000 },
    );

    const profileIdx = backend.calls.indexOf("set_servitude_profile");
    const startIdx = backend.calls.indexOf("servitude_start");
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // Order matters: the homeserver only materializes if the profile is
    // web_first at the moment the handle is built.
    expect(profileIdx).toBeLessThan(startIdx);
    expect(backend.persistedProfile).toBe("web_first");
  });
});
