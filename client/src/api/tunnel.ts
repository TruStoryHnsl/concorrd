/**
 * Phase G — tunnel-only inbound hardening API wrapper.
 *
 * Thin wrapper around the `tunnel_get_config` / `tunnel_set_config` /
 * `tunnel_detect_interfaces` Tauri commands exposed by
 * `src-tauri/src/lib.rs`. Mirrors the contract in
 * `src-tauri/src/servitude/network/`.
 *
 * Web build: every call short-circuits to a permissive default. Web
 * tabs can't host an inbound libp2p surface, so the gate is a no-op
 * concept there — but the API surface still exists so the same
 * Settings panel renders without runtime branching.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./servitude";

/**
 * Operator-facing tunnel-hardening preferences. Persisted to
 * `<app_local_data_dir>/tunnel_config.json` on the Rust side.
 */
export interface TunnelConfig {
  /** True iff inbound non-tunnel connections are rejected. */
  enforce: boolean;
  /**
   * Extra CIDR blocks (string form, e.g. `"10.42.0.0/16"`) the
   * operator wants trusted beyond auto-detected tunnel interfaces.
   * Strings — not parsed structures — to keep the JSON readable.
   */
  extraCidrs: string[];
}

/**
 * Snapshot of the tunnel-detection layer's current view. The
 * settings panel renders this directly.
 */
export interface TunnelDetectionReport {
  /** CIDRs the OS-level probe surfaced + loopback. */
  autoDetectedCidrs: string[];
  /** auto + operator extras. */
  effectiveCidrs: string[];
  /** Whether the gate is currently rejecting non-tunnel inbound. */
  enforceActive: boolean;
}

/**
 * Wire shape returned by the Rust backend. snake_case ↔ camelCase
 * is handled by `#[serde(rename_all = "camelCase")]` on the Rust
 * structs, so the wire payloads already carry camelCase keys.
 */
interface RawTunnelConfig {
  enforce: boolean;
  extraCidrs: string[];
}

interface RawTunnelDetectionReport {
  autoDetectedCidrs: string[];
  effectiveCidrs: string[];
  enforceActive: boolean;
}

/**
 * Validate a single CIDR string client-side BEFORE sending to the
 * backend. The Rust side silently skips invalid entries when
 * parsing — we surface them to the user instead so a typo doesn't
 * vanish into a permissive default.
 *
 * Returns null when valid, otherwise a short human-readable reason.
 */
export function validateCidr(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "CIDR cannot be empty";
  const slash = trimmed.indexOf("/");
  if (slash < 0) return "Expected a CIDR (e.g. 10.42.0.0/16)";
  const ipPart = trimmed.slice(0, slash);
  const lenStr = trimmed.slice(slash + 1);
  const len = Number.parseInt(lenStr, 10);
  if (!Number.isFinite(len) || len < 0) {
    return "Invalid CIDR prefix length";
  }
  // Detect v4 vs v6 by colon presence.
  if (ipPart.includes(":")) {
    if (len > 128) return "IPv6 prefix must be ≤ 128";
    return validateIpv6(ipPart) ? null : "Invalid IPv6 address";
  }
  if (len > 32) return "IPv4 prefix must be ≤ 32";
  return validateIpv4(ipPart) ? null : "Invalid IPv4 address";
}

function validateIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number.parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

function validateIpv6(s: string): boolean {
  // Lightweight check — full IPv6 is a thicket. Accept anything
  // that matches the basic syntactic shape. The backend re-validates
  // via `ipnet` so a permissive client-side check is fine.
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}

/**
 * Read the current persisted tunnel config. On a web build (no
 * Tauri runtime), returns a permissive default — there's no inbound
 * surface to gate.
 */
export async function getTunnelConfig(): Promise<TunnelConfig> {
  if (!isTauri()) {
    return { enforce: false, extraCidrs: [] };
  }
  const raw = await invoke<RawTunnelConfig>("tunnel_get_config");
  return {
    enforce: raw.enforce,
    extraCidrs: raw.extraCidrs ?? [],
  };
}

/**
 * Persist a new tunnel config AND push it into the running swarm's
 * gate. On the web build, this is a no-op that round-trips the
 * input.
 */
export async function setTunnelConfig(
  config: TunnelConfig,
): Promise<TunnelConfig> {
  if (!isTauri()) {
    return config;
  }
  const raw = await invoke<RawTunnelConfig>("tunnel_set_config", {
    config: { enforce: config.enforce, extraCidrs: config.extraCidrs },
  });
  return {
    enforce: raw.enforce,
    extraCidrs: raw.extraCidrs ?? [],
  };
}

/**
 * Snapshot of the auto-detected + effective CIDR sets. On web,
 * returns an empty placeholder.
 */
export async function detectTunnelInterfaces(): Promise<TunnelDetectionReport> {
  if (!isTauri()) {
    return {
      autoDetectedCidrs: [],
      effectiveCidrs: [],
      enforceActive: false,
    };
  }
  const raw = await invoke<RawTunnelDetectionReport>(
    "tunnel_detect_interfaces",
  );
  return {
    autoDetectedCidrs: raw.autoDetectedCidrs ?? [],
    effectiveCidrs: raw.effectiveCidrs ?? [],
    enforceActive: raw.enforceActive,
  };
}
