/**
 * Worldview Extension — Concord INS-036 Reference Implementation.
 *
 * Demonstrates the INS-036 session model from the extension side.
 * This is a "shared counter" extension: all session participants can increment
 * a shared counter. The state is synchronised through the host via postMessage.
 *
 * Session model features demonstrated:
 *   - Listening for concord:init (reads sessionId, mode, participantId, seat)
 *   - Seat-aware UI: hosts see a "Reset" button; observers see read-only counter
 *   - concord:participant_join / leave for live presence display
 *   - concord:host_transfer notification
 *   - concord:surface_resize for responsive layout
 *
 * This file is intentionally plain TypeScript with no framework deps so it
 * compiles to a tiny standalone script that any browser iframe can run.
 *
 * @see docs/extensions/worldview-migration.md
 * @see docs/extensions/session-model.md
 * @see docs/extensions/shell-api.md
 */

// ---------------------------------------------------------------------------
// Minimal SDK types (inline copy — avoids a runtime dep on the Concord client)
// ---------------------------------------------------------------------------

type Mode =
  | "shared"
  | "shared_readonly"
  | "shared_admin_input"
  | "per_user"
  | "hybrid";

type Seat = "host" | "participant" | "observer" | "spectator";

interface ConcordInitPayload {
  sessionId: string;
  extensionId: string;
  mode: Mode;
  participantId: string;
  seat: Seat;
  surfaces: unknown[];
}

interface ConcordParticipantJoinPayload {
  participantId: string;
  seat: Seat;
}

interface ConcordParticipantLeavePayload {
  participantId: string;
}

interface ConcordHostTransferPayload {
  previousHostId: string;
  newHostId: string;
}

type ConcordShellMessage =
  | { type: "concord:init"; payload: ConcordInitPayload; version: 1 }
  | { type: "concord:participant_join"; payload: ConcordParticipantJoinPayload; version: 1 }
  | { type: "concord:participant_leave"; payload: ConcordParticipantLeavePayload; version: 1 }
  | { type: "concord:host_transfer"; payload: ConcordHostTransferPayload; version: 1 }
  | { type: "concord:surface_resize"; payload: { surfaceId: string; widthPx: number; heightPx: number }; version: 1 };

function isConcordShellMessage(data: unknown): data is ConcordShellMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).type === "string" &&
    ((data as Record<string, unknown>).type as string).startsWith("concord:") &&
    (data as Record<string, unknown>).version === 1
  );
}

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

interface WorldviewState {
  sessionId: string | null;
  mode: Mode;
  myParticipantId: string | null;
  mySeat: Seat;
  counter: number;
  participants: Map<string, Seat>;
  host: string | null;
}

const state: WorldviewState = {
  sessionId: null,
  mode: "shared",
  myParticipantId: null,
  mySeat: "participant",
  counter: 0,
  participants: new Map(),
  host: null,
};

// ---------------------------------------------------------------------------
// Safe DOM helpers — no innerHTML
// ---------------------------------------------------------------------------

function displayName(matrixUserId: string): string {
  return matrixUserId.split(":")[0].replace("@", "");
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Partial<Record<string, string>>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) node.setAttribute(k, v);
    }
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function canIncrement(): boolean {
  if (state.mySeat === "observer" || state.mySeat === "spectator") return false;
  if (state.mode === "shared_admin_input" && state.mySeat !== "host") return false;
  if (state.mode === "shared_readonly") return false;
  return true;
}

function canReset(): boolean {
  return state.mySeat === "host";
}

