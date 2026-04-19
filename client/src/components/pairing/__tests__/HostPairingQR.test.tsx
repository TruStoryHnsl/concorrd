import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HostPairingQR } from "../HostPairingQR";
import { useServerConfigStore } from "../../../stores/serverConfig";
import { decodePairingPayload } from "../pairingSchema";

/**
 * User-visible behavior for HostPairingQR:
 *   1. If no server is selected, an informational "pairing unavailable"
 *      block is shown — the user sees text explaining they must pick a
 *      server first.
 *   2. When a server IS selected, the user sees:
 *        - the `concord+pair://v1/?d=...` URL in a code block
 *        - a Copy button that writes the URL to the clipboard
 *        - (after a macrotask) a QR <img> with a non-empty data URL
 *   3. The encoded URL round-trips through `decodePairingPayload` and
 *      produces a payload whose `host`, `homeserver_url`, and `api_base`
 *      match what the user picked — this is the same object the guest
 *      scanner will eventually write to `setHomeserver`.
 */

describe("<HostPairingQR />", () => {
  beforeEach(() => {
    // Start every test from a clean serverConfig store.
    useServerConfigStore.setState({ config: null });
  });

  afterEach(() => {
    useServerConfigStore.setState({ config: null });
  });

  it("shows the 'pick a server first' notice when no config is present", () => {
    render(<HostPairingQR />);
    expect(screen.getByTestId("host-pairing-qr-empty")).toBeInTheDocument();
  });

  it("renders a URL the guest scanner can round-trip, plus a QR image once generation resolves", async () => {
    useServerConfigStore.setState({
      config: {
        host: "concordchat.net",
        homeserver_url: "https://concordchat.net",
        api_base: "https://concordchat.net/api",
        instance_name: "Concord Public",
      },
    });

    render(<HostPairingQR />);

    // URL appears immediately (sync encode).
    const codeEl = await screen.findByTestId("host-pairing-qr-url");
    const urlText = codeEl.textContent ?? "";
    expect(urlText.startsWith("concord+pair://v1/?d=")).toBe(true);

    // The URL must round-trip through the decoder to the same instance
    // the user picked — this is the load-bearing contract: what the
    // user sees encoded is exactly what the guest scanner will commit
    // to `setHomeserver` on the other phone.
    const decoded = decodePairingPayload(urlText);
    expect(decoded.host).toBe("concordchat.net");
    expect(decoded.homeserver_url).toBe("https://concordchat.net");
    expect(decoded.api_base).toBe("https://concordchat.net/api");
    expect(decoded.instance_name).toBe("Concord Public");

    // QR <img> resolves after `QRCode.toDataURL` settles; use findBy* so
    // we wait through the async effect.
    const img = await screen.findByTestId("host-pairing-qr-image");
    expect(img).toBeInTheDocument();
    const src = img.getAttribute("src") ?? "";
    expect(src.startsWith("data:image/")).toBe(true);
    expect(src.length).toBeGreaterThan(100);
  });

  it("copies the pairing URL to the clipboard when Copy is clicked", async () => {
    useServerConfigStore.setState({
      config: {
        host: "concordchat.net",
        homeserver_url: "https://concordchat.net",
        api_base: "https://concordchat.net/api",
      },
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    // Install the clipboard stub BEFORE userEvent.setup so its
    // internal clipboard helper picks up our mock rather than the
    // jsdom default.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<HostPairingQR />);
    await screen.findByTestId("host-pairing-qr-url");

    // Direct DOM click — avoids userEvent's own clipboard integration
    // path which can race against our stub.
    const btn = screen.getByTestId("host-pairing-qr-copy");
    btn.click();

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const payload = writeText.mock.calls[0][0] as string;
    expect(payload.startsWith("concord+pair://v1/?d=")).toBe(true);

    // After a successful copy, the button text flips to "Copied!"
    await waitFor(() => {
      expect(screen.getByTestId("host-pairing-qr-copy")).toHaveTextContent("Copied!");
    });
  });
});
