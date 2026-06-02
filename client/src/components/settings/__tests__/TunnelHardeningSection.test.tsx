/**
 * Phase G — TunnelHardeningSection component tests.
 *
 * Covers the three user-observable behaviors:
 *   1. Toggling enforce calls `setTunnelConfig` with `enforce=true`.
 *   2. Adding an invalid CIDR surfaces a validation error and does
 *      NOT call the backend.
 *   3. Auto-detected CIDRs from the detect() report render verbatim.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// vi.mock is hoisted to the top of the file — module-level
// references inside the factory must be declared via `vi.hoisted`
// so they're initialized before the mock factory runs.
const mocks = vi.hoisted(() => ({
  setTunnelConfigMock: vi.fn(async (cfg: unknown) => cfg),
  getTunnelConfigMock: vi.fn(async () => ({
    enforce: false,
    extraCidrs: [] as string[],
  })),
  detectTunnelInterfacesMock: vi.fn(async () => ({
    autoDetectedCidrs: ["127.0.0.0/8", "::1/128", "10.7.0.0/24"],
    effectiveCidrs: ["127.0.0.0/8", "::1/128", "10.7.0.0/24"],
    enforceActive: false,
  })),
}));

vi.mock("../../../api/tunnel", async () => {
  // Re-export `validateCidr` from the real module so the form still
  // exercises the validation path.
  const actual = await vi.importActual<
    typeof import("../../../api/tunnel")
  >("../../../api/tunnel");
  return {
    ...actual,
    getTunnelConfig: mocks.getTunnelConfigMock,
    setTunnelConfig: mocks.setTunnelConfigMock,
    detectTunnelInterfaces: mocks.detectTunnelInterfacesMock,
  };
});

const { setTunnelConfigMock, getTunnelConfigMock, detectTunnelInterfacesMock } =
  mocks;

// Pretend to be Tauri so the component renders its full surface
// rather than the web placeholder.
vi.mock("../../../api/servitude", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../api/servitude")>();
  return {
    ...actual,
    isTauri: vi.fn(() => true),
  };
});

import { TunnelHardeningSection } from "../connections/TunnelHardeningSection";

describe("<TunnelHardeningSection />", () => {
  beforeEach(() => {
    setTunnelConfigMock.mockClear();
    getTunnelConfigMock.mockClear();
    detectTunnelInterfacesMock.mockClear();
    getTunnelConfigMock.mockResolvedValue({
      enforce: false,
      extraCidrs: [],
    });
    detectTunnelInterfacesMock.mockResolvedValue({
      autoDetectedCidrs: ["127.0.0.0/8", "::1/128", "10.7.0.0/24"],
      effectiveCidrs: ["127.0.0.0/8", "::1/128", "10.7.0.0/24"],
      enforceActive: false,
    });
  });

  it("toggles enforce and persists via setTunnelConfig with enforce=true", async () => {
    render(<TunnelHardeningSection />);
    const toggle = await screen.findByTestId("tunnel-enforce-toggle");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(setTunnelConfigMock).toHaveBeenCalledWith({
        enforce: true,
        extraCidrs: [],
      });
    });
  });

  it("shows a validation error and does NOT call the backend for an invalid CIDR", async () => {
    render(<TunnelHardeningSection />);
    const input = (await screen.findByTestId(
      "tunnel-add-cidr-input",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not-a-cidr" } });
    const addBtn = screen.getByTestId("tunnel-add-cidr-button");
    fireEvent.click(addBtn);

    const err = await screen.findByTestId("tunnel-cidr-validation-error");
    expect(err).toBeInTheDocument();
    expect(err.textContent).toMatch(/CIDR|prefix|address/i);
    // The validation gate must short-circuit BEFORE the backend call.
    // Initial mount fires getTunnelConfig + detectTunnelInterfaces but
    // NOT setTunnelConfig.
    expect(setTunnelConfigMock).not.toHaveBeenCalled();
  });

  it("renders the auto-detected CIDRs from the detect report", async () => {
    render(<TunnelHardeningSection />);
    const list = await screen.findByTestId("tunnel-auto-cidrs");
    expect(list.textContent).toContain("127.0.0.0/8");
    expect(list.textContent).toContain("10.7.0.0/24");
    expect(list.textContent).toContain("::1/128");
  });
});
