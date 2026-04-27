import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerPickerScreen } from "../ServerPickerScreen";
import * as wellKnownApi from "../../../api/wellKnown";
import {
  DnsResolutionError,
  HttpServerError,
  InvalidUrlError,
  type HomeserverConfig,
} from "../../../api/wellKnown";
import { useServerConfigStore } from "../../../stores/serverConfig";
import * as platformHook from "../../../hooks/usePlatform";

/**
 * Mock the discovery helper. Individual tests set the return value /
 * rejection per the scenario they're exercising.
 */
vi.mock("../../../api/wellKnown", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/wellKnown")>();
  return {
    ...actual,
    discoverHomeserver: vi.fn(),
  };
});

// Mock the Tauri serverUrl bridge so the store's setHomeserver()
// doesn't try to call into @tauri-apps/api/core at test time.
vi.mock("../../../api/serverUrl", () => ({
  setServerUrl: vi.fn(() => Promise.resolve()),
  getApiBase: vi.fn(() => "/api"),
  initServerUrl: vi.fn(() => Promise.resolve()),
  getServerUrl: vi.fn(() => ""),
  getHomeserverUrl: vi.fn(() => "https://test.local"),
  isDesktopMode: vi.fn(() => true),
  hasServerUrl: vi.fn(() => true),
}));

// Mock usePlatform so individual tests can flip the TV flag without
// having to set up matchMedia + navigator spoofing the way the
// usePlatform.test.ts file does. This keeps the ServerPickerScreen
// tests focused on rendering behavior rather than platform detection.
vi.mock("../../../hooks/usePlatform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../hooks/usePlatform")>();
  return {
    ...actual,
    usePlatform: vi.fn(() => ({
      isTauri: false,
      isMobile: false,
      isIOS: false,
      isAndroid: false,
      isIPad: false,
      isTV: false,
      isAndroidTV: false,
      isAppleTV: false,
      hasPointer: true,
      hasTouchOnly: false,
    })),
  };
});

const mockedDiscover = vi.mocked(wellKnownApi.discoverHomeserver);
const mockedPlatform = vi.mocked(platformHook.usePlatform);

function mockPlatformFlags(overrides: Partial<ReturnType<typeof platformHook.usePlatform>> = {}) {
  mockedPlatform.mockReturnValue({
    isTauri: false,
    isMobile: false,
    isIOS: false,
    isAndroid: false,
    isIPad: false,
    isTV: false,
    isAndroidTV: false,
    isAppleTV: false,
    hasPointer: true,
    hasTouchOnly: false,
    ...overrides,
  });
}

function makeConfig(overrides?: Partial<HomeserverConfig>): HomeserverConfig {
  return {
    host: "example.test",
    homeserver_url: "https://example.test",
    api_base: "https://example.test/api",
    livekit_url: "wss://example.test/livekit/",
    instance_name: "Example Instance",
    features: ["chat", "voice", "federation"],
    ...overrides,
  };
}

