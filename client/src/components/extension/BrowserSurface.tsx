/**
 * BrowserSurface — sandboxed iframe for "browser" extension surfaces (INS-036 W3, INS-066 W4).
 *
 * Renders an allowlisted web URL inside a hardened iframe sandbox.
 * Non-matching srcs show a blocked error card instead of loading the iframe.
 *
 * Sandbox policy:
 *   - allow-scripts: JS execution inside the frame
 *   - allow-forms: form submissions inside the frame
 *   - allow-popups: popups that are themselves sandboxed
 *   - allow-popups-to-escape-sandbox: lets popups open in a normal tab
 *   - NO allow-same-origin: prevents the frame from accessing parent cookies/storage
 *   - NO allow-top-navigation: prevents frame from redirecting the parent page
 *
 * Allowlist (in order):
 *   1. *.concord.app — legacy hosted-extension origin (INS-036 baseline).
 *   2. Same-origin /ext/{id}/... — runtime-installed extensions served by
 *      the FastAPI StaticFiles mount registered in INS-066 W3. Both
 *      same-origin absolute URLs (window.location.origin + "/ext/...") and
 *      bare relative paths starting with "/ext/" are accepted.
 *   3. Optional dev-URL bypass: when import.meta.env.VITE_EXT_DEV_URL is
 *      set, srcs whose origin matches that value exactly are allowed.
 *      This is for local dev (running an extension on a Vite dev server)
 *      and is OFF in production builds (the env var is unset).
 */

import type { SurfaceDescriptor } from "./ExtensionEmbed";

// Legacy hosted-extension origin (INS-036): only *.concord.app subdomains.
const HOSTED_ALLOWLIST = /^https:\/\/[a-zA-Z0-9-]+\.concord\.app(\/|$)/;

// Runtime-installed extension path. Matches a bare relative path; absolute
// URLs are checked separately against window.location.origin.
//
// The character class allows the reverse-domain extension id format
// (letters, digits, dots, underscores, dashes). We additionally reject
// any path containing a "/../" or trailing "/.." segment to prevent path
// traversal — even though the server-side StaticFiles mount is also
// hardened, the client-side allowlist is the first line of defence and
// must not let a traversal-shaped URL even reach the iframe.
const EXT_PATH = /^\/ext\/[a-zA-Z0-9._-]+\//;
const PATH_TRAVERSAL = /(^|\/)\.\.(\/|$)/;

/**
 * Apply the BrowserSurface allowlist to a src string.
 *
 * Pure function so unit tests don't need to mount React. Returns true iff
 * the src is allowed by any of the rules above.
 *
 * @param src — the iframe src to validate
 * @param origin — the page's origin (window.location.origin in prod). Pass
 *   explicitly for tests that don't have a DOM.
 * @param devUrl — optional dev-URL bypass origin (VITE_EXT_DEV_URL). Pass
 *   explicitly for tests; production reads from import.meta.env.
 */
export function isBrowserSurfaceSrcAllowed(
  src: string,
  origin: string,
  devUrl?: string,
): boolean {
  if (!src) return false;

  // Rule 1: hosted *.concord.app.
  if (HOSTED_ALLOWLIST.test(src)) return true;

  // Rule 2a: bare relative path under /ext/. Refuse any traversal
  // segment up front — a path like "/ext/../etc/passwd" would match
  // the EXT_PATH regex because ".." consists of allowed characters
  // (the "." class member), so traversal MUST be filtered separately.
  if (EXT_PATH.test(src) && !PATH_TRAVERSAL.test(src)) return true;

  // Rule 2b: absolute URL on the page's own origin under /ext/.
  if (origin && src.startsWith(origin + "/ext/")) {
    const path = src.slice(origin.length);
    if (EXT_PATH.test(path) && !PATH_TRAVERSAL.test(path)) return true;
  }

  // Rule 3: dev-URL bypass — only when explicitly set, and only for the
  // exact origin, not subpaths or substring matches.
  if (devUrl) {
    try {
      const u = new URL(src);
      const dev = new URL(devUrl);
      if (u.origin === dev.origin) return true;
    } catch {
      // Bad URL on either side → fall through, deny.
    }
  }

  return false;
}

interface BrowserSurfaceProps {
  surface: SurfaceDescriptor;
  src: string;
  title?: string;
}

function getDevUrl(): string | undefined {
  // import.meta.env is the Vite-injected env bag. Guard against tests
  // that run in a vanilla Node context where import.meta.env may be
  // undefined.
  try {
    return (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_EXT_DEV_URL;
  } catch {
    return undefined;
  }
}

export default function BrowserSurface({ surface, src, title }: BrowserSurfaceProps) {
  const origin =
    typeof window !== "undefined" && window.location ? window.location.origin : "";
  const allowed = isBrowserSurfaceSrcAllowed(src, origin, getDevUrl());

  if (!allowed) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full bg-surface text-error p-4"
        data-testid="browser-surface-blocked"
      >
        <span className="material-symbols-outlined text-4xl mb-2">block</span>
        <p className="text-sm font-medium">Blocked: external src not allowed</p>
        <p className="text-xs text-on-surface-variant mt-1 break-all">{src}</p>
      </div>
    );
  }

  return (
    <iframe
      src={src}
      // Hardened sandbox — no allow-same-origin, no allow-top-navigation.
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      title={title ?? "Browser Surface"}
      className="flex-1 w-full border-0 min-h-0"
      style={surface.min_width_px ? { minWidth: surface.min_width_px } : undefined}
      data-testid="browser-surface-iframe"
    />
  );
}