function render(): void {
  const root = document.getElementById("worldview-root");
  if (!root) return;
  root.textContent = ""; // clear safely

  // Header
  const header = el("header");
  header.appendChild(el("h1", {}, "Worldview"));

  const info = el("p", { class: "session-info" });
  info.appendChild(el("span", {}, "Session: "));
  info.appendChild(el("code", {}, state.sessionId ?? "—"));
  info.appendChild(document.createElement("br"));
  info.appendChild(el("span", {}, `Mode: ${state.mode} · Your seat: ${state.mySeat}`));
  info.appendChild(document.createElement("br"));
  info.appendChild(el("span", {}, `Host: ${state.host ? displayName(state.host) : "—"}`));
  header.appendChild(info);
  root.appendChild(header);

  // Counter section
  const section = el("section", { class: "counter-section" });
  section.appendChild(el("div", { id: "counter-value", class: "counter-value" }, String(state.counter)));

  const actions = el("div", { class: "counter-actions" });
  if (canIncrement()) {
    const incBtn = el("button", { id: "btn-increment", class: "btn btn-primary" }, "+1");
    incBtn.addEventListener("click", handleIncrement);
    actions.appendChild(incBtn);
  }
  if (canReset()) {
    const resetBtn = el("button", { id: "btn-reset", class: "btn btn-danger" }, "Reset");
    resetBtn.addEventListener("click", handleReset);
    actions.appendChild(resetBtn);
  }
  if (!canIncrement() && !canReset()) {
    actions.appendChild(el("p", { class: "read-only-notice" }, `Read-only (${state.mySeat})`));
  }
  section.appendChild(actions);
  root.appendChild(section);

  // Participants section
  const pSection = el("section", { class: "participants-section" });
  pSection.appendChild(el("h2", {}, `Participants (${state.participants.size})`));
  const pList = el("div", { class: "participant-list" });
  if (state.participants.size === 0) {
    pList.appendChild(el("em", {}, "No participants yet"));
  } else {
    for (const [id, seat] of state.participants.entries()) {
      pList.appendChild(el("span", { class: `participant ${seat}` }, `${displayName(id)} (${seat})`));
    }
  }
  pSection.appendChild(pList);
  root.appendChild(pSection);
}

// ---------------------------------------------------------------------------
// Action handlers — post actions to the shell via InputRouter protocol (W2)
// ---------------------------------------------------------------------------

function sendAction(action: string, data?: Record<string, unknown>): void {
  window.parent.postMessage(
    { type: "extension_action", action, data: data ?? {} },
    "*",
  );
}

function handleIncrement(): void {
  if (!canIncrement()) return;
  state.counter += 1;
  render();
  sendAction("send_state_events", { counter: state.counter });
}

function handleReset(): void {
  if (!canReset()) return;
  state.counter = 0;
  render();
  sendAction("admin_commands", { op: "reset_counter" });
}

// ---------------------------------------------------------------------------
// Shell message handlers
// ---------------------------------------------------------------------------

function onInit(payload: ConcordInitPayload): void {
  state.sessionId = payload.sessionId;
  state.mode = payload.mode;
  state.myParticipantId = payload.participantId;
  state.mySeat = payload.seat;
  state.participants.set(payload.participantId, payload.seat);
  render();
}

function onParticipantJoin(payload: ConcordParticipantJoinPayload): void {
  state.participants.set(payload.participantId, payload.seat);
  if (payload.seat === "host") {
    state.host = payload.participantId;
  }
  render();
}

function onParticipantLeave(payload: ConcordParticipantLeavePayload): void {
  state.participants.delete(payload.participantId);
  if (state.host === payload.participantId) {
    state.host = null;
  }
  render();
}

function onHostTransfer(payload: ConcordHostTransferPayload): void {
  state.host = payload.newHostId;
  if (state.participants.has(payload.previousHostId)) {
    state.participants.set(payload.previousHostId, "participant");
  }
  state.participants.set(payload.newHostId, "host");
  if (payload.newHostId === state.myParticipantId) {
    state.mySeat = "host";
  } else if (payload.previousHostId === state.myParticipantId) {
    state.mySeat = "participant";
  }
  render();
}

function onSurfaceResize(payload: { surfaceId: string; widthPx: number; heightPx: number }): void {
  const root = document.getElementById("worldview-root");
  if (!root) return;
  root.classList.toggle("narrow", payload.widthPx < 400);
  void payload.surfaceId; // surfaceId available for multi-surface extensions
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  if (!isConcordShellMessage(event.data)) return;

  switch (event.data.type) {
    case "concord:init":
      onInit(event.data.payload);
      break;
    case "concord:participant_join":
      onParticipantJoin(event.data.payload);
      break;
    case "concord:participant_leave":
      onParticipantLeave(event.data.payload);
      break;
    case "concord:host_transfer":
      onHostTransfer(event.data.payload);
      break;
    case "concord:surface_resize":
      onSurfaceResize(event.data.payload);
      break;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  render();
});
