/**
 * Welcome screen — the replacement for the modal-style ServerPickerScreen
 * on first launch.
 *
 * Renders a hollow brand surface with a single call-to-action:
 *   - "Connect to a Concord" — drives the existing wellKnown discovery
 *     flow, persisting a non-owner SourceRecord on success.
 *
 * The legacy "Host a new Concord" CTA + HostOnboarding wizard were removed:
 * native installs auto-materialize the local porch (no account creation,
 * no password, no wizard), and the vanity instance name lives in Settings
 * → Hosting via `useInstanceNameStore`. Matrix-account / login flows are
 * driven per-source when the user adds an external auth-required source
 * (Matrix homeserver, peer Concord instance) — not on first launch.
 *
 * This screen is now web-only: native first launch drops straight into
 * ChatLayout (`App.tsx`). Web builds still funnel through Welcome →
 * ConnectOnboarding because docker stacks always have an external
 * homeserver and the browser entry point has no local porch.
 */

import { useState } from "react";
import { ConnectOnboarding } from "./onboarding/ConnectOnboarding";

export interface WelcomeProps {
  /**
   * Fired when an onboarding flow successfully attaches a source. The
   * App-level router uses this to flip out of the Welcome state.
   */
  onConnected: () => void;
}

type Flow = "picker" | "connect";

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

  return (
    <div
      data-testid="welcome-screen"
      className="h-full w-full bg-surface mesh-background flex items-center justify-center overflow-y-auto"
    >
      <div className="max-w-2xl w-full px-8 py-12 flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <h1 className="text-4xl font-headline font-bold text-on-surface tracking-tight">
            Welcome to Concord
          </h1>
          <p className="text-on-surface-variant text-lg text-center max-w-md font-body">
            Sign in to an existing Concord, Matrix, or federated instance.
            You can add more sources later from the Sources rail.
          </p>
        </div>

        <div className="w-full max-w-md">
          <button
            type="button"
            data-testid="welcome-connect-cta"
            onClick={() => setFlow("connect")}
            className="group flex flex-col items-start gap-2 p-6 rounded-2xl border border-outline-variant/30 bg-surface-container hover:border-primary hover:bg-surface-container-high transition-colors text-left w-full"
          >
            <div className="text-xl font-headline font-semibold text-on-surface group-hover:text-primary">
              Connect to a Concord
            </div>
            <div className="text-sm text-on-surface-variant leading-snug font-body">
              Already have a server URL or invite link? Sign in to an
              existing Concord, Matrix, or federated instance.
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
