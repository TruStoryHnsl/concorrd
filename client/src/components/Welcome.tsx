/**
 * Welcome screen — the replacement for the modal-style ServerPickerScreen
 * on Tauri/native first launch (W2-05, INS-058).
 *
 * Renders a hollow brand surface with two co-equal calls-to-action:
 *   - "Connect to a Concord" — drives the existing wellKnown discovery
 *     flow, persisting a non-owner SourceRecord on success.
 *   - "Host a new Concord" — drives the embedded servitude bring-up,
 *     owner-account registration, and admin elevation, persisting an
 *     `isOwner: true` SourceRecord on success.
 *
 * This component only owns the picker. The two flows live in
 * `onboarding/HostOnboarding.tsx` and `onboarding/ConnectOnboarding.tsx`
 * (W2-06 + W2-07). When `onConnected` fires the App-level state machine
 * advances to LoginForm or ChatLayout depending on whether the new
 * source already has an active session.
 *
 * Subsequent runs skip Welcome — `App.tsx` only renders this when
 * `useSourcesStore.getState().sources.length === 0` AND
 * `useServerConfigStore.getState().config === null` (no active source).
 *
 * UX note (memory: feedback_ux_hollow_webui_spec): the longer-term
 * design is a hollow ChatLayout with the picker living inside the
 * Sources column's `+` tile. This Welcome screen is a stepping stone
 * — it preserves the simpler "two big choices" affordance for the
 * first-launch case while the rest of the onboarding flows mature.
 * The `+` tile add-source flow (W2-08) routes through the same
 * underlying onboarding components.
 */

import { useState } from "react";
import { ConnectOnboarding } from "./onboarding/ConnectOnboarding";
import { HostOnboarding } from "./onboarding/HostOnboarding";

export interface WelcomeProps {
  /**
   * Fired when an onboarding flow successfully attaches a source. The
   * App-level router uses this to flip out of the Welcome state.
   */
  onConnected: () => void;
}

type Flow = "picker" | "connect" | "host";

export function Welcome({ onConnected }: WelcomeProps) {
  const [flow, setFlow] = useState<Flow>("picker");

  if (flow === "connect") {
    return (
      <ConnectOnboarding
        onCancel={() => setFlow("picker")}
        onConnected={onConnected}
      />
    );
  }
  if (flow === "host") {
    return (
      <HostOnboarding
        onCancel={() => setFlow("picker")}
        onConnected={onConnected}
      />
    );
  }

  return (
    <div
      data-testid="welcome-screen"
      className="h-full w-full bg-surface mesh-background flex items-center justify-center"
    >
      <div className="max-w-2xl w-full px-8 py-12 flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <h1 className="text-4xl font-bold text-text-primary tracking-tight">
            Welcome to Concord
          </h1>
          <p className="text-text-secondary text-lg text-center max-w-md">
            Pick how you want to start. You can add more sources later from
            the Sources rail.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
          <button
            type="button"
            data-testid="welcome-connect-cta"
            onClick={() => setFlow("connect")}
            className="group flex flex-col items-start gap-2 p-6 rounded-2xl border border-border-soft bg-surface-elevated hover:border-accent transition-colors text-left"
          >
            <div className="text-xl font-semibold text-text-primary group-hover:text-accent">
              Connect to a Concord
            </div>
            <div className="text-sm text-text-secondary leading-snug">
              Already have a server URL or invite link? Sign in to an
              existing Concord, Matrix, or federated instance.
            </div>
          </button>

          <button
            type="button"
            data-testid="welcome-host-cta"
            onClick={() => setFlow("host")}
            className="group flex flex-col items-start gap-2 p-6 rounded-2xl border border-border-soft bg-surface-elevated hover:border-accent transition-colors text-left"
          >
            <div className="text-xl font-semibold text-text-primary group-hover:text-accent">
              Host a new Concord
            </div>
            <div className="text-sm text-text-secondary leading-snug">
              Spin up your own server on this device. You will be the
              owner and admin; invite others by sharing a token.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
