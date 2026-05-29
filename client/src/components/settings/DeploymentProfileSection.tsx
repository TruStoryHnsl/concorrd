/**
 * Phase 7 — Settings → Profile → "Deployment profile" section.
 *
 * Renders the native/web profile toggle and the explanatory text per
 * state. Lives in its own component (instead of inline inside
 * `ProfileTab`) so the unit tests can exercise the toggle flow in
 * isolation without dragging the whole Profile tab's auth / matrix
 * client / TOTP setup into the test fixtures.
 *
 * State machine:
 *   - native, p2p_only  → toggle off, "Make this instance web-accessible"
 *                         text, confirm modal on flip.
 *   - native, web_first → toggle on, hosting status panel inline
 *                         (Phase-0 surface) so the operator can see
 *                         what needs DNS / port-forward.
 *   - web build        → toggle read-only, "Web-first profile is
 *                         active (configured via CONCORD_PROFILE env)"
 *                         text. Reflects the docker reality.
 *
 * The Phase-0 hosting status panel is intentionally minimal here —
 * it's a starting point we can iterate on; the existing
 * `HostingTab` carries the full hosting diagnostics surface for
 * operators who want the deeper view.
 */

import { useCallback, useEffect, useState } from "react";
import { isTauri } from "../../api/servitude";
import {
  enableWebStack,
  fetchHostingProfile,
  setHostingProfile,
  type DeploymentProfile,
  type HostingProfileSnapshot,
} from "../../api/hostingProfile";
import { useToastStore } from "../../stores/toast";

interface ConfirmFlipState {
  open: boolean;
  busy: boolean;
}

