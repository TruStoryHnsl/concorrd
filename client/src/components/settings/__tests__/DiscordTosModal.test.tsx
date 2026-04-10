import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiscordTosModal } from "../DiscordTosModal";

/**
 * INS-024 Wave 4b: DiscordTosModal tests.
 *
 * The ToS modal is a hard blocker for user-mode (puppeting). These tests
 * verify that:
 *   - The Continue button is disabled without the checkbox ticked.
 *   - The Continue button enables after the checkbox is ticked.
 *   - Acceptance persists a timestamp to localStorage.
 *   - Cancel closes without persisting.
 */

describe("<DiscordTosModal />", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders with Continue button disabled", () => {
    const onClose = vi.fn();
    render(<DiscordTosModal onClose={onClose} />);

    expect(screen.getByTestId("discord-tos-modal")).toBeInTheDocument();
    expect(screen.getByTestId("tos-continue-btn")).toBeDisabled();
  });

  it("enables Continue button after checkbox is ticked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DiscordTosModal onClose={onClose} />);

    expect(screen.getByTestId("tos-continue-btn")).toBeDisabled();

    await user.click(screen.getByTestId("tos-checkbox"));

    expect(screen.getByTestId("tos-continue-btn")).toBeEnabled();
  });

  it("persists acceptance timestamp to localStorage on Continue", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DiscordTosModal onClose={onClose} />);

    await user.click(screen.getByTestId("tos-checkbox"));
    await user.click(screen.getByTestId("tos-continue-btn"));

    // onClose should have been called.
    expect(onClose).toHaveBeenCalledTimes(1);

    // localStorage should contain the acceptance timestamp.
    const stored = localStorage.getItem("concord_settings");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.state.discord_bridge_tos_accepted_at).toBeDefined();

    // The timestamp should be a valid ISO string.
    const ts = parsed.state.discord_bridge_tos_accepted_at;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("does not persist anything when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DiscordTosModal onClose={onClose} />);

    await user.click(screen.getByTestId("tos-cancel-btn"));

    expect(onClose).toHaveBeenCalledTimes(1);

    // localStorage should not have a tos timestamp.
    const stored = localStorage.getItem("concord_settings");
    expect(stored).toBeNull();
  });

  it("does not call onClose when Continue is clicked without checkbox", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DiscordTosModal onClose={onClose} />);

    // Try clicking Continue without checking the box.
    await user.click(screen.getByTestId("tos-continue-btn"));

    // onClose should NOT have been called.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("displays all required warning content", () => {
    const onClose = vi.fn();
    render(<DiscordTosModal onClose={onClose} />);

    // Key phrases that MUST be present for commercial scope.
    expect(
      screen.getByText(/Terms of Service prohibit self-bots/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Enforcement is inconsistent/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cannot warrant safety/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/token never touches Concord/i),
    ).toBeInTheDocument();
  });
});
