/**
 * BrowserSurface — sandboxed iframe for "browser" extension surfaces (INS-036 W3).
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
 * Allowlist: src must match *.concord.app (hardcoded for MVP).
 */

import type { SurfaceDescriptor } from "./ExtensionEmbed";

// Only *.concord.app origins are allowed for browser surfaces.
const BROWSER_SURFACE_ALLOWLIST = /^https:\/\/[a-zA-Z0-9-]+\.concord\.app(\/|$)/;

interface BrowserSurfaceProps {
  surface: SurfaceDescriptor;
  src: string;
  title?: string;
}

export default function BrowserSurface({ surface, src, title }: BrowserSurfaceProps) {
  if (!BROWSER_SURFACE_ALLOWLIST.test(src)) {
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
