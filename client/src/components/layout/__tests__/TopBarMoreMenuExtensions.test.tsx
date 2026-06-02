/**
 * INS-070 — Tools dropdown gains an "Extension Library" entry that
 * opens a global install/uninstall modal in one click. Hidden for
 * non-admins (matches the existing AdminTab gate).
 *
 * Coverage:
 *   1. Static-source pin on the Tools menu wiring — guarantees the
 *      "Room Extensions" rename and the new "Extension Library" item
 *      stay in the file even after future refactors.
 *   2. Static pin on the admin gate — the new menu item is wired
 *      to a defined `onExtensionLibrary` only when `isInstanceAdmin`
 *      is true.
 */

import { describe, expect, it } from "vitest";
import chatLayoutSource from "../ChatLayout.tsx?raw";
import topBarMenuSource from "../TopBarMenu.tsx?raw";

describe("TopBarMoreMenu Extension Library wiring (INS-070)", () => {
  it("renames the room-bound entry to 'Room Extensions'", () => {
    // The room-bound legacy item is renamed so the new library entry
    // doesn't read as a duplicate. The previous "Extensions" label
    // must NOT appear on an OverflowMenuItem under TopBarMoreMenu.
    // After the architecture-cleanup sprint, the TopBarMoreMenu body
    // lives in TopBarMenu.tsx — that's where the labels are pinned.
    expect(topBarMenuSource).toContain(
      'label="Room Extensions"',
    );
    expect(topBarMenuSource).not.toMatch(
      /<OverflowMenuItem\s+icon="extension"\s+label="Extensions"\s+onClick/,
    );
  });

  it("renders an 'Extension Library' OverflowMenuItem with the library_books icon", () => {
    expect(topBarMenuSource).toMatch(
      /icon="library_books"\s+label="Extension Library"/,
    );
  });

  it("gates the Extension Library entry on the isInstanceAdmin state", () => {
    // The conditional must read isInstanceAdmin so non-admins never
    // see the menu entry. Pin the literal so a regression that
    // accidentally drops the gate (or replaces it with `true`) fails
    // here loudly.
    expect(chatLayoutSource).toMatch(
      /isInstanceAdmin\s*\?\s*\(\)\s*=>\s*setExtensionCatalogOpen\(true\)\s*:\s*undefined/,
    );
  });

  it("imports the ExtensionCatalogModal", () => {
    expect(chatLayoutSource).toContain(
      'import { ExtensionCatalogModal } from "../extension/ExtensionCatalogModal";',
    );
  });

  it("renders the ExtensionCatalogModal when extensionCatalogOpen is true", () => {
    expect(chatLayoutSource).toMatch(
      /\{extensionCatalogOpen\s*&&\s*\(\s*<ExtensionCatalogModal\s+onClose=\{\(\)\s*=>\s*setExtensionCatalogOpen\(false\)\}/,
    );
  });
});
