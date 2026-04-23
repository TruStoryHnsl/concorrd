import { describe, expect, it } from "vitest";
import discordSourceBrowserSource from "../DiscordSourceBrowser.tsx?raw";

/**
 * Regression test for Issue F observed 2026-04-18.
 *
 * The "Open Discord Invite" button in the bridge setup flow was disabled
 * with no user-visible reason whenever discordBridgeHttpGetInviteUrl
 * threw (the most common cause: bot token not yet saved so the server
 * returns 400 "No bot token configured"). The UI previously caught the
 * error silently (`setInviteUrl(null)`) and left the button in a broken
 * disabled state forever. This test locks in the fix:
 *
 *   1. The silent `catch {}` has been replaced with a catch that captures
 *      the error message into `inviteUrlError` state.
 *   2. An inline banner with `data-testid="discord-invite-error"` renders
 *      the error and a Retry button.
 *   3. The disabled button carries a tooltip explaining why it's disabled,
 *      so hover still surfaces the reason.
 *   4. The error is logged to the console so devs tailing the browser
 *      console during instrumentation see the real failure mode.
 */
describe("Discord invite button — surface errors instead of silent disable", () => {
  it("no longer silently swallows the fetch failure in openInviteScreen", () => {
    // The old form was the literal snippet:
    //   } catch {
    //     // Non-fatal — show a manual fallback link
    //     setInviteUrl(null);
    //   }
    // — i.e. an untyped catch with no `err` capture. After the fix, every
    // catch in this file captures the error, logs it, and stores a message.
    // Assert the post-fix state positively rather than trying to prove the
    // absence of a loose syntactic form (other functions in the same file
    // also use untyped catches for unrelated best-effort lookups).
    expect(discordSourceBrowserSource).toContain(
      "setInviteUrlError(message);",
    );
    expect(discordSourceBrowserSource).toContain(
      "const message = err instanceof Error ? err.message : String(err);",
    );
  });

  it("logs the error with a stable tag so console instrumentation finds it", () => {
    expect(discordSourceBrowserSource).toContain(
      "[discord-invite] failed to fetch invite URL:",
    );
  });

  it("renders an inline error banner with retry + diagnostic data-testid", () => {
    expect(discordSourceBrowserSource).toContain(
      'data-testid="discord-invite-error"',
    );
    expect(discordSourceBrowserSource).toContain("Retry");
  });

  it("surfaces a tooltip on the disabled Open Discord Invite button", () => {
    expect(discordSourceBrowserSource).toContain(
      'data-testid="discord-invite-open-btn"',
    );
    expect(discordSourceBrowserSource).toMatch(
      /title=\s*\{\s*inviteUrlError\s*&&\s*!inviteUrl\s*\?\s*`Can't generate invite:/,
    );
  });
});
