/**
 * HostingTab — deployment profile section presence.
 *
 * After the 2026-05-30 relocation, `<DeploymentProfileSection />` lives
 * inside HostingTab. This pins that it actually renders (positive
 * assertion). The toggle's own behavior is covered by
 * `DeploymentProfileSection.test.tsx`.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, waitFor, screen } from "@testing-library/react";

vi.mock("../../../api/hostingProfile", () => ({
  fetchHostingProfile: vi.fn(async () => ({
    profile: "p2p_only",
    webStackRunning: false,
    lastChanged: null,
  })),
  setHostingProfile: vi.fn(),
  enableWebStack: vi.fn(),
}));

vi.mock("../../../api/servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(() => false),
    servitudeStatus: vi.fn(async () => ({
      state: "running",
      degraded_transports: {},
    })),
  };
});

// AdminTab pulls in concord API + various hooks. Stub it out to keep
// the test focused on HostingTab's outer composition.
vi.mock("../AdminTab", () => ({
  AdminTab: () => <div data-testid="admin-tab-stub">admin</div>,
}));

// /api/health fetch — return a 200 so the hosting-status hook resolves
// to "running" without complaint.
beforeEach(() => {
  global.fetch = vi.fn(async () =>
    new Response(null, { status: 200 }),
  ) as unknown as typeof fetch;
});

import { HostingTab } from "../HostingTab";

describe("<HostingTab /> + DeploymentProfileSection", () => {
  it("renders the deployment profile section beneath the existing content", async () => {
    render(<HostingTab />);

    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-section"),
      ).toBeInTheDocument();
    });
    // Admin content still renders above the new section.
    expect(screen.getByTestId("admin-tab-stub")).toBeInTheDocument();
  });
});
