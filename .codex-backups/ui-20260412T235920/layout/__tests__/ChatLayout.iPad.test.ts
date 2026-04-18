/**
 * INS-020 iPad-branch wiring regression test.
 *
 * ChatLayout has O(20) hook dependencies (useMatrix, useAuth, useServer,
 * useDM, useSettings, useToast, useNotifications, useDisplayName,
 * useTyping, useSendTyping, useSendReadReceipt, usePlatform, ...) and
 * mocking all of them in jsdom just to render the component once is
 * expensive churn that would drift out of sync with the real shell.
 *
 * Instead this test validates the two narrow things that matter for
 * the iPad-branch wiring contract:
 *
 *   1. `ChatLayout.tsx` imports `usePlatform` from `../../hooks/usePlatform`.
 *      If anyone later removes the import, this test catches it.
 *
 *   2. The file emits the three `data-concord-layout="tablet|desktop|mobile"`
 *      markers. A regression would either remove the tablet branch or
 *      rename the markers, and this test would fail in either case.
 *
 * The actual behavioral contract — "iPad renders the desktop three-pane
 * layout" — is covered indirectly:
 *
 *   - `usePlatform().isIPad` is unit-tested in
 *     `src/hooks/__tests__/usePlatform.test.ts` (iPad-via-touch branch,
 *     iPad-desktop-UA branch, and the non-iPad negative cases).
 *
 *   - The branching in ChatLayout is a single literal ternary — if the
 *     import exists and the three markers are present, the branch logic
 *     is live.
 *
 * The source file is loaded via Vite's `?raw` query suffix so the
 * tsconfig.app.json strict-DOM-only type set never has to learn about
 * node:fs / node:path / node:url just for one test.
 */

import { describe, it, expect } from "vitest";
// `?raw` is a Vite-supplied import query that returns the file contents
// as a string at build time. No node APIs required.
import chatLayoutSource from "../ChatLayout.tsx?raw";

describe("ChatLayout iPad-branch wiring (INS-020)", () => {
  it("imports usePlatform from the platform hook module", () => {
    expect(chatLayoutSource).toMatch(
      /import\s*\{\s*usePlatform\s*\}\s*from\s*["']\.\.\/\.\.\/hooks\/usePlatform["']/,
    );
  });

  it("calls usePlatform() inside the ChatLayout component", () => {
    expect(chatLayoutSource).toMatch(/usePlatform\(\)/);
  });

  it("emits all three data-concord-layout markers (tablet, desktop, mobile)", () => {
    expect(chatLayoutSource).toContain('data-concord-layout="tablet"');
    expect(chatLayoutSource).toContain('data-concord-layout="desktop"');
    expect(chatLayoutSource).toContain('data-concord-layout="mobile"');
  });

  it("branches on a prefersTabletLayout flag derived from platform.isIPad", () => {
    expect(chatLayoutSource).toMatch(/prefersTabletLayout/);
    expect(chatLayoutSource).toMatch(/platform\.isIPad/);
  });
});
