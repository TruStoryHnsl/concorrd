/**
 * Phase G — tunnel-only inbound hardening surface.
 *
 * Renders inside Settings → Connections (UserConnectionsTab) next to
 * `PeerConnectionsSection`. Three controls:
 *
 *   - Enforce toggle. When on, the libp2p swarm rejects inbound
 *     connections from non-tunnel IPs BEFORE noise handshake.
 *   - Read-only list of auto-detected CIDRs (WireGuard / Tailscale /
 *     loopback). Detected by the Rust backend via getifaddrs(3) on
 *     Linux/macOS; no probe on iOS — see porch-design.md Phase G.
 *   - Editable list of extra CIDRs (e.g. operator's custom VPN at
 *     10.42.0.0/16). Validated client-side; the backend re-validates
 *     and silently skips unparseable strings as a defence-in-depth
 *     fallback.
 *
 * Web build is a thin placeholder — there's no inbound surface to
 * gate from a browser tab, so the section explains that and offers
 * no controls.
 */

import { useEffect, useState } from "react";

import {
  detectTunnelInterfaces,
  getTunnelConfig,
  setTunnelConfig,
  validateCidr,
  type TunnelConfig,
  type TunnelDetectionReport,
} from "../../../api/tunnel";
import { isTauri } from "../../../api/servitude";
import { useToastStore } from "../../../stores/toast";

