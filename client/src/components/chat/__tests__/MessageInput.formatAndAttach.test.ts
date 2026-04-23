import { describe, expect, it } from "vitest";
import messageInputSource from "../MessageInput.tsx?raw";
import chatToolsPanelSource from "../ChatToolsPanel.tsx?raw";

/**
 * Regression tests for Issues A + B observed 2026-04-18.
 *
 * ISSUE A — paperclip (attach_file) rendered as a sibling button next to the
 * `+` tools button inside the message input row, eating horizontal space
 * that belongs to the text area. Paperclip now lives INSIDE the
 * ChatToolsPanel popover opened by `+`, and the `+` button uses a tighter
 * w-9/h-9 (36x36) hit target instead of the 44x44 min box that made it
 * look over-provisioned.
 *
 * ISSUE B — FormatPopover mutated `useFormatStore.draftFormat` via
 * `setDraftFormat` on every change, but nothing in the compose view read
 * `draftFormat`, so clicks in the format menu closed the popover without
 * visible effect. MessageInput now reads draftFormat and applies it as an
 * inline style to the textarea (fontSize/lineHeight/color/textAlign/
 * fontFamily) so the user sees the result of every selection live.
 */
describe("message input — attach inside +, tight + spacing, draft format wiring", () => {
  it("no longer renders a sibling paperclip button next to the + button", () => {
    // The old sibling paperclip block hard-coded title=\"Upload file\" and
    // an attach_file material glyph OUTSIDE the ChatToolsPanel popover.
    // Removing it is the acceptance criterion for Issue A.
    expect(messageInputSource).not.toContain('title="Upload file"');
  });

  it("passes onAttach to ChatToolsPanel so the paperclip lives in the popover", () => {
    expect(messageInputSource).toContain("onAttach={onSendFile ? () => fileRef.current?.click() : undefined}");
  });

  it("ChatToolsPanel renders an Attach tile when onAttach is provided", () => {
    expect(chatToolsPanelSource).toContain('data-testid="chat-tool-attach"');
    expect(chatToolsPanelSource).toContain("material-symbols-outlined text-2xl leading-none\">attach_file");
  });

  it("+ button uses a tight w-9 h-9 hit target, not the fat min-w-[44px]/min-h-[44px] wrapper", () => {
    // Old: p-2.5 min-w-[44px] min-h-[44px] — over-provisioned per feedback.
    // New: w-9 h-9 — still fine for touch, tighter horizontal footprint.
    expect(messageInputSource).toContain('data-testid="chat-tools-plus"');
    expect(messageInputSource).toContain("w-9 h-9 flex items-center justify-center text-primary");
    expect(messageInputSource).not.toMatch(/\+\s*<\/button>[\s\S]{0,200}title="Upload file"/);
  });

  it("reads draftFormat from useFormatStore in the compose view", () => {
    // Wave-in-blood: if this line disappears, Issue B regresses — every
    // selection in FormatPopover will again appear to do nothing.
    expect(messageInputSource).toContain("const draftFormat = useFormatStore((s) => s.draftFormat);");
  });

  it("applies draftFormat as an inline style on the textarea", () => {
    expect(messageInputSource).toContain("`${draftFormat.fontSize}px`");
    expect(messageInputSource).toContain("textAlign: draftFormat.alignment");
    expect(messageInputSource).toContain("color: draftFormat.color || undefined");
    expect(messageInputSource).toContain("draftFormat.fontFamily");
  });
});
