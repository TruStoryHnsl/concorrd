/**
 * InputRouter — permission enforcement for extension session actions (INS-036 W2).
 *
 * Pure TypeScript, no React, no network calls. Checks whether a participant
 * with a given seat role is allowed to perform an action in a given session mode,
 * using the InputPermissions rules from docs/extensions/session-model.md §2.6.
 */

export type Mode =
  | "shared"
  | "shared_readonly"
  | "shared_admin_input"
  | "per_user"
  | "hybrid";

export type Seat = "host" | "participant" | "observer" | "spectator";

export type InputAction =
  | "send_state_events"
  | "send_to_device"
  | "react"
  | "pointer_events"
  | "admin_commands";

export interface InputPermissions {
  send_state_events: Seat[];
  send_to_device: Seat[];
  react: Seat[];
  pointer_events: Seat[];
  admin_commands: Seat[];
}

/**
 * Default InputPermissions per session mode.
 * Derived from session-model.md §2.2 (mode semantics) + §2.6 (input permissions).
 */
export const DEFAULT_PERMISSIONS: Record<Mode, InputPermissions> = {
  /**
   * shared — One live state, all participants interact equally.
   */
  shared: {
    send_state_events: ["host", "participant"],
    send_to_device: ["host", "participant"],
    react: ["host", "participant", "observer"],
    pointer_events: ["host", "participant"],
    admin_commands: ["host"],
  },
  /**
   * shared_readonly — One live state, observers can see but not interact.
   */
  shared_readonly: {
    send_state_events: ["host"],
    send_to_device: ["host"],
    react: ["host", "participant", "observer"],
    pointer_events: ["host"],
    admin_commands: ["host"],
  },
  /**
   * shared_admin_input — One live state, only admins (host) can interact.
   */
  shared_admin_input: {
    send_state_events: ["host"],
    send_to_device: ["host"],
    react: ["host", "participant", "observer"],
    pointer_events: ["host"],
    admin_commands: ["host"],
  },
  /**
   * per_user — Each participant gets an independent state instance.
   * Observers are not part of any per-user session.
   */
  per_user: {
    send_state_events: ["host", "participant"],
    send_to_device: ["host", "participant"],
    react: ["host", "participant"],
    pointer_events: ["host", "participant"],
    admin_commands: ["host"],
  },
  /**
   * hybrid — Primary shared state + optional per-user sidebar.
   * Participants interact on shared state; observers may react.
   */
  hybrid: {
    send_state_events: ["host", "participant"],
    send_to_device: ["host", "participant"],
    react: ["host", "participant", "observer"],
    pointer_events: ["host", "participant"],
    admin_commands: ["host"],
  },
};

/**
 * Check whether a participant with the given seat is allowed to perform an action
 * in the given session mode.
 *
 * @param mode - Session interaction mode (ModeEnum from session-model.md §2.2)
 * @param seat - Current participant's seat role (from session-model.md §2.4)
 * @param action - Action being attempted (from session-model.md §2.6)
 * @param overrides - Optional per-session InputPermissions overrides (from the
 *   session state event's `input_permissions` field). Merged with defaults;
 *   overrides win on a per-action-key basis.
 * @returns true if the seat is permitted to perform the action, false otherwise.
 */
export function check(
  mode: Mode,
  seat: Seat,
  action: InputAction,
  overrides?: Partial<InputPermissions>,
): boolean {
  const defaults = DEFAULT_PERMISSIONS[mode];
  const effectivePermissions: InputPermissions = overrides
    ? { ...defaults, ...overrides }
    : defaults;
  return effectivePermissions[action].includes(seat);
}
