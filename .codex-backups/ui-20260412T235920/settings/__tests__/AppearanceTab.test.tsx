/**
 * AppearanceTab component tests.
 *
 * Covers the three responsibilities that matter:
 *
 *  1. **Store wiring** — slider and numeric input both route through the
 *     `useSettingsStore.setChatFontSize` action, including the clamp /
 *     NaN-rejection guards that live in the store (we assert the store
 *     state rather than the control value so we're testing the contract,
 *     not the plumbing).
 *  2. **Reset behavior** — the reset button restores the default and
 *     becomes disabled once the value equals the default.
 *  3. **Live preview** — the preview paragraph renders with the current
 *     font-size inline so the user can judge the selected value without
 *     leaving settings.
 *
 * The tests reset the Zustand store between cases via
 * `useSettingsStore.setState` to avoid cross-test leakage from the
 * persisted localStorage slice (jsdom persists the store across tests
 * within a single file unless we explicitly reset it).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceTab } from "../AppearanceTab";
import {
  useSettingsStore,
  CHAT_FONT_SIZE_DEFAULT,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
} from "../../../stores/settings";

describe("<AppearanceTab />", () => {
  beforeEach(() => {
    // Reset the store to the default font size before each test so
    // persisted values from prior tests (or from a developer's own
    // localStorage during `npm run dev`) never leak in.
    useSettingsStore.setState({ chatFontSize: CHAT_FONT_SIZE_DEFAULT });
  });

  describe("initial render", () => {
    it("renders the tab heading and description", () => {
      render(<AppearanceTab />);
      expect(
        screen.getByRole("heading", { name: /appearance/i, level: 2 }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/these settings only affect message body text/i),
      ).toBeInTheDocument();
    });

    it("shows the current chat font size from the store on first render", () => {
      useSettingsStore.setState({ chatFontSize: 20 });
      render(<AppearanceTab />);
      const numericInput = screen.getByTestId(
        "chat-font-size-input",
      ) as HTMLInputElement;
      expect(numericInput.value).toBe("20");
    });

    it("renders the preview paragraph with the current font-size inline", () => {
      useSettingsStore.setState({ chatFontSize: 22 });
      render(<AppearanceTab />);
      const preview = screen.getByTestId("chat-font-size-preview");
      // The preview heading label and the sample text both live inside
      // this container; the sample <p> has the inline style we care about.
      const sample = preview.querySelector("p:last-of-type") as HTMLElement;
      expect(sample).not.toBeNull();
      expect(sample.style.fontSize).toBe("22px");
    });
  });

  describe("numeric input", () => {
    // We use fireEvent.change rather than userEvent.type because the
    // numeric input is a controlled component bound to
    // `value={chatFontSize}`. userEvent.type appends keystrokes to the
    // current DOM value, so typing "18" into a default-14 input
    // produces "1418" → clamped to max — not what a real human who
    // selects-all-and-replaces would do. fireEvent.change fires a
    // single change event with the target value directly, which
    // matches the "select all, then type, blur" flow that real users
    // produce.

    it("writes valid integer input to the store", () => {
      render(<AppearanceTab />);
      const input = screen.getByTestId(
        "chat-font-size-input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "18" } });
      expect(useSettingsStore.getState().chatFontSize).toBe(18);
    });

    it("clamps values above the max to CHAT_FONT_SIZE_MAX", () => {
      render(<AppearanceTab />);
      const input = screen.getByTestId(
        "chat-font-size-input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "99" } });
      // 99 > max (32), so the store clamps it down.
      expect(useSettingsStore.getState().chatFontSize).toBe(
        CHAT_FONT_SIZE_MAX,
      );
    });

    it("clamps values below the min to CHAT_FONT_SIZE_MIN", () => {
      render(<AppearanceTab />);
      const input = screen.getByTestId(
        "chat-font-size-input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "4" } });
      // 4 < min (12), so the store clamps it up.
      expect(useSettingsStore.getState().chatFontSize).toBe(
        CHAT_FONT_SIZE_MIN,
      );
    });

    it("ignores empty/non-numeric input without corrupting the store", () => {
      useSettingsStore.setState({ chatFontSize: 16 });
      render(<AppearanceTab />);
      const input = screen.getByTestId(
        "chat-font-size-input",
      ) as HTMLInputElement;
      // Empty string → parseInt("") → NaN → onNumericChange returns
      // early without touching the store.
      fireEvent.change(input, { target: { value: "" } });
      expect(useSettingsStore.getState().chatFontSize).toBe(16);
    });
  });

  describe("reset button", () => {
    it("is disabled when the current value equals the default", () => {
      useSettingsStore.setState({ chatFontSize: CHAT_FONT_SIZE_DEFAULT });
      render(<AppearanceTab />);
      const reset = screen.getByTestId(
        "chat-font-size-reset",
      ) as HTMLButtonElement;
      expect(reset.disabled).toBe(true);
    });

    it("is enabled when the current value differs from the default", () => {
      useSettingsStore.setState({ chatFontSize: 24 });
      render(<AppearanceTab />);
      const reset = screen.getByTestId(
        "chat-font-size-reset",
      ) as HTMLButtonElement;
      expect(reset.disabled).toBe(false);
    });

    it("restores the default when clicked", async () => {
      const user = userEvent.setup();
      useSettingsStore.setState({ chatFontSize: 24 });
      render(<AppearanceTab />);
      const reset = screen.getByTestId("chat-font-size-reset");
      await user.click(reset);
      expect(useSettingsStore.getState().chatFontSize).toBe(
        CHAT_FONT_SIZE_DEFAULT,
      );
    });
  });

  describe("store-level guards (exercised via the component)", () => {
    it("setChatFontSize rounds fractional values to the nearest integer", () => {
      // Call directly — the component only hands integer values to the
      // store, so this exercises the Math.round() in setChatFontSize.
      useSettingsStore.getState().setChatFontSize(17.6);
      expect(useSettingsStore.getState().chatFontSize).toBe(18);
      useSettingsStore.getState().setChatFontSize(17.4);
      expect(useSettingsStore.getState().chatFontSize).toBe(17);
    });

    it("setChatFontSize rejects NaN without mutating state", () => {
      useSettingsStore.setState({ chatFontSize: 16 });
      useSettingsStore.getState().setChatFontSize(Number.NaN);
      expect(useSettingsStore.getState().chatFontSize).toBe(16);
    });

    it("setChatFontSize rejects Infinity without mutating state", () => {
      useSettingsStore.setState({ chatFontSize: 16 });
      useSettingsStore.getState().setChatFontSize(Number.POSITIVE_INFINITY);
      expect(useSettingsStore.getState().chatFontSize).toBe(16);
      useSettingsStore.getState().setChatFontSize(Number.NEGATIVE_INFINITY);
      expect(useSettingsStore.getState().chatFontSize).toBe(16);
    });
  });
});
