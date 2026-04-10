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

const mockedDiscover = vi.mocked(wellKnownApi.discoverHomeserver);

function makeConfig(overrides?: Partial<HomeserverConfig>): HomeserverConfig {
  return {
    host: "concorrd.example",
    homeserver_url: "https://concorrd.example",
    api_base: "https://concorrd.example/api",
    livekit_url: "wss://concorrd.example/livekit/",
    instance_name: "Concorrd Example",
    features: ["chat", "voice", "federation"],
    ...overrides,
  };
}

describe("<ServerPickerScreen />", () => {
  beforeEach(() => {
    mockedDiscover.mockReset();
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
    await user.type(input, "concorrd.example");

    expect(screen.getByTestId("server-picker-connect-button")).toBeEnabled();
  });

  it("runs discoverHomeserver on Connect and transitions to the success state", async () => {
    const cfg = makeConfig();
    mockedDiscover.mockResolvedValueOnce(cfg);

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "concorrd.example",
    );
    await user.click(screen.getByTestId("server-picker-connect-button"));

    await waitFor(() => {
      expect(screen.getByTestId("server-picker-success")).toBeInTheDocument();
    });

    expect(mockedDiscover).toHaveBeenCalledWith("concorrd.example");
    expect(screen.getByTestId("server-picker-host")).toHaveTextContent(
      "concorrd.example",
    );
    expect(screen.getByTestId("server-picker-api-base")).toHaveTextContent(
      "https://concorrd.example/api",
    );
    // Instance name from the discovered config is displayed.
    expect(
      screen.getByText("Concorrd Example"),
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
      new HttpServerError("concorrd.example", 503),
    );

    const user = userEvent.setup();
    render(<ServerPickerScreen onConnected={vi.fn()} />);

    await user.type(
      screen.getByTestId("server-picker-hostname-input"),
      "concorrd.example",
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
      "concorrd.example",
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
      "concorrd.example",
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

  describe("TV mode (isTV: true)", () => {
    beforeEach(() => {
      // Simulate a TV environment by injecting the concordTVHost bridge
      // object that the tvOS WKWebView shell injects at document-start.
      // usePlatform() detects Apple TV via `"concordTVHost" in window`.
      (window as Record<string, unknown>).concordTVHost = {};
      // TV detection also relies on matchMedia returning pointer:none
      // for remote-only devices and a large screen.
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1920,
      });
      Object.defineProperty(window, "innerHeight", {
        writable: true,
        configurable: true,
        value: 1080,
      });
    });

    afterEach(() => {
      delete (window as Record<string, unknown>).concordTVHost;
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 1024,
      });
      Object.defineProperty(window, "innerHeight", {
        writable: true,
        configurable: true,
        value: 768,
      });
    });

    it("renders with data-tv-mode attribute when running on TV", () => {
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const root = screen.getByTestId("server-picker-screen");
      expect(root).toHaveAttribute("data-tv-mode");
    });

    it("applies wider layout class for TV 10-foot viewing", () => {
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const root = screen.getByTestId("server-picker-screen");
      expect(root.className).toContain("tv-picker-layout");
    });

    it("still renders the hostname input and allows interaction on TV", async () => {
      const cfg = makeConfig();
      mockedDiscover.mockResolvedValueOnce(cfg);

      const user = userEvent.setup();
      render(<ServerPickerScreen onConnected={vi.fn()} />);

      const input = screen.getByTestId("server-picker-hostname-input");
      expect(input).toBeInTheDocument();

      await user.type(input, "concorrd.example");
      expect(screen.getByTestId("server-picker-connect-button")).toBeEnabled();

      await user.click(screen.getByTestId("server-picker-connect-button"));

      await waitFor(() => {
        expect(screen.getByTestId("server-picker-success")).toBeInTheDocument();
      });
    });
  });
});
