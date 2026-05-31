/**
 * Phase B — knock-flow vitest coverage.
 *
 * Three layers:
 *   1. `porchVisitKnock` (web) — dials over libp2p with the new
 *      `Knock` method.
 *   2. KnocksAtTheDoor — renders the pending list and fires
 *      accept/reject through the porch API.
 *   3. PorchView — visibility-aware channel list with Knock /
 *      Withdraw affordances.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// --- Hoisted mocks --------------------------------------------------------

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn().mockReturnValue(true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../servitude", () => ({
  isTauri: isTauriMock,
}));

const browserVisitKnockMock = vi.fn();
const browserVisitKnockStatusMock = vi.fn();
const browserVisitWithdrawKnockMock = vi.fn();
const browserVisitListChannelsMock = vi.fn();

vi.mock("../../libp2p/porch", () => ({
  browserVisitKnock: browserVisitKnockMock,
  browserVisitKnockStatus: browserVisitKnockStatusMock,
  browserVisitWithdrawKnock: browserVisitWithdrawKnockMock,
  browserVisitListChannels: browserVisitListChannelsMock,
  browserVisitGetMessages: vi.fn(),
  browserVisitPostMessage: vi.fn(),
}));

// --- Imports under test (after mocks) -------------------------------------

import {
  porchVisitKnock,
  type Knock,
  type PorchListChannelRow,
} from "../porch";

// Used by the React component tests.
import { KnocksAtTheDoor } from "../../components/porch/KnocksAtTheDoor";
import { PorchView } from "../../components/porch/PorchView";
import { useVisitorStore } from "../../stores/visitorStore";

const samplePendingKnock: Knock = {
  id: "01HXXX",
  channel_id: "campaign-notes",
  knocker_peer_id: "12D3KooWVisitor",
  message: "DM let me into the campaign",
  status: "pending",
  created_at: 1717_000_000_000,
  resolved_at: null,
};

describe("porch knock API wrapper", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    browserVisitKnockMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  // ----------------------------------------------------------------------
  // (1) porchVisitKnock (web): dials via the browser libp2p module with
  //     the Knock method.
  // ----------------------------------------------------------------------
  it("porchVisitKnock (web): dials over libp2p with Knock method", async () => {
    isTauriMock.mockReturnValue(false);
    browserVisitKnockMock.mockResolvedValueOnce(samplePendingKnock);

    const result = await porchVisitKnock(
      "12D3KooWHost",
      "campaign-notes",
      "DM let me into the campaign",
    );

    expect(invokeMock).not.toHaveBeenCalled();
    expect(browserVisitKnockMock).toHaveBeenCalledWith(
      "12D3KooWHost",
      "campaign-notes",
      "DM let me into the campaign",
    );
    expect(result).toEqual(samplePendingKnock);
  });

  // ----------------------------------------------------------------------
  // (1b) porchVisitKnock (native): invokes the Tauri command with the
  //      correct camelCase params.
  // ----------------------------------------------------------------------
  it("porchVisitKnock (native): invokes porch_visit_knock", async () => {
    invokeMock.mockResolvedValueOnce(samplePendingKnock);

    const result = await porchVisitKnock(
      "12D3KooWHost",
      "campaign-notes",
      null,
    );

    expect(invokeMock).toHaveBeenCalledWith("porch_visit_knock", {
      peerId: "12D3KooWHost",
      channelId: "campaign-notes",
      message: null,
    });
    expect(result).toEqual(samplePendingKnock);
  });
});

describe("KnocksAtTheDoor component", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  // ----------------------------------------------------------------------
  // (2) KnocksAtTheDoor renders the pending list and fires
  //     accept/reject through invoke.
  // ----------------------------------------------------------------------
  it("renders pending knocks and fires accept", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "porch_pending_knocks") {
        return [samplePendingKnock];
      }
      if (cmd === "porch_accept_knock") {
        return { ...samplePendingKnock, status: "accepted" };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    render(<KnocksAtTheDoor channelNames={{ "campaign-notes": "Campaign Notes" }} />);

    // Wait for the pending row to appear.
    await waitFor(() =>
      expect(
        screen.getByTestId(`knock-row-${samplePendingKnock.id}`),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/DM let me into the campaign/)).toBeTruthy();
    expect(screen.getByText(/Campaign Notes/)).toBeTruthy();

    // Fire Accept.
    fireEvent.click(screen.getByTestId(`knock-accept-${samplePendingKnock.id}`));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("porch_accept_knock", {
        knockId: samplePendingKnock.id,
      });
    });
  });

  it("fires reject through the porch API", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "porch_pending_knocks") {
        return [samplePendingKnock];
      }
      if (cmd === "porch_reject_knock") {
        return { ...samplePendingKnock, status: "rejected" };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    render(<KnocksAtTheDoor />);

    await waitFor(() =>
      expect(
        screen.getByTestId(`knock-row-${samplePendingKnock.id}`),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId(`knock-reject-${samplePendingKnock.id}`));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("porch_reject_knock", {
        knockId: samplePendingKnock.id,
      });
    });
  });

  it("shows empty state when nobody is knocking", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "porch_pending_knocks") return [];
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    render(<KnocksAtTheDoor />);

    await waitFor(() => {
      expect(screen.getByTestId("knocks-empty")).toBeTruthy();
    });
  });
});

describe("PorchView (visit mode) — Phase B visibility rendering", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReturnValue(true);

    // Reset the visitor store between tests so we don't carry state.
    useVisitorStore.setState({
      currentPeerId: "12D3Host",
      channels: [],
      rows: [],
      selectedChannelId: null,
      messages: [],
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  function seedRows(rows: PorchListChannelRow[]) {
    useVisitorStore.setState({
      rows,
      channels: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        acl_mode: r.acl_mode,
        created_at: r.created_at,
      })),
    });
  }

  // ----------------------------------------------------------------------
  // (3) NeedsKnock channels render Knock button; pending channels
  //     render Withdraw badge.
  // ----------------------------------------------------------------------
  it("renders Knock button for NeedsKnock channels with no existing knock", () => {
    seedRows([
      {
        id: "porch-default",
        name: "Porch",
        kind: "porch",
        acl_mode: "open",
        created_at: 0,
        visibility: { kind: "visible" },
      },
      {
        id: "inner-1",
        name: "Campaign",
        kind: "inner",
        acl_mode: "allowlist",
        created_at: 0,
        visibility: { kind: "needs_knock", existing_knock: null },
      },
    ]);

    render(<PorchView mode="visit" />);

    // The visible Porch is selectable; the gated row has a Knock
    // button.
    expect(screen.getByTestId("knock-button")).toBeTruthy();
    expect(screen.getByText("Campaign")).toBeTruthy();
  });

  it("renders Withdraw badge for channels with a pending knock", () => {
    seedRows([
      {
        id: "inner-1",
        name: "Campaign",
        kind: "inner",
        acl_mode: "allowlist",
        created_at: 0,
        visibility: { kind: "needs_knock", existing_knock: "pending" },
      },
    ]);

    render(<PorchView mode="visit" />);

    expect(screen.getByTestId("knock-pending-badge")).toBeTruthy();
    expect(screen.getByText(/Waiting on host/)).toBeTruthy();
    expect(screen.getByText("Withdraw")).toBeTruthy();
  });

  it("renders the knock form when the user clicks the Knock button", () => {
    seedRows([
      {
        id: "inner-1",
        name: "Campaign",
        kind: "inner",
        acl_mode: "allowlist",
        created_at: 0,
        visibility: { kind: "needs_knock", existing_knock: null },
      },
    ]);

    render(<PorchView mode="visit" />);
    fireEvent.click(screen.getByTestId("knock-button"));
    expect(screen.getByTestId("knock-submit-button")).toBeTruthy();
    expect(
      screen.getByPlaceholderText(/Why are you knocking/),
    ).toBeTruthy();
  });
});
