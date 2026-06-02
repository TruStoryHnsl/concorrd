import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the hostingProfile module so each test can pin the backend
// behavior directly. We don't import the real wrapper because that
// would also bring in the dynamic Tauri import path; the wrapper
// already has its own unit tests in api/__tests__/hostingProfile.test.ts.
vi.mock("../../../api/hostingProfile", () => ({
  fetchHostingProfile: vi.fn(),
  setHostingProfile: vi.fn(),
  enableWebStack: vi.fn(),
}));

// Mock the `isTauri()` detector. The section's behavior branches on
// it, so each test pins it explicitly.
vi.mock("../../../api/servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(),
  };
});

// Stub the auth store to a logged-in shape so the section's
// authenticated calls (`enableWebStack`, `fetchHostingProfile` on web)
// have a bearer token to send. Tests that need the unauthenticated
// path can override via setState.
vi.mock("../../../stores/auth", () => ({
  useAuthStore: Object.assign(
    (selector: (s: { accessToken: string | null }) => unknown) =>
      selector({ accessToken: "test-token" }),
    { getState: () => ({ accessToken: "test-token" }) },
  ),
}));

import * as hostingProfileApi from "../../../api/hostingProfile";
import * as servitudeApi from "../../../api/servitude";
import { DeploymentProfileSection } from "../DeploymentProfileSection";

const fetchMock = vi.mocked(hostingProfileApi.fetchHostingProfile);
const setProfileMock = vi.mocked(hostingProfileApi.setHostingProfile);
const enableMock = vi.mocked(hostingProfileApi.enableWebStack);
const isTauriMock = vi.mocked(servitudeApi.isTauri);

describe("<DeploymentProfileSection />", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setProfileMock.mockReset();
    enableMock.mockReset();
    isTauriMock.mockReset();
  });

  it("native + p2p_only: renders the off toggle and the P2P helper text", async () => {
    isTauriMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce({
      profile: "p2p_only",
      webStackRunning: false,
      lastChanged: null,
    });

    render(<DeploymentProfileSection />);

    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-toggle"),
      ).toHaveAttribute("aria-checked", "false");
    });
    // The P2P-only helper text must render so the user sees what the
    // off state actually means.
    expect(
      screen.getByTestId("deployment-profile-p2p-helper"),
    ).toBeInTheDocument();
    // Toggle is enabled in native mode.
    expect(
      screen.getByTestId("deployment-profile-toggle"),
    ).not.toBeDisabled();
  });

  it("native + web_first: renders the on toggle and shows web-stack running status", async () => {
    isTauriMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce({
      profile: "web_first",
      webStackRunning: true,
      lastChanged: null,
    });

    render(<DeploymentProfileSection />);

    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-toggle"),
      ).toHaveAttribute("aria-checked", "true");
    });
    const webHelper = screen.getByTestId("deployment-profile-web-helper");
    expect(webHelper).toBeInTheDocument();
    expect(webHelper).toHaveTextContent("Caddy");
    // Running-state badge must reflect the snapshot.
    expect(
      screen.getByTestId("deployment-profile-web-stack-status"),
    ).toHaveTextContent("Web stack running");
  });

  it("web build: renders the toggle disabled and shows the env-var note", async () => {
    isTauriMock.mockReturnValue(false);
    fetchMock.mockResolvedValueOnce({
      profile: "web_first",
      webStackRunning: true,
      lastChanged: null,
    });

    render(<DeploymentProfileSection />);

    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-toggle"),
      ).toBeDisabled();
    });
    expect(
      screen.getByTestId("deployment-profile-web-helper"),
    ).toHaveTextContent("CONCORD_PROFILE");
  });

  it("flipping p2p_only -> web_first shows confirm modal, then calls setHostingProfile + enableWebStack", async () => {
    const user = userEvent.setup();
    isTauriMock.mockReturnValue(true);
    // First load: p2p_only.
    fetchMock.mockResolvedValueOnce({
      profile: "p2p_only",
      webStackRunning: false,
      lastChanged: null,
    });
    // After confirming, the section re-fetches — second response is
    // post-flip web_first.
    fetchMock.mockResolvedValueOnce({
      profile: "web_first",
      webStackRunning: true,
      lastChanged: null,
    });
    setProfileMock.mockResolvedValueOnce(undefined);
    enableMock.mockResolvedValueOnce({
      profile: "web_first",
      webStackRunning: true,
      voice: {},
      startedServices: ["id-conduwuit", "id-livekit"],
      alreadyRunningServices: [],
      message: null,
    });

    render(<DeploymentProfileSection />);

    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-toggle"),
      ).toHaveAttribute("aria-checked", "false");
    });

    // Click the toggle → confirm modal opens.
    await user.click(screen.getByTestId("deployment-profile-toggle"));
    expect(
      screen.getByTestId("deployment-profile-confirm-modal"),
    ).toBeInTheDocument();

    // Click Continue.
    await user.click(
      screen.getByTestId("deployment-profile-confirm-enable"),
    );

    // Both backend calls must have happened.
    await waitFor(() => {
      expect(setProfileMock).toHaveBeenCalledWith("web_first");
    });
    expect(enableMock).toHaveBeenCalledTimes(1);

    // Modal closed and the toggle reflects the new state.
    await waitFor(() => {
      expect(
        screen.queryByTestId("deployment-profile-confirm-modal"),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-toggle"),
      ).toHaveAttribute("aria-checked", "true");
    });
  });

  it("cancel button on confirm modal closes it without calling the backend", async () => {
    const user = userEvent.setup();
    isTauriMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce({
      profile: "p2p_only",
      webStackRunning: false,
      lastChanged: null,
    });

    render(<DeploymentProfileSection />);

    await waitFor(() => {
      expect(
        screen.getByTestId("deployment-profile-toggle"),
      ).toHaveAttribute("aria-checked", "false");
    });

    await user.click(screen.getByTestId("deployment-profile-toggle"));
    expect(
      screen.getByTestId("deployment-profile-confirm-modal"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByTestId("deployment-profile-confirm-cancel"),
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("deployment-profile-confirm-modal"),
      ).not.toBeInTheDocument();
    });
    expect(setProfileMock).not.toHaveBeenCalled();
    expect(enableMock).not.toHaveBeenCalled();
  });
});