export function TunnelHardeningSection() {
  const [config, setConfig] = useState<TunnelConfig | null>(null);
  const [report, setReport] = useState<TunnelDetectionReport | null>(null);
  const [newCidr, setNewCidr] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, rep] = await Promise.all([
          getTunnelConfig(),
          detectTunnelInterfaces(),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setReport(rep);
      } catch (err) {
        if (!cancelled) {
          addToast(
            `Couldn't load tunnel config: ${
              err instanceof Error ? err.message : String(err)
            }`,
            "error",
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addToast]);

  const persist = async (next: TunnelConfig) => {
    setIsSaving(true);
    try {
      const saved = await setTunnelConfig(next);
      setConfig(saved);
      // Re-detect so the auto-detected list mirrors the freshly-saved
      // extras (auto = everything in CIDRs minus extras).
      const rep = await detectTunnelInterfaces();
      setReport(rep);
    } catch (err) {
      addToast(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleEnforceToggle = async () => {
    if (!config) return;
    await persist({ ...config, enforce: !config.enforce });
  };

  const handleAddCidr = async () => {
    if (!config) return;
    const err = validateCidr(newCidr);
    if (err) {
      setValidationError(err);
      return;
    }
    setValidationError(null);
    const trimmed = newCidr.trim();
    if (config.extraCidrs.includes(trimmed)) {
      setValidationError("Already in list");
      return;
    }
    await persist({
      ...config,
      extraCidrs: [...config.extraCidrs, trimmed],
    });
    setNewCidr("");
  };

  const handleRemoveCidr = async (cidr: string) => {
    if (!config) return;
    await persist({
      ...config,
      extraCidrs: config.extraCidrs.filter((c) => c !== cidr),
    });
  };

  if (!isTauri()) {
    return (
      <div
        className="border-t border-outline-variant/20 pt-6 space-y-2"
        data-testid="tunnel-hardening-section"
      >
        <h4 className="text-sm font-headline font-semibold text-on-surface">
          Tunnel hardening (P2P)
        </h4>
        <p className="text-xs text-on-surface-variant">
          The browser build can't be an inbound P2P peer, so the
          tunnel-only inbound gate doesn't apply here. Native installs
          can rejected non-tunnel inbound connections from the Settings
          panel.
        </p>
      </div>
    );
  }

  if (isLoading || !config || !report) {
    return (
      <div
        className="border-t border-outline-variant/20 pt-6"
        data-testid="tunnel-hardening-section"
      >
        <p className="text-sm text-on-surface-variant italic">
          Loading tunnel hardening settings…
        </p>
      </div>
    );
  }

  const emptyAutoDetected = report.autoDetectedCidrs.length <= 2; // loopback only
  const warnNoTunnel =
    !config.enforce && emptyAutoDetected && config.extraCidrs.length === 0;

  return (
    <div
      className="border-t border-outline-variant/20 pt-6 space-y-4"
      data-testid="tunnel-hardening-section"
    >
      <div>
        <h4 className="text-sm font-headline font-semibold text-on-surface">
          Tunnel hardening (P2P)
        </h4>
        <p className="text-xs text-on-surface-variant mt-1">
          When enforced, only inbound peers reachable via a
          tunnel-shaped interface (WireGuard, Tailscale, or an
          operator-supplied CIDR) can connect to this install. Outbound
          dials are unaffected — you can still pair with any peer.
        </p>
      </div>

      {/* Enforce toggle */}
      <div className="flex items-center justify-between py-2 gap-3">
        <div className="flex flex-col">
          <span className="text-sm text-on-surface">Tunnel-only mode</span>
          <span className="text-xs text-on-surface-variant">
            Reject inbound connections from non-tunnel IPs
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enforce}
          aria-label="Toggle tunnel-only mode"
          disabled={isSaving}
          onClick={handleEnforceToggle}
          data-testid="tunnel-enforce-toggle"
          className={
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors " +
            (config.enforce
              ? "bg-primary"
              : "bg-surface-container-high border border-outline-variant/40") +
            (isSaving ? " opacity-50" : "")
          }
        >
          <span
            className={
              "inline-block h-4 w-4 transform rounded-full bg-on-surface transition-transform " +
              (config.enforce ? "translate-x-6" : "translate-x-1")
            }
          />
        </button>
      </div>

      {warnNoTunnel && (
        <div
          className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-on-surface-variant"
          data-testid="tunnel-no-interfaces-warning"
        >
          You have no tunnel interfaces (WireGuard / Tailscale).
          Enabling tunnel-only mode would block all inbound
          connections. Add an extra CIDR below first, or set up
          WireGuard / Tailscale on this device.
        </div>
      )}

      {/* Auto-detected list */}
      <div className="space-y-1.5">
        <div className="text-xs text-on-surface-variant uppercase tracking-wide">
          Auto-detected tunnel CIDRs
        </div>
        {report.autoDetectedCidrs.length === 0 ? (
          <p className="text-xs text-on-surface-variant italic">
            No tunnel interfaces detected.
          </p>
        ) : (
          <ul className="space-y-1" data-testid="tunnel-auto-cidrs">
            {report.autoDetectedCidrs.map((cidr) => (
              <li
                key={cidr}
                className="text-xs text-on-surface-variant font-mono"
              >
                {cidr}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editable extras */}
      <div className="space-y-2">
        <div className="text-xs text-on-surface-variant uppercase tracking-wide">
          Extra trusted CIDRs
        </div>
        {config.extraCidrs.length === 0 ? (
          <p className="text-xs text-on-surface-variant italic">
            No extra CIDRs.
          </p>
        ) : (
          <ul className="space-y-1" data-testid="tunnel-extra-cidrs">
            {config.extraCidrs.map((cidr) => (
              <li
                key={cidr}
                className="flex items-center justify-between gap-2 py-1"
              >
                <span className="text-xs text-on-surface-variant font-mono">
                  {cidr}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRemoveCidr(cidr)}
                  disabled={isSaving}
                  className="text-xs text-on-surface-variant hover:text-error transition-colors"
                  aria-label={`Remove ${cidr}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Add row */}
        <div className="flex gap-2 items-start pt-1">
          <div className="flex-1">
            <input
              type="text"
              value={newCidr}
              onChange={(e) => {
                setNewCidr(e.target.value);
                if (validationError) setValidationError(null);
              }}
              placeholder="10.42.0.0/16"
              aria-label="Add CIDR"
              data-testid="tunnel-add-cidr-input"
              className="w-full text-xs font-mono px-2 py-1.5 rounded-md bg-surface-container-high border border-outline-variant/30 text-on-surface placeholder-on-surface-variant/50"
            />
            {validationError && (
              <span
                className="text-xs text-error mt-1 block"
                data-testid="tunnel-cidr-validation-error"
              >
                {validationError}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleAddCidr()}
            disabled={isSaving || newCidr.trim().length === 0}
            data-testid="tunnel-add-cidr-button"
            className="px-3 py-1.5 text-xs rounded-md primary-glow hover:brightness-110 text-on-surface transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
