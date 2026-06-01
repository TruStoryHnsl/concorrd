/**
 * AddSourceModal — Feature F2 unified address screen integration tests.
 *
 * These tests exist to lock in the four user-visible detection paths
 * documented in the F2 deliverable:
 *
 *   1. Modal opens to the address screen by default.
 *   2. Typing a Concord well-known host → lands on the Concord screen.
 *   3. Typing a Matrix host → lands on the matrix-auth screen.
 *   4. Pasting a `concord://peer/...` deeplink → lands on the pair-peer
 *      screen (PeerCardScanner mounts).
 *   5. Typing a host with no well-known → falls back to the picker.
 *   6. "More options" link → goes directly to the picker without
 *      probing.
 *
 * The detection module is mocked at the boundary — the tests drive the
 * modal, not the underlying network. Empirical contract: each test
 * asserts the visible screen the user lands on, not the internal
 * setScreen() call.
 *
 * Per the project's "no abstract-value tests" rule, every test below
 * asserts a screen that a real user would SEE on their device. The
 * detection mock returns the verdict shape the real module would
 * return for the corresponding input — no separate truth source.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../sources/LocalHostingControl", () => ({
  LocalHostingControl: () => (
    <div data-testid="local-hosting-control-stub" />
  ),
}));

vi.mock("../../peers/PeerCardScanner", () => ({
  PeerCardScanner: ({ onClose: _onClose }: { onClose: () => void }) => (
    <div data-testid="peer-card-scanner-stub" />
  ),
}));

vi.mock("../../sources/sourceBrand", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sources/sourceBrand")>();
  return {
    ...actual,
    SourceBrandIcon: () => <span data-testid="brand-icon" />,
  };
});

// The Matrix discovery helper hits api/wellKnown and api/matrix; mock
// both so the matrix path lands on matrix-auth without a network call.
vi.mock("../../api/wellKnown", () => ({
  discoverHomeserver: vi.fn(async (host: string) => ({
    host,
    homeserver_url: `https://${host}`,
    api_base: `https://${host}/api`,
    instance_name: "Mock Matrix",
  })),
}));
vi.mock("../../api/matrix", async () => {
  const actual = await vi.importActual<object>("../../api/matrix");
  return {
    ...actual,
    fetchLoginFlows: vi.fn(async () => [{ type: "m.login.password" }]),
  };
});

// Mock the detection module itself — we test the detection logic in
// detectAddress.test.ts. Here we just need to control the verdict the
// modal sees so we can verify it routes correctly.
//
// The mock specifier must match the dynamic import path AS SEEN BY THE
// IMPORTING FILE, not the test file. ChatLayout imports it as
// `"../../lib/detectAddress"` (from `components/layout/`), which Vitest
// resolves to the absolute `src/lib/detectAddress` regardless of where
// the mock is declared. Using the same relative path from this test
// file would resolve to `src/components/lib/detectAddress` which does
// not exist, so the mock silently does nothing.
const detectAddressKind = vi.fn();
vi.mock("../../../lib/detectAddress", () => ({
  detectAddressKind: (input: string, opts?: { onProgress?: (p: string) => void }) =>
    detectAddressKind(input, opts),
}));

import { AddSourceModal } from "../ChatLayout";

describe("<AddSourceModal /> unified address flow (Feature F2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    detectAddressKind.mockReset();
  });

  it("opens to the address screen by default", () => {
    render(<AddSourceModal onClose={() => {}} onSourceAdded={() => {}} />);
    expect(
      screen.getByTestId("add-source-address-input"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("add-source-address-continue"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("add-source-address-more-options"),
    ).toBeInTheDocument();
  });

  it("routes to the Concord screen when detection returns concord-http", async () => {
    detectAddressKind.mockResolvedValueOnce({
      kind: "concord-http",
      host: "chat.example.com",
    });
    render(<AddSourceModal onClose={() => {}} onSourceAdded={() => {}} />);
    fireEvent.change(screen.getByTestId("add-source-address-input"), {
      target: { value: "chat.example.com" },
    });
    fireEvent.click(screen.getByTestId("add-source-address-continue"));
    // Concord screen has the hostname input — wait for it to mount.
    await waitFor(() => {
      const hostInput = screen.getByPlaceholderText("chat.example.com");
      expect(hostInput).toHaveValue("chat.example.com");
    });
  });

  it("routes to matrix-auth when detection returns matrix", async () => {
    detectAddressKind.mockResolvedValueOnce({
      kind: "matrix",
      host: "matrix.org",
    });
    render(<AddSourceModal onClose={() => {}} onSourceAdded={() => {}} />);
    fireEvent.change(screen.getByTestId("add-source-address-input"), {
      target: { value: "matrix.org" },
    });
    fireEvent.click(screen.getByTestId("add-source-address-continue"));
    // matrix-auth renders the "Sign in with password" button.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /sign in with password/i }),
      ).toBeInTheDocument();
    });
  });

  it("routes to pair-peer when detection returns concord-p2p", async () => {
    detectAddressKind.mockResolvedValueOnce({
      kind: "concord-p2p",
      subkind: "peer-card-deeplink",
      raw: "concord://peer/abc",
    });
    render(<AddSourceModal onClose={() => {}} onSourceAdded={() => {}} />);
    fireEvent.change(screen.getByTestId("add-source-address-input"), {
      target: { value: "concord://peer/abc" },
    });
    fireEvent.click(screen.getByTestId("add-source-address-continue"));
    await waitFor(() => {
      expect(
        screen.getByTestId("peer-card-scanner-stub"),
      ).toBeInTheDocument();
    });
  });

  it("falls back to the picker when detection returns unknown", async () => {
    detectAddressKind.mockResolvedValueOnce({
      kind: "unknown",
      host: "nowhere.example.test",
      detail: "No Concord or Matrix well-known endpoint at nowhere.example.test.",
    });
    render(<AddSourceModal onClose={() => {}} onSourceAdded={() => {}} />);
    fireEvent.change(screen.getByTestId("add-source-address-input"), {
      target: { value: "nowhere.example.test" },
    });
    fireEvent.click(screen.getByTestId("add-source-address-continue"));
    // Picker has the pair-peer tile.
    await waitFor(() => {
      expect(
        screen.getByTestId("add-source-tile-pair-peer"),
      ).toBeInTheDocument();
    });
  });

  it("'More options' link goes directly to the picker without detection", () => {
    render(<AddSourceModal onClose={() => {}} onSourceAdded={() => {}} />);
    fireEvent.click(screen.getByTestId("add-source-address-more-options"));
    expect(detectAddressKind).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("add-source-tile-pair-peer"),
    ).toBeInTheDocument();
  });
});