describe("<ServerPickerScreen />", () => {
  beforeEach(() => {
    mockedDiscover.mockReset();
    // Default to non-TV. Individual TV tests override via mockPlatformFlags.
    mockPlatformFlags();
    // Reset the store between tests so each test starts from a known
    // blank-slate state.
    useServerConfigStore.setState({ config: null });
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("renders the hostname input and a disabled Connect button initially", () => {
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    expect(screen.getByTestId("server-picker-hostname-input")).toBeInTheDocument();
    expect(screen.getByTestId("server-picker-connect-button")).toBeDisabled();
  });

  it("enables the Connect button once a hostname is typed", async () => {
    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    const input = screen.getByTestId("server-picker-hostname-input");
    await user.type(input, "example.test");

    expect(screen.getByTestId("server-picker-connect-button")).toBeEnabled();
  });

  it("runs discoverHomeserver on Connect and transitions to the success state", async () => {
    const cfg = makeConfig();
    mockedDiscover.mockResolvedValueOnce(cfg);

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "example.test",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));

    await waitFor(() => {
      expect(screen.getByTestId("server-picker-success")).toBeInTheDocument();
    });

    expect(mockedDiscover).toHaveBeenCalledWith("example.test");
    expect(screen.getByTestId("server-picker-host")).toHaveTextContent(
      "example.test",
    );
    expect(screen.getByTestId("server-picker-api-base")).toHaveTextContent(
      "https://example.test/api",
    );
    // Instance name from the discovered config is displayed.
    expect(
      screen.getByText("Example Instance"),
    ).toBeInTheDocument();
  });

  it("surfaces a DNS-specific message when discovery rejects with DnsResolutionError", async () => {
    mockedDiscover.mockRejectedValueOnce(
      new DnsResolutionError("bogus.nxdomain.example"),
    );

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "bogus.nxdomain.example",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));

    await waitFor(() => {
      expect(screen.getByTestId("server-picker-error")).toBeInTheDocument();
    });

    // Distinct copy for DNS failures — "Couldn't reach that host..."
    expect(screen.getByText(/couldn't reach that host/i)).toBeInTheDocument();
  });

  it("surfaces a distinct HTTP-error message when discovery rejects with HttpServerError", async () => {
    mockedDiscover.mockRejectedValueOnce(
      new HttpServerError("example.test", 503),
    );

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "example.test",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));

    await waitFor(() => {
      expect(screen.getByTestId("server-picker-error")).toBeInTheDocument();
    });

    // DnsResolutionError copy MUST NOT be present — verifying the
    // error message is class-specific.
    expect(screen.queryByText(/couldn't reach that host/i)).not.toBeInTheDocument();
    expect(screen.getByText(/returning errors/i)).toBeInTheDocument();
  });

  it("surfaces a distinct InvalidUrl message when discovery rejects with InvalidUrlError", async () => {
    mockedDiscover.mockRejectedValueOnce(
      new InvalidUrlError("not a url", "hostname is not well-formed"),
    );

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "not a url",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));

    await waitFor(() => {
      expect(screen.getByTestId("server-picker-error")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/doesn't look like a valid hostname/i),
    ).toBeInTheDocument();
  });

  it("returns to the input state when Try again is clicked from the error state", async () => {
    mockedDiscover.mockRejectedValueOnce(
      new DnsResolutionError("bogus.nxdomain.example"),
    );

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "bogus.nxdomain.example",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));

    await waitFor(() =>
      expect(screen.getByTestId("server-picker-error")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("server-picker-retry-button"));

    expect(screen.getByTestId("server-picker-input-form")).toBeInTheDocument();
    // The typed hostname persists across the retry so the user can
    // edit it rather than re-typing from scratch.
    expect(screen.getByTestId("server-picker-hostname-input")).toHaveValue(
      "bogus.nxdomain.example",
    );
  });

  it("calls setHomeserver on Confirm and invokes onConnected exactly once", async () => {
    const cfg = makeConfig();
    mockedDiscover.mockResolvedValueOnce(cfg);
    const onConnected = vi.fn();

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={onConnected} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "example.test",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));
    await waitFor(() =>
      expect(screen.getByTestId("server-picker-success")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("server-picker-confirm-button"));

    // The store has the discovered config.
    const stored = useServerConfigStore.getState().config;
    expect(stored).toEqual(cfg);

    // Parent is told the picker is done.
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("applies the advanced api_base override when Confirm is pressed", async () => {
    const cfg = makeConfig({ api_base: "https://default.example/api" });
    mockedDiscover.mockResolvedValueOnce(cfg);

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "example.test",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));
    await waitFor(() =>
      expect(screen.getByTestId("server-picker-success")).toBeInTheDocument(),
    );

    // Open the advanced section and override the api_base.
    const override = screen.getByTestId("server-picker-api-base-override-input");
    await user.clear(override);
    await user.type(override, "https://override.example/concord/api");

    await user.click(screen.getByTestId("server-picker-confirm-button"));

    const stored = useServerConfigStore.getState().config;
    expect(stored?.api_base).toBe("https://override.example/concord/api");
    // The rest of the discovered config is preserved untouched.
    expect(stored?.host).toBe(cfg.host);
    expect(stored?.homeserver_url).toBe(cfg.homeserver_url);
  });

  it("parses a pasted JSON blob and jumps straight to the success state", async () => {
    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    // Use fireEvent.change to set the textarea value directly — userEvent.type
    // parses `{` and `}` as keyboard command tokens, which breaks JSON input.
    const blob = JSON.stringify(makeConfig({ instance_name: "Pasted Config" }));
    const textarea = screen.getByTestId("server-picker-paste-textarea");
    fireEvent.change(textarea, { target: { value: blob } });

    await user.click(screen.getByTestId("server-picker-paste-button"));

    await waitFor(() => {
      expect(screen.getByTestId("server-picker-success")).toBeInTheDocument();
    });
    expect(screen.getByText("Pasted Config")).toBeInTheDocument();
    // discoverHomeserver was NOT called — paste path bypasses it.
    expect(mockedDiscover).not.toHaveBeenCalled();
  });

  it("rejects a pasted config that uses non-HTTPS URLs", async () => {
    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    const blob = JSON.stringify({
      host: "evil.example",
      homeserver_url: "http://evil.example",
      api_base: "http://evil.example/api",
    });
    fireEvent.change(screen.getByTestId("server-picker-paste-textarea"), {
      target: { value: blob },
    });
    await user.click(screen.getByTestId("server-picker-paste-button"));

    await waitFor(() =>
      expect(screen.getByTestId("server-picker-error")).toBeInTheDocument(),
    );
    expect(screen.getByText(/non-HTTPS URLs/i)).toBeInTheDocument();
  });

  // ------------------------------------------------------------------
  // TV mode (INS-023)
  // ------------------------------------------------------------------

  describe("TV mode", () => {
    it("applies the tv-server-picker wrapper class when isTV is true", () => {
      mockPlatformFlags({ isTV: true });
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const root = screen.getByTestId("server-picker-screen");
      expect(root.className).toContain("tv-server-picker");
      expect(root.getAttribute("data-tv-picker")).toBe("true");
    });

    it("does NOT apply the tv-server-picker class when isTV is false", () => {
      mockPlatformFlags({ isTV: false });
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const root = screen.getByTestId("server-picker-screen");
      expect(root.className).not.toContain("tv-server-picker");
      expect(root.getAttribute("data-tv-picker")).toBeNull();
    });

    it("marks the hostname input and Connect button as data-focusable under TV", () => {
      mockPlatformFlags({ isTV: true });
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const input = screen.getByTestId("server-picker-hostname-input");
      const button = screen.getByTestId("server-picker-connect-button");
      expect(input.getAttribute("data-focusable")).toBe("true");
      expect(input.getAttribute("data-focus-group")).toBe("tv-server-picker");
      expect(button.getAttribute("data-focusable")).toBe("true");
      expect(button.getAttribute("data-focus-group")).toBe("tv-server-picker");
    });

    it("does NOT mark inputs as data-focusable under non-TV", () => {
      mockPlatformFlags({ isTV: false });
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const input = screen.getByTestId("server-picker-hostname-input");
      const button = screen.getByTestId("server-picker-connect-button");
      expect(input.getAttribute("data-focusable")).toBeNull();
      expect(button.getAttribute("data-focusable")).toBeNull();
    });

    it("exposes data-focusable buttons on the success screen so DPAD can navigate to Confirm", async () => {
      mockPlatformFlags({ isTV: true });
      mockedDiscover.mockResolvedValueOnce(makeConfig());

      const user = userEvent.setup();
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      await user.type(
        screen.getByTestId("server-picker-hostname-input"),
        "concorrd.example",
      );
      await user.click(screen.getByTestId("server-picker-connect-button"));

      await waitFor(() =>
        expect(screen.getByTestId("server-picker-success")).toBeInTheDocument(),
      );

      const confirm = screen.getByTestId("server-picker-confirm-button");
      const change = screen.getByTestId("server-picker-change-button");
      expect(confirm.getAttribute("data-focusable")).toBe("true");
      expect(change.getAttribute("data-focusable")).toBe("true");
    });
  });

  // ------------------------------------------------------------------
  // Top-level menu (Join / Matrix / Host / Skip)
  //
  // The picker shows its top-level menu only on platforms that can host
  // (`isTauri && !isMobile`). On non-host platforms it skips the menu
  // and renders the hostname input immediately, so these tests flip
  // `isTauri: true` before rendering.
  // ------------------------------------------------------------------

  describe("desktop menu (Matrix / Host / Skip)", () => {
    beforeEach(() => {
      mockPlatformFlags({ isTauri: true, isMobile: false });
    });

    it("renders all picker cards on cold launch", () => {
      render(<ServerPickerScreen onConnected={vi.fn()} />);
      expect(screen.getByTestId("server-picker-menu")).toBeInTheDocument();
      expect(screen.getByTestId("server-picker-choose-join")).toBeInTheDocument();
      expect(screen.getByTestId("server-picker-choose-matrix")).toBeInTheDocument();
      expect(screen.getByTestId("server-picker-choose-host")).toBeInTheDocument();
    });

    it("shows the Skip link when onSkip is provided and fires it on click", async () => {
      const onSkip = vi.fn();
      const user = userEvent.setup();
      render(<ServerPickerScreen onConnected={vi.fn()} onSkip={onSkip} />);

      const skip = screen.getByTestId("server-picker-skip");
      expect(skip).toBeInTheDocument();
      await user.click(skip);
      expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it("hides the Skip link when onSkip is not provided", () => {
      render(<ServerPickerScreen onConnected={vi.fn()} />);
      expect(screen.queryByTestId("server-picker-skip")).not.toBeInTheDocument();
    });

    it("Matrix card synthesizes a config WITHOUT calling discoverHomeserver", async () => {
      const user = userEvent.setup();
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      await user.click(screen.getByTestId("server-picker-choose-matrix"));
      const input = screen.getByTestId("server-picker-hostname-input");
      await user.type(input, "matrix.org");
      await user.click(screen.getByTestId("server-picker-connect-button"));

      // Matrix path skips Concord well-known discovery entirely.
      expect(mockedDiscover).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.getByTestId("server-picker-success")).toBeInTheDocument(),
      );
      expect(screen.getByTestId("server-picker-host")).toHaveTextContent("matrix.org");
      expect(screen.getByTestId("server-picker-api-base")).toHaveTextContent(
        "https://matrix.org",
      );
    });
  });
});
