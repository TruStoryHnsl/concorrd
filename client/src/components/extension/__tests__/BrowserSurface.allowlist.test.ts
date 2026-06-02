import { describe, expect, it } from "vitest";
import { isBrowserSurfaceSrcAllowed } from "../BrowserSurface";

const ORIGIN = "https://app.concord.local";

describe("BrowserSurface allowlist (INS-066 W4)", () => {
  it("allows hosted *.concord.app origins", () => {
    expect(
      isBrowserSurfaceSrcAllowed("https://worldview.concord.app/", ORIGIN),
    ).toBe(true);
    expect(
      isBrowserSurfaceSrcAllowed("https://abc-123.concord.app/path", ORIGIN),
    ).toBe(true);
  });

  it("allows bare /ext/{id}/ relative paths", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        "/ext/com.concord.orrdia-bridge/index.html",
        ORIGIN,
      ),
    ).toBe(true);
    expect(isBrowserSurfaceSrcAllowed("/ext/foo/", ORIGIN)).toBe(true);
  });

  it("allows same-origin absolute /ext/{id}/ URLs", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        `${ORIGIN}/ext/com.concord.orrdia-bridge/index.html`,
        ORIGIN,
      ),
    ).toBe(true);
  });

  it("rejects /ext/ on a different origin", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        "https://evil.example.com/ext/foo/index.html",
        ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects unrelated external origins", () => {
    expect(
      isBrowserSurfaceSrcAllowed("https://evil.example.com/", ORIGIN),
    ).toBe(false);
    expect(
      isBrowserSurfaceSrcAllowed(
        "https://concord-app.evil.com/",
        ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects path traversal under /ext/", () => {
    expect(
      isBrowserSurfaceSrcAllowed("/ext/../etc/passwd", ORIGIN),
    ).toBe(false);
  });

  it("rejects empty src", () => {
    expect(isBrowserSurfaceSrcAllowed("", ORIGIN)).toBe(false);
  });

  it("VITE_EXT_DEV_URL bypass allows the exact dev origin", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        "http://localhost:5174/index.html",
        ORIGIN,
        "http://localhost:5174",
      ),
    ).toBe(true);
  });

  it("VITE_EXT_DEV_URL bypass does not allow other origins", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        "http://localhost:5175/index.html",
        ORIGIN,
        "http://localhost:5174",
      ),
    ).toBe(false);
  });

  it("VITE_EXT_DEV_URL bypass off when env is unset", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        "http://localhost:5174/index.html",
        ORIGIN,
      ),
    ).toBe(false);
  });
});

// =====================================================================
// Cold-reader adversarial coverage (INS-066-FUP-D)
// ---------------------------------------------------------------------
// The original allowlist tests above were authored in the same session
// as the BrowserSurface implementation, and they cover the happy path
// plus a couple of obvious negatives. The cases below come from a
// separate-session reviewer and target spoofing patterns that pass
// surface-level "starts with concord.app" checks but should still be
// rejected.
// =====================================================================

describe("BrowserSurface allowlist — adversarial URLs (INS-066-FUP-D)", () => {
  it("rejects schemeless protocol-relative URLs (//evil.com/...)", () => {
    expect(
      isBrowserSurfaceSrcAllowed("//evil.com/ext/foo/index.html", ORIGIN),
    ).toBe(false);
    expect(
      isBrowserSurfaceSrcAllowed("//worldview.concord.app/", ORIGIN),
    ).toBe(false);
  });

  it("rejects deep-nested path traversal under /ext/", () => {
    expect(
      isBrowserSurfaceSrcAllowed("/ext/../../etc/passwd", ORIGIN),
    ).toBe(false);
    expect(
      isBrowserSurfaceSrcAllowed("/ext/foo/../../../etc/shadow", ORIGIN),
    ).toBe(false);
    // Encoded traversal '%2e%2e' is rejected because the id-segment
    // regex [a-zA-Z0-9._-]+ allows '.' but the EXT_PATH match treats
    // the full string raw. Decoded handling is the server's job; the
    // client must reject the raw form as well.
    expect(
      isBrowserSurfaceSrcAllowed("/ext/%2e%2e/etc/passwd", ORIGIN),
    ).toBe(false);
  });

  it("rejects subdomain-spoof of *.concord.app (extra segment)", () => {
    // /^https:\/\/[a-zA-Z0-9-]+\.concord\.app(\/|$)/ must NOT match
    // `https://x.concord.app.evil.com/` — the host is actually
    // `x.concord.app.evil.com` and `evil.com` is the parent domain.
    expect(
      isBrowserSurfaceSrcAllowed(
        "https://x.concord.app.evil.com/",
        ORIGIN,
      ),
    ).toBe(false);
    expect(
      isBrowserSurfaceSrcAllowed(
        "https://x.concord.app.evil.com/path/index.html",
        ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects TLD-spoof where 'concord.app' is itself a subdomain", () => {
    expect(
      isBrowserSurfaceSrcAllowed("https://concord.app.evil.com/", ORIGIN),
    ).toBe(false);
  });

  it("rejects bare host without subdomain (https://concord.app/)", () => {
    // The regex requires `<sub>.concord.app` — bare `concord.app/` has
    // no subdomain segment and is not a valid catalog host.
    expect(isBrowserSurfaceSrcAllowed("https://concord.app/", ORIGIN)).toBe(
      false,
    );
  });

  it("rejects javascript:, data:, and file: schemes outright", () => {
    expect(
      isBrowserSurfaceSrcAllowed("javascript:alert(1)", ORIGIN),
    ).toBe(false);
    expect(
      isBrowserSurfaceSrcAllowed(
        "data:text/html,<script>alert(1)</script>",
        ORIGIN,
      ),
    ).toBe(false);
    expect(
      isBrowserSurfaceSrcAllowed("file:///etc/passwd", ORIGIN),
    ).toBe(false);
  });

  it("rejects /ext/ paths served from a sibling subdomain (not the page origin)", () => {
    expect(
      isBrowserSurfaceSrcAllowed(
        "https://other.app.example.com/ext/com.concord.foo/",
        ORIGIN,
      ),
    ).toBe(false);
  });

  it("rejects empty id between /ext/ slashes (no path injection)", () => {
    expect(isBrowserSurfaceSrcAllowed("/ext//index.html", ORIGIN)).toBe(false);
    expect(isBrowserSurfaceSrcAllowed("/ext/", ORIGIN)).toBe(false);
  });

  it("permits valid /ext/{id}/ subpath as a control case", () => {
    // Positive control verifying the allowlist still works after the
    // adversarial cases above don't accidentally tighten it.
    expect(
      isBrowserSurfaceSrcAllowed("/ext/com.foo.bar/sub/page.html", ORIGIN),
    ).toBe(true);
  });
});
