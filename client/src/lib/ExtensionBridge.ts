/**
 * ExtensionBridge — shell-side postMessage bridge for Concord extension surfaces (INS-036 W4).
 *
 * Owns the window message listener, validates origins (*.concord.app), routes
 * extension_action messages through InputRouter, and dispatches lifecycle
 * events to registered iframe surfaces.
 *
 * Extension-side counterpart: client/src/lib/concord-extension-sdk.ts
 */

import { check, type Mode, type Seat, type InputAction } from "../components/extension/InputRouter";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BridgeSession {
  sessionId: string;
  mode: Mode;
  participantSeat: Seat;
  userId: string;
  /** surfaceId → iframe.contentWindow */
  iframes: Map<string, Window>;
}

// ---------------------------------------------------------------------------
// Internal wire message types
// ---------------------------------------------------------------------------

interface ExtensionActionMessage {
  type: "extension_action";
  nonce?: string;
  action: InputAction;
  payload?: unknown;
}

interface ExtensionEmitMessage {
  type: "concord_sdk_emit";
  eventType: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// ExtensionBridge
// ---------------------------------------------------------------------------

type EmitHandler = (sessionId: string, eventType: string, data: unknown) => void;

/**
 * Shell-side bridge. Mount once per application shell; register sessions as
 * they become active.
 *
 * @example
 * ```ts
 * const bridge = new ExtensionBridge();
 * bridge.onExtensionEmit((sessionId, eventType, data) => { ... });
 * bridge.attach();
 *
 * const cleanup = bridge.registerSession({ sessionId, mode, participantSeat, userId, iframes });
 * // ...
 * cleanup(); // deregister when session ends
 * bridge.detach(); // on unmount
 * ```
 */
export class ExtensionBridge {
  private readonly _allowedOriginPattern: RegExp;
  private readonly _sessions: Map<string, BridgeSession> = new Map();
  private _messageListener: ((event: MessageEvent) => void) | null = null;
  private _emitHandlers: Set<EmitHandler> = new Set();

  constructor(
    allowedOriginPattern: RegExp = /^https:\/\/[a-zA-Z0-9-]+\.concord\.app$/,
  ) {
    this._allowedOriginPattern = allowedOriginPattern;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Register an active extension session.
   * Returns a cleanup function — call it when the session ends.
   */
  registerSession(session: BridgeSession): () => void {
    this._sessions.set(session.sessionId, session);
    return () => {
      this._sessions.delete(session.sessionId);
    };
  }

  /**
   * Dispatch a lifecycle event object to all iframes registered for a session.
   * The event is posted as `{ type: "concord_shell_lifecycle", event }`.
   */
  dispatchLifecycle(sessionId: string, event: object): void {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    const message = { type: "concord_shell_lifecycle", event };
    for (const [, win] of session.iframes) {
      try {
        win.postMessage(message, "*");
      } catch {
        // iframe may have been destroyed
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Emit handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register a handler for `concord_sdk_emit` messages from extension iframes.
   * Returns an unsubscribe function.
   */
  onExtensionEmit(handler: EmitHandler): () => void {
    this._emitHandlers.add(handler);
    return () => this._emitHandlers.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private _handleMessage(event: MessageEvent): void {
    // Validate origin before processing any message.
    if (!this._allowedOriginPattern.test(event.origin)) return;

    if (!event.data || typeof event.data !== "object") return;
    const msg = event.data as { type?: string };

    if (msg.type === "extension_action") {
      this._handleExtensionAction(event, msg as ExtensionActionMessage);
      return;
    }

    if (msg.type === "concord_sdk_emit") {
      this._handleExtensionEmit(event, msg as ExtensionEmitMessage);
      return;
    }
  }

  private _handleExtensionAction(
    event: MessageEvent,
    msg: ExtensionActionMessage,
  ): void {
    // Find which session this iframe belongs to.
    const session = this._findSessionBySource(event.source as Window);
    if (!session) return;

    const allowed = check(session.mode, session.participantSeat, msg.action);

    // Post ACK back to the originating iframe.
    if (event.source && "postMessage" in event.source) {
      try {
        (event.source as Window).postMessage(
          {
            type: "extension_action_ack",
            nonce: msg.nonce ?? null,
            action: msg.action,
            allowed,
          },
          event.origin,
        );
      } catch {
        // source window may have been closed
      }
    }
  }

  private _handleExtensionEmit(
    event: MessageEvent,
    msg: ExtensionEmitMessage,
  ): void {
    const session = this._findSessionBySource(event.source as Window);
    if (!session) return;

    for (const handler of this._emitHandlers) {
      try {
        handler(session.sessionId, msg.eventType, msg.data);
      } catch {
        // handler errors must not crash the bridge
      }
    }
  }

  private _findSessionBySource(source: Window | null): BridgeSession | null {
    if (!source) return null;
    for (const session of this._sessions.values()) {
      for (const [, win] of session.iframes) {
        if (win === source) return session;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Attach the bridge — starts listening for messages. Call once on mount. */
  attach(): void {
    if (this._messageListener) return; // already attached
    this._messageListener = this._handleMessage.bind(this);
    window.addEventListener("message", this._messageListener);
  }

  /** Detach the bridge — removes the message listener. Call on unmount. */
  detach(): void {
    if (!this._messageListener) return;
    window.removeEventListener("message", this._messageListener);
    this._messageListener = null;
  }
}