export function DeploymentProfileSection() {
  const addToast = useToastStore((s) => s.addToast);
  const [snapshot, setSnapshot] = useState<HostingProfileSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmFlipState>({
    open: false,
    busy: false,
  });

  const refresh = useCallback(async () => {
    try {
      const snap = await fetchHostingProfile();
      setSnapshot(snap);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : "Failed to load deployment profile",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const native = isTauri();
  const profile: DeploymentProfile = snapshot?.profile ?? "p2p_only";
  const webStackRunning = snapshot?.webStackRunning ?? false;

  const handleConfirmEnable = async () => {
    setConfirm({ open: true, busy: true });
    try {
      // Native: flip the persisted profile so the next servitude
      // start materializes the web-stack transports. Then call the
      // backend to actually start the docker stack (the operator's
      // hosting flow). Both succeed independently — if only one
      // landed, the UI still reflects the new state on next
      // refresh.
      await setHostingProfile("web_first");
      // The web stack lives on docker; native installs that flip
      // the toggle still need the docker stack to be present for
      // the enable call to do anything. We attempt the call so the
      // operator gets one of (a) success + Phase-0 panel, (b) a
      // 503 they can retry, or (c) a 403 if they aren't admin.
      // Failures here are non-fatal for the profile flip — the
      // persisted profile already changed.
      try {
        const result = await enableWebStack();
        addToast(
          result.startedServices.length > 0
            ? `Web stack started (${result.startedServices.length} service(s))`
            : "Web stack already running",
          "success",
        );
      } catch (enableErr) {
        // Don't fail the toggle — the profile flip already
        // succeeded. Surface the start failure so the operator
        // knows the docker stack needs attention.
        addToast(
          enableErr instanceof Error
            ? `Profile saved, but starting docker stack failed: ${enableErr.message}`
            : "Profile saved, but docker stack start failed",
          "error",
        );
      }
      setConfirm({ open: false, busy: false });
      await refresh();
    } catch (err) {
      setConfirm({ open: true, busy: false });
      addToast(
        err instanceof Error ? err.message : "Failed to update profile",
        "error",
      );
    }
  };

  const handleToggleClick = () => {
    if (!native) return; // web build: read-only
    if (profile === "p2p_only") {
      setConfirm({ open: true, busy: false });
    } else {
      // Toggling OFF (web_first -> p2p_only) is a config-only flip
      // here; the operator can stop the docker stack via their
      // usual operational tools. Future work can wire a
      // disable_web_stack endpoint; the spec calls out the enable
      // direction explicitly so we keep the off-flip simple.
      void (async () => {
        try {
          await setHostingProfile("p2p_only");
          addToast(
            "Switched to P2P-only profile. Web stack will not start " +
              "on next restart.",
            "success",
          );
          await refresh();
        } catch (err) {
          addToast(
            err instanceof Error
              ? err.message
              : "Failed to update profile",
            "error",
          );
        }
      })();
    }
  };

  return (
    <div
      className="border-t border-outline-variant/15 pt-6 space-y-3"
      data-testid="deployment-profile-section"
    >
      <div>
        <h4 className="text-sm font-medium text-on-surface">
          Deployment profile
        </h4>
        <p className="text-xs text-on-surface-variant">
          Whether this install serves a public web UI in addition to
          participating in the Concord P2P mesh.
        </p>
      </div>

      {loading ? (
        <p
          className="text-xs text-on-surface-variant italic"
          data-testid="deployment-profile-loading"
        >
          Loading…
        </p>
      ) : loadError ? (
        <p
          className="text-xs text-error"
          data-testid="deployment-profile-error"
        >
          {loadError}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-on-surface">
              Make this instance web-accessible
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={profile === "web_first"}
              data-testid="deployment-profile-toggle"
              onClick={handleToggleClick}
              disabled={!native}
              className={
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors " +
                (profile === "web_first"
                  ? "bg-primary"
                  : "bg-surface-container-high") +
                (native ? "" : " opacity-50 cursor-not-allowed")
              }
            >
              <span
                className={
                  "inline-block h-4 w-4 transform rounded-full bg-on-surface transition-transform " +
                  (profile === "web_first"
                    ? "translate-x-6"
                    : "translate-x-1")
                }
              />
            </button>
          </div>

          {profile === "p2p_only" ? (
            <p
              className="text-xs text-on-surface-variant"
              data-testid="deployment-profile-p2p-helper"
            >
              This instance participates in the Concord P2P mesh but
              does NOT serve a public Caddy / web UI. Other users can
              reach you via peer-pairing (Phase 5) but a browser tab
              can't load your instance directly.
            </p>
          ) : (
            <div
              className="text-xs text-on-surface-variant space-y-2"
              data-testid="deployment-profile-web-helper"
            >
              {!native ? (
                <p>
                  Web-first profile is active (configured via
                  CONCORD_PROFILE env).
                </p>
              ) : (
                <p>
                  The Caddy / LiveKit / coturn / sslh web stack is
                  available. Confirm DNS + port-forward via the
                  hosting status panel.
                </p>
              )}
              <div
                className="flex items-center gap-2"
                data-testid="deployment-profile-web-stack-status"
              >
                <span
                  className={
                    "inline-block w-2 h-2 rounded-full " +
                    (webStackRunning
                      ? "bg-secondary"
                      : "bg-on-surface-variant/40")
                  }
                />
                <span>
                  {webStackRunning
                    ? "Web stack running"
                    : "Web stack not running"}
                </span>
              </div>
            </div>
          )}
        </>
      )}

      {confirm.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60"
          data-testid="deployment-profile-confirm-modal"
        >
          <div className="bg-surface-container rounded-lg p-4 max-w-md space-y-3">
            <h5 className="text-sm font-medium text-on-surface">
              Enable web-accessible profile?
            </h5>
            <p className="text-xs text-on-surface-variant">
              This will start the Caddy / LiveKit / coturn / sslh stack
              and walk you through DNS + port-forward setup. Continue?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="deployment-profile-confirm-cancel"
                disabled={confirm.busy}
                onClick={() =>
                  setConfirm({ open: false, busy: false })
                }
                className="px-3 py-1.5 text-sm text-on-surface hover:bg-surface-container-high rounded-md transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="deployment-profile-confirm-enable"
                disabled={confirm.busy}
                onClick={handleConfirmEnable}
                className="px-3 py-1.5 text-sm primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface rounded-md transition-colors"
              >
                {confirm.busy ? "Starting…" : "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
