/**
 * ConnectOnboarding — wraps the existing ServerPickerScreen flow with
 * an explicit "back to Welcome" affordance (W2-07).
 *
 * Functionally this is the same wellKnown-discovery + login flow that
 * already shipped via INS-027. The Welcome screen routes here when
 * the user picks the "Connect to a Concord" CTA. We deliberately
 * delegate to ServerPickerScreen rather than reimplementing the
 * multi-step state machine — the existing component has been ironed
 * out across multiple sprints (INS-027, the W-04 lock-in test, the
 * native pairing flow) and rebuilding it from scratch would be
 * pointless duplication.
 *
 * What this wrapper adds:
 *   - A small "Back" affordance that returns to the Welcome picker
 *     without persisting a source.
 *
 * What this wrapper deliberately does NOT do:
 *   - It does not modify ServerPickerScreen. Any changes to the
 *     wellKnown / login flow itself happen inside ServerPickerScreen
 *     so the existing 308+ tests stay green.
 *   - It does not flip an `isOwner` flag. The Connect path always
 *     persists a non-owner source (`useSourcesStore` already handles
 *     this; isOwner defaults to false).
 */

import { ServerPickerScreen } from "../auth/ServerPickerScreen";

export interface ConnectOnboardingProps {
  onCancel: () => void;
  onConnected: () => void;
}

export function ConnectOnboarding({
  onCancel,
  onConnected,
}: ConnectOnboardingProps) {
  return (
    <div
      data-testid="connect-onboarding"
      className="h-full w-full relative"
    >
      <button
        type="button"
        data-testid="connect-onboarding-back"
        onClick={onCancel}
        className="absolute top-4 left-4 z-10 text-sm text-text-secondary hover:text-text-primary"
      >
        ← Back
      </button>
      <ServerPickerScreen onConnected={onConnected} />
    </div>
  );
}
