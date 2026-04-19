import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { GuestPairingScanner, scanImageData } from "../GuestPairingScanner";
import { encodePairingPayload } from "../pairingSchema";

/**
 * jsQR is mocked at module scope. Tests push a return value via
 * `mockJsQRResult` for each case.
 */
vi.mock("jsqr", () => ({
  default: vi.fn((_data: Uint8ClampedArray, _w: number, _h: number) => {
    return __mockJsQRResult;
  }),
}));

// Shared mock shuttle — set per-test.
let __mockJsQRResult: { data: string } | null = null;

describe("scanImageData()", () => {
  beforeEach(() => {
    __mockJsQRResult = null;
  });

  it("returns a HomeserverConfig when jsQR decodes a valid pairing URL", () => {
    const encoded = encodePairingPayload({
      host: "concordchat.net",
      homeserver_url: "https://concordchat.net",
      api_base: "https://concordchat.net/api",
    });
    __mockJsQRResult = { data: encoded };

    const imageData = {
      data: new Uint8ClampedArray(4 * 10 * 10),
      width: 10,
      height: 10,
    } as ImageData;
    const result = scanImageData(imageData);
    expect(result).not.toBeNull();
    expect(result?.host).toBe("concordchat.net");
    expect(result?.api_base).toBe("https://concordchat.net/api");
  });

  it("returns null when jsQR finds no code in the frame", () => {
    __mockJsQRResult = null;
    const imageData = {
      data: new Uint8ClampedArray(4 * 10 * 10),
      width: 10,
      height: 10,
    } as ImageData;
    expect(scanImageData(imageData)).toBeNull();
  });
});

/**
 * Full component tests: these drive the user-visible paths — permission
 * denial, no camera available, manual paste success — without actually
 * opening a camera.
 */
describe("<GuestPairingScanner />", () => {
  // Stash the original mediaDevices so each test can swap it cleanly.
  const originalMediaDevices = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "mediaDevices",
  );

  afterEach(() => {
    cleanup();
    if (originalMediaDevices) {
      Object.defineProperty(
        Navigator.prototype,
        "mediaDevices",
        originalMediaDevices,
      );
    }
  });

  it("renders a permission-denied panel with Retry when getUserMedia throws NotAllowedError", async () => {
    const notAllowed = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    const getUserMedia = vi.fn().mockRejectedValue(notAllowed);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<GuestPairingScanner onSuccess={onSuccess} onClose={onClose} />);

    await waitFor(() => {
      expect(
        screen.getByTestId("guest-pairing-scanner-permission-denied"),
      ).toBeInTheDocument();
    });

    // Retry button is visible and wired.
    expect(screen.getByTestId("guest-pairing-scanner-retry")).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("renders a no-camera panel when mediaDevices is absent entirely", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<GuestPairingScanner onSuccess={onSuccess} onClose={onClose} />);

    await waitFor(() => {
      expect(
        screen.getByTestId("guest-pairing-scanner-no-camera"),
      ).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("commits setHomeserver-equivalent config when the user pastes a valid URL into the manual fallback", async () => {
    // Force the camera into error state so the manual path is the only
    // interaction surface.
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();
    const encoded = encodePairingPayload({
      host: "concordchat.net",
      homeserver_url: "https://concordchat.net",
      api_base: "https://concordchat.net/api",
      instance_name: "Concord Public",
    });

    render(<GuestPairingScanner onSuccess={onSuccess} onClose={onClose} />);

    // Wait for the no-camera panel so we know initial setup completed.
    await waitFor(() => {
      expect(
        screen.getByTestId("guest-pairing-scanner-no-camera"),
      ).toBeInTheDocument();
    });

    const input = screen.getByTestId(
      "guest-pairing-scanner-manual-input",
    ) as HTMLInputElement;
    // React is the source of truth for controlled input state;
    // fireEvent.change goes through the synthetic event path and
    // triggers the onChange handler correctly.
    fireEvent.change(input, { target: { value: encoded } });

    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    const passed = onSuccess.mock.calls[0][0] as {
      host: string;
      homeserver_url: string;
      api_base: string;
      instance_name?: string;
    };
    expect(passed.host).toBe("concordchat.net");
    expect(passed.homeserver_url).toBe("https://concordchat.net");
    expect(passed.api_base).toBe("https://concordchat.net/api");
    expect(passed.instance_name).toBe("Concord Public");
  });

  it("shows a decode-error panel without closing when the manual paste is invalid", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<GuestPairingScanner onSuccess={onSuccess} onClose={onClose} />);

    await waitFor(() => {
      expect(
        screen.getByTestId("guest-pairing-scanner-no-camera"),
      ).toBeInTheDocument();
    });

    const input = screen.getByTestId(
      "guest-pairing-scanner-manual-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "concord+pair://v2/?d=garbage" } });

    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByTestId("guest-pairing-scanner-decode-error"),
      ).toBeInTheDocument();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
