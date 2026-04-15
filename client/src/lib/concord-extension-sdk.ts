/**
 * concord-extension-sdk — postMessage bridge for Concord extension iframes (INS-036 W4).
 *
 * This module is imported by extension code running inside sandboxed iframes.
 * It has NO React dependencies and NO imports from Concord internals.
 * Pure TypeScript, postMessage-based communication with the Concord shell.
 *
 * Shell-side counterpart: client/src/lib/ExtensionBridge.ts
 */

// ---------------------------------------------------------------------------
// Shared types (re-exported so extensions are typed without importing from shell)
// ---------------------------------------------------------------------------

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

export interface ParticipantBinding {
  user_id: string;
  seat: Seat;
  joined_at: number;
  surface_id: string | null;
}

export interface IdentityEnvelope {
  userId: string;
  sessionId: string;
  mode: Mode;
  seat: Seat;
  participantBindings: ParticipantBinding[];
}

export interface SurfaceResizeEvent {
  surfaceId: string;
  width: number;
  height: number;
}

export interface SurfaceFocusEvent {
  surfaceId: string;
  focused: boolean;
}

export type LifecycleEvent =
  | { type: "join"; identity: IdentityEnvelope }
  | { type: "leave"; reason: string }
  | { type: "hostTransfer"; newHostUserId: string }
  | { type: "surfaceResize"; event: SurfaceResizeEvent }
  | { type: "surfaceFocus"; event: SurfaceFocusEvent };

// ---------------------------------------------------------------------------
// Wire message types (internal — not exported as part of the public API)
// ---------------------------------------------------------------------------

interface ShellLifecycleMessage {
  type: "concord_shell_lifecycle";
  event: LifecycleEvent;
}

interface ActionAckMessage {
  type: "extension_action_ack";
  nonce: string;
  action: InputAction;
  allowed: boolean;
}

// ---------------------------------------------------------------------------
// ConcordExtensionSDK
// ---------------------------------------------------------------------------

/**
 * SDK instance for a single extension surface.
 * Create via `createSDK()` on DOMContentLoaded.
 *
 * @example
 * ```ts
 * import { createSDK } from "concord-extension-sdk";
 * const sdk = createSDK();
 * sdk.onLifecycle((evt) => {
 *   if (evt.type === "join") console.log("joined as", evt.identity.seat);
 * });
 * ```
 */
export class ConcordExtensionSDK {
  private readonly _targetOrigin: string;
  private readonly _lifecycleHandlers: Set<(event: LifecycleEvent) => void> = new Set();
  private readonly _pendingActions: Map<
    string,
    { resolve: (v: { allowed: boolean }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  > = new Map();
  private _messageListener: ((event: MessageEvent) => void) | null = null;
  private _destroyed = false;

  constructor(targetOrigin = "*") {
    this._targetOrigin = targetOrigin;
    this._messageListener = this._handleMessage.bind(this);
    window.addEventListener("message", this._messageListener);
  }

  private _handleMessage(event: MessageEvent): void {
    if (!event.data || typeof event.data !== "object") return;

    // Lifecycle events pushed from the shell
    if (event.data.type === "concord_shell_lifecycle") {
      const msg = event.data as ShellLifecycleMessage;
      for (const handler of this._lifecycleHandlers) {
        try {
          handler(msg.event);
        } catch {
          // Handler errors must not crash the bridge
        }
      }
      return;
    }

    // ACK for a pending sendInputAction
    if (event.data.type === "extension_action_ack") {
      const msg = event.data as ActionAckMessage;
      const pending = this._pendingActions.get(msg.nonce);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingActions.delete(msg.nonce);
        pending.resolve({ allowed: msg.allowed });
      }
    }
  }

  /**
   * Register a handler for lifecycle events pushed by the Concord shell.
   * Returns an unsubscribe function.
   */
  onLifecycle(handler: (event: LifecycleEvent) => void): () => void {
    this._lifecycleHandlers.add(handler);
    return () => this._lifecycleHandlers.delete(handler);
  }

  /**
   * Send an input action to the shell and await ACK.
   * Resolves with `{ allowed: boolean }`.
   * Rejects after 5 000 ms if the shell does not respond.
   */
  sendInputAction(
    action: InputAction,
    payload?: unknown,
  ): Promise<{ allowed: boolean }> {
    if (this._destroyed) return Promise.reject(new Error("SDK destroyed"));

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingActions.delete(nonce);
        reject(new Error(`sendInputAction timed out: ${action}`));
      }, 5_000);

      this._pendingActions.set(nonce, { resolve, reject, timer });

      window.parent.postMessage(
        { type: "extension_action", nonce, action, payload: payload ?? null },
        this._targetOrigin,
      );
    });
  }

  /**
   * Emit a custom event to the Concord shell.
   * The shell receives it as `concord_sdk_emit` with `eventType` and `data`.
   */
  emit(eventType: string, data: unknown): void {
    if (this._destroyed) return;
    window.parent.postMessage(
      { type: "concord_sdk_emit", eventType, data },
      this._targetOrigin,
    );
  }

  /**
   * Destroy this SDK instance — removes all message listeners and rejects
   * any pending action promises.
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._messageListener) {
      window.removeEventListener("message", this._messageListener);
      this._messageListener = null;
    }

    for (const [nonce, pending] of this._pendingActions) {
      clearTimeout(pending.timer);
      pending.reject(new Error("SDK destroyed"));
      this._pendingActions.delete(nonce);
    }

    this._lifecycleHandlers.clear();
  }
}

/**
 * Convenience factory — create and return a new ConcordExtensionSDK instance.
 */
export function createSDK(targetOrigin?: string): ConcordExtensionSDK {
  return new ConcordExtensionSDK(targetOrigin);
}
