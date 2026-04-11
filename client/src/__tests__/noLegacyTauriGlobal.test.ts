import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the 2026-04-10 INS-027 Tauri detection-key disaster.
 *
 * The root cause of that outage: every `isTauri` guard in the client
 * checked `"__TAURI__" in window`, but Tauri v2 does not inject that
 * global unless `app.withGlobalTauri: true` is set in `tauri.conf.json`.
 * The real v2 global is `window.__TAURI_INTERNALS__`, which is what
 * `@tauri-apps/api/core.cjs` itself reads from. The consequence was
 * that every native build silently ran in "web mode": `hasServerUrl()`
 * short-circuited to `true`, the picker gate was bypassed, and
 * `LoginForm` rendered instead of the Join/Host picker.
 *
 * The unit-level picker-gate tests couldn't catch it because they took
 * `hasLegacyUrl` as an abstract input. The runtime-level tests that
 * stubbed `window.__TAURI__ = {}` couldn't catch it either, because
 * they lied about the key in exactly the same direction as production
 * code. Six passing tests, zero coverage of the actual detection.
 *
 * This guard walks the client source tree at the file-system level and
 * asserts that no production source file contains the literal
 * `"__TAURI__"` token as a runtime expression (quoted string or
 * property access). Comments that *reference* the legacy key for
 * historical context are fine — they use backticks (`` `__TAURI__` ``)
 * not double-quoted string literals, and they never appear inside a
 * `window.` property access or an `in` expression.
 *
 * If this test fails, someone has either:
 *   1. Re-introduced the bug by typing `"__TAURI__"` in a new isTauri
 *      check, or
 *   2. Added a test that fakes the wrong global.
 *
 * In either case, the fix is to use `__TAURI_INTERNALS__`, not to
 * loosen this test.
 */

const FORBIDDEN_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  {
    regex: /"__TAURI__"/,
    description: 'double-quoted "__TAURI__" literal (usually an `in window` check)',
  },
  {
    regex: /'__TAURI__'/,
    description: "single-quoted '__TAURI__' literal",
  },
  {
    regex: /window\.__TAURI__(?!_)/,
    description: "window.__TAURI__ property access (and not window.__TAURI_INTERNALS__ — note the trailing underscore guard)",
  },
];

/**
 * Strip JS/TS comments so the pattern check only sees executable code.
 *
 * The legacy `__TAURI__` name is intentionally referenced in JSDoc and
 * inline comments across the codebase for historical context (the
 * 2026-04-10 writeup explains why the rename happened). Those mentions
 * must NOT trip the guard. We strip, in order:
 *
 *   1. Block comments: `/* ... *\/` including multi-line JSDoc.
 *   2. Line comments: `// ...` through end-of-line.
 *
 * This is deliberately naive — it does not parse TS syntax, so it
 * would incorrectly strip a comment-like substring appearing inside a
 * string literal (`"not really //a comment"`). That edge case does not
 * meaningfully affect this guard because any production `isTauri` check
 * using `"__TAURI__"` would also be inside a string literal and thus
 * detected by one of the quoted-form patterns above, which run against
 * the stripped text. A template literal containing `/*` is possible
 * but extraordinarily rare in this codebase.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// `client/src/__tests__/noLegacyTauriGlobal.test.ts` → `client/src`
const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_ROOT = join(THIS_FILE, "..", "..");

/**
 * Recursively walk `dir` and yield every `.ts` / `.tsx` file path.
 * `node_modules` is excluded defensively even though it lives outside
 * `src`; the walker also skips its own `__tests__` dir and this very
 * file to avoid tripping over its own documentation of the forbidden
 * patterns.
 */
function* walkSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".git") continue;
      yield* walkSources(full);
    } else if (
      st.isFile() &&
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      // skip this test file itself — its doc comments mention the
      // forbidden patterns deliberately.
      full !== THIS_FILE
    ) {
      yield full;
    }
  }
}

describe("regression guard: no legacy __TAURI__ detection key", () => {
  it("no production source file contains the literal __TAURI__ detection pattern", () => {
    const offenders: string[] = [];

    for (const file of walkSources(SRC_ROOT)) {
      const raw = readFileSync(file, "utf8");
      const stripped = stripComments(raw);
      for (const { regex, description } of FORBIDDEN_PATTERNS) {
        if (regex.test(stripped)) {
          // Locate the matching line in the STRIPPED source so line
          // numbers track executable code. Offenders get reported with
          // both the path and the offending line for triage.
          const lineIdx = stripped
            .split("\n")
            .findIndex((l) => regex.test(l));
          const snippet =
            lineIdx >= 0
              ? `${lineIdx + 1}: ${stripped.split("\n")[lineIdx].trim()}`
              : "(pattern found but no single-line match)";
          offenders.push(
            `${relative(SRC_ROOT, file)} — ${description}\n    ${snippet}`,
          );
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        "Legacy Tauri v1 detection key detected in client source. " +
          "Tauri v2 uses `__TAURI_INTERNALS__` — see the 2026-04-10 INS-027 " +
          "writeup and `client/src/api/serverUrl.ts` for the full explanation.\n\n" +
          offenders.map((o) => `  - ${o}`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
