/**
 * ProfileTab tests for the web build (post-2026-05-30 relocation).
 *
 * After the P2P UI relocation that moved the peer-identity, swarm
 * status, paired-peers, and deployment-profile sections out of Profile
 * into Connections / Hosting, the only behavior left for this file to
 * pin is the NEGATIVE assertion that those surfaces no longer render
 * here. The corresponding positive assertions live in
 * `UserConnectionsTab.peer.test.tsx` and
 * `HostingTab.deploymentProfile.test.tsx`.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Hoisted mocks ────────────────────────────────────────────────
const { isTauriMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(),
}));

vi.mock("../../../api/servitude", () => ({
  isTauri: isTauriMock,
}));

// Concord API surface — mocked because the Profile tab calls it for
// TOTP / recovery-email status on mount.
vi.mock("../../../api/concord", () => ({
  changePassword: vi.fn(),
  getTOTPStatus: vi.fn(async () => ({ enabled: false })),
  setupTOTP: vi.fn(),
  verifyTOTP: vi.fn(),
  disableTOTP: vi.fn(),
  getRecoveryEmailStatus: vi.fn(async () => ({ has_recovery_email: false })),
  setRecoveryEmail: vi.fn(),
}));

import { ProfileTab } from "../ProfileTab";
import { useAuthStore } from "../../../stores/auth";

describe("<ProfileTab /> (post-relocation)", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    useAuthStore.setState({
      client: null,
      userId: "@webuser:example.org",
      accessToken: null,
      isLoggedIn: true,
      isLoading: false,
      isGuest: false,
      syncing: false,
    });
  });

  /**
   * The peer-connections surfaces — peer identity row, swarm status
   * block, paired peers section, Add-a-peer button — are NOT rendered
   * by ProfileTab anymore. They live under UserConnectionsTab.
   */
  it("does NOT render the peer / swarm / paired-peers surfaces", () => {
    render(<ProfileTab />);

    expect(screen.queryByText(/peer identity/i)).toBeNull();
    expect(screen.queryByText(/session identity \(ephemeral\)/i)).toBeNull();
    expect(screen.queryByTestId("swarm-peers-row")).toBeNull();
    expect(screen.queryByText(/paired peers/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /add a peer/i }),
    ).toBeNull();
  });

  /**
   * The deployment profile section was relocated to HostingTab.
   */
  it("does NOT render the deployment profile section", () => {
    render(<ProfileTab />);

    expect(
      screen.queryByTestId("deployment-profile-section"),
    ).toBeNull();
    expect(screen.queryByText(/deployment profile/i)).toBeNull();
  });
});
