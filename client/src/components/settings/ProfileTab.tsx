import { useState, useRef, useEffect } from "react";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";
import { useIdentityStore, IDENTITY_ERROR_NATIVE_ONLY } from "../../stores/identity";
import { isTauri } from "../../api/servitude";
import { changePassword, getTOTPStatus, setupTOTP, verifyTOTP, disableTOTP, getRecoveryEmailStatus, setRecoveryEmail, type TOTPSetupResult } from "../../api/concord";
import { Avatar } from "../ui/Avatar";
import { PeerCardDisplay } from "../peers/PeerCardDisplay";
import { PeerCardScanner } from "../peers/PeerCardScanner";
import { KnownPeersList } from "../peers/KnownPeersList";
import { DeploymentProfileSection } from "./DeploymentProfileSection";
import { useBrowserLibp2p } from "../../hooks/useBrowserLibp2p";
import {
  subscribeToLanPeers,
  type LanPeer,
} from "../../api/lanPeers";
import { usePeerStore } from "../../stores/peerStore";

export function ProfileTab() {
  const client = useAuthStore((s) => s.client);
  const userId = useAuthStore((s) => s.userId);
  const logout = useAuthStore((s) => s.logout);
  const addToast = useToastStore((s) => s.addToast);

  const currentName = userId?.split(":")[0].replace("@", "") ?? "";
  const [displayName, setDisplayName] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleNameSave = async () => {
    if (!client || !displayName.trim()) return;
    setSaving(true);
    try {
      await client.setDisplayName(displayName.trim());
      addToast("Display name updated", "success");
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to update display name",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !client) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      addToast("Please select an image file");
      return;
    }

    // Validate size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      addToast("Image must be under 2MB");
      return;
    }

    setUploading(true);
    try {
      const response = await client.uploadContent(file, {
        type: file.type,
      });
      const mxcUrl = response.content_uri;
      await client.setAvatarUrl(mxcUrl);
      addToast("Avatar updated", "success");
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to upload avatar",
      );
    } finally {
      setUploading(false);
      // Clear file input so the same file can be re-selected
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-semibold text-on-surface">Profile</h3>

      {/* Avatar preview + upload */}
      <div className="flex items-center gap-4">
        {userId && <Avatar userId={userId} size="lg" />}
        <div className="space-y-1">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
          >
            {uploading ? "Uploading..." : "Change Avatar"}
          </button>
          <p className="text-xs text-on-surface-variant">JPG, PNG, or GIF. Max 2MB.</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarUpload}
            className="hidden"
          />
        </div>
      </div>

      {/* Display name */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-on-surface">
          Display Name
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <button
            onClick={handleNameSave}
            disabled={saving || !displayName.trim() || displayName === currentName}
            className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* User ID (read-only) */}
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-on-surface-variant">User ID</span>
        <span className="text-sm text-on-surface-variant font-mono">{userId}</span>
      </div>

      {/* Peer identity (Phase 2 — Ed25519 device identity) */}
      <PeerIdentitySection />

      {/* Swarm status (Phase 3 — libp2p swarm). Renders DIRECTLY
          beneath the PeerIdentitySection so the two derived-from-the-
          same-seed identity surfaces stay visually paired. */}
      <SwarmStatusSection />

      {/* Paired peers (Phase 5 — peer pairing UX). Renders DIRECTLY
          beneath SwarmStatusSection so the user can see "this is who I
          am on the swarm" immediately above "and these are the people
          I've paired with." */}
      <PairedPeersSection />

      {/* Deployment profile (Phase 7 — native default profile).
          Renders the native/web toggle and the Phase-0 hosting
          status summary when the operator flips to web_first. */}
      <DeploymentProfileSection />

      {/* Password change */}
      <PasswordChangeSection />

      {/* Recovery email (INS-071 Phase A) */}
      <RecoveryEmailSection />

      {/* Two-factor authentication */}
      <TOTPSection />

      <div className="border-t border-outline-variant/15 pt-6">
        <button
          onClick={logout}
          className="text-error border border-error/30 rounded px-4 py-2 hover:bg-error/10 transition-colors text-sm font-label font-medium min-h-[44px]"
        >
          Logout
        </button>
      </div>
    </div>
  );
}

function PasswordChangeSection() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [saving, setSaving] = useState(false);

  const canSubmit =
    currentPw.length > 0 &&
    newPw.length >= 8 &&
    newPw === confirmPw &&
    !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !accessToken) return;

    setSaving(true);
    try {
      await changePassword(currentPw, newPw, accessToken);
      addToast("Password changed successfully", "success");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to change password",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-outline-variant/15 pt-6 space-y-3">
      <h4 className="text-sm font-medium text-on-surface">Change Password</h4>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          value={currentPw}
          onChange={(e) => setCurrentPw(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <input
          type="password"
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          placeholder="New password (min 8 characters)"
          autoComplete="new-password"
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <input
          type="password"
          value={confirmPw}
          onChange={(e) => setConfirmPw(e.target.value)}
          placeholder="Confirm new password"
          autoComplete="new-password"
          className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        {newPw.length > 0 && newPw.length < 8 && (
          <p className="text-xs text-primary">
            Password must be at least 8 characters
          </p>
        )}
        {confirmPw.length > 0 && newPw !== confirmPw && (
          <p className="text-xs text-error">Passwords do not match</p>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
        >
          {saving ? "Changing..." : "Change Password"}
        </button>
      </form>
    </div>
  );
}

function TOTPSection() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setupData, setSetupData] = useState<TOTPSetupResult | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    getTOTPStatus(accessToken).then((r) => setEnabled(r.enabled)).catch(() => {});
  }, [accessToken]);

  const handleSetup = async () => {
    if (!accessToken) return;
    setWorking(true);
    try {
      const data = await setupTOTP(accessToken);
      setSetupData(data);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setWorking(false);
    }
  };

  const handleVerify = async () => {
    if (!accessToken || code.length !== 6) return;
    setWorking(true);
    try {
      await verifyTOTP(code, accessToken);
      setEnabled(true);
      setSetupData(null);
      setCode("");
      addToast("Two-factor authentication enabled", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setWorking(false);
    }
  };

  const handleDisable = async () => {
    if (!accessToken || disableCode.length !== 6) return;
    setWorking(true);
    try {
      await disableTOTP(disableCode, accessToken);
      setEnabled(false);
      setDisableCode("");
      addToast("Two-factor authentication disabled", "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to disable");
    } finally {
      setWorking(false);
    }
  };

  if (enabled === null) return null;

  return (
    <div className="border-t border-outline-variant/15 pt-6 space-y-3">
      <h4 className="text-sm font-medium text-on-surface">Two-Factor Authentication</h4>

      {enabled ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-secondary" />
            <span className="text-sm text-secondary">Enabled</span>
          </div>
          <p className="text-xs text-on-surface-variant">
            Your account is protected with an authenticator app. Your online indicator appears on the left side of your avatar.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Enter code to disable"
              className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-error/30 font-mono tracking-widest"
              maxLength={6}
            />
            <button
              onClick={handleDisable}
              disabled={working || disableCode.length !== 6}
              className="px-4 py-2 bg-error hover:bg-error-dim disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
            >
              Disable
            </button>
          </div>
        </div>
      ) : setupData ? (
        <div className="space-y-4">
          <p className="text-xs text-on-surface-variant">
            Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code to confirm.
          </p>
          <div className="flex justify-center">
            <img
              src={setupData.qr_code}
              alt="TOTP QR Code"
              className="w-48 h-48 rounded-lg bg-white p-2"
            />
          </div>
          <div className="bg-surface-container rounded p-2">
            <p className="text-xs text-on-surface-variant mb-1">Manual entry key:</p>
            <p className="text-xs text-on-surface font-mono break-all select-all">{setupData.secret}</p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit code"
              className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30 font-mono tracking-widest text-center text-lg"
              maxLength={6}
              autoFocus
            />
            <button
              onClick={handleVerify}
              disabled={working || code.length !== 6}
              className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
            >
              {working ? "..." : "Verify"}
            </button>
          </div>
          <button
            onClick={() => setSetupData(null)}
            className="text-xs text-on-surface-variant hover:text-on-surface"
          >
            Cancel setup
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-on-surface-variant">
            Add an extra layer of security by requiring a code from an authenticator app when you log in.
            Authorized users have their online indicator on the left side of their avatar.
          </p>
          <button
            onClick={handleSetup}
            disabled={working}
            className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
          >
            {working ? "Setting up..." : "Set Up Authenticator"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * INS-071 Phase A — recovery email section.
 *
 * Privacy invariant: this component NEVER displays the actual recovery
 * email value. The only state it ever knows about the existing email is
 * a boolean (configured / not set). Operators reviewing the rendered DOM
 * cannot read another user's recovery email from this UI.
 */
function RecoveryEmailSection() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const addToast = useToastStore((s) => s.addToast);
  const [hasEmail, setHasEmail] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    getRecoveryEmailStatus(accessToken)
      .then((r) => setHasEmail(r.has_recovery_email))
      .catch(() => setHasEmail(false));
  }, [accessToken]);

  const handleSave = async (clear: boolean) => {
    if (!accessToken) return;
    const value = clear ? null : input.trim();
    if (!clear && (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))) {
      addToast("Please enter a valid email address");
      return;
    }
    setSaving(true);
    try {
      await setRecoveryEmail(value, accessToken);
      setHasEmail(value !== null);
      setInput("");
      addToast(
        clear ? "Recovery email removed" : "Recovery email saved",
        "success",
      );
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : "Failed to save recovery email",
      );
    } finally {
      setSaving(false);
    }
  };

  if (hasEmail === null) return null;

  return (
    <div className="border-t border-outline-variant/15 pt-6 space-y-3">
      <h4 className="text-sm font-medium text-on-surface">Recovery Email</h4>
      <p className="text-xs text-on-surface-variant">
        Optional. Used to send a password reset link if you forget your
        password. The server stores this only for recovery; it is never
        displayed back to you, to admins, or anywhere else in the app.
      </p>
      <div className="flex items-center gap-2">
        <span
          className={
            "w-2 h-2 rounded-full " +
            (hasEmail ? "bg-secondary" : "bg-on-surface-variant/40")
          }
        />
        <span
          className={
            "text-sm " + (hasEmail ? "text-secondary" : "text-on-surface-variant")
          }
        >
          {hasEmail ? "Recovery email configured" : "Recovery email not set"}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="email"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            hasEmail
              ? "Enter a new email to replace"
              : "you@example.com"
          }
          autoComplete="email"
          className="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded text-sm text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        <button
          onClick={() => handleSave(false)}
          disabled={saving || input.trim().length === 0}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      {hasEmail && (
        <button
          onClick={() => handleSave(true)}
          disabled={saving}
          className="text-xs text-error hover:underline"
        >
          Remove recovery email
        </button>
      )}
    </div>
  );
}

/**
 * Peer identity surface (Phase 2 — Ed25519 device identity).
 *
 * Renders the fingerprint string returned by the Tauri `peer_identity`
 * command, with a copy-to-clipboard control alongside it. The private key
 * never enters this component — see `../../stores/identity.ts` and
 * `../../api/peerIdentity.ts` for the wire-contract guards.
 *
 * Web build (no `__TAURI_INTERNALS__`): renders the same row layout as
 * the User ID display above, but with a "native builds only" placeholder
 * in the value column. Matches the precedent set by `HostingTab` /
 * `AboutTab` which keep their tab rendered in the web build but degrade
 * the native-only controls gracefully.
 */
function PeerIdentitySection() {
  const fingerprint = useIdentityStore((s) => s.fingerprint);
  const isLoading = useIdentityStore((s) => s.isLoading);
  const error = useIdentityStore((s) => s.error);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    // Pull `load` off the store imperatively so it isn't a hook dep — the
    // function identity is stable inside zustand but lint can't see that
    // and we don't want re-fires if any state slice mutates.
    useIdentityStore.getState().load();
  }, []);

  const handleCopy = async () => {
    if (!fingerprint) return;
    try {
      await navigator.clipboard.writeText(fingerprint);
      addToast("Peer fingerprint copied", "success");
    } catch {
      addToast("Couldn't copy to clipboard", "error");
    }
  };

  // Native-only placeholder for the web build. We deliberately render the
  // row so the visual structure stays consistent between native + web —
  // hiding it entirely would make the User ID row look like a dead-end.
  if (!isTauri() || error === IDENTITY_ERROR_NATIVE_ONLY) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-on-surface-variant">Peer Identity</span>
        <span className="text-sm text-on-surface-variant italic">
          native builds only
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 gap-3">
      <span className="text-sm text-on-surface-variant">Peer Identity</span>
      <div className="flex items-center gap-2 min-w-0">
        {isLoading && !fingerprint ? (
          <span className="text-sm text-on-surface-variant italic">Loading…</span>
        ) : error && !fingerprint ? (
          <span
            className="text-sm text-error truncate"
            title={error}
          >
            Failed to load
          </span>
        ) : fingerprint ? (
          <>
            <span
              className="text-sm text-on-surface-variant font-mono truncate"
              title={fingerprint}
            >
              {fingerprint}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="btn-press inline-flex items-center justify-center px-2 py-1 rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
              aria-label="Copy peer fingerprint"
              title="Copy peer fingerprint"
            >
              <span
                className="material-symbols-outlined text-base leading-none"
                style={{ fontVariationSettings: '"FILL" 0, "wght" 500, "GRAD" 0, "opsz" 24' }}
              >
                content_copy
              </span>
            </button>
          </>
        ) : (
          <span className="text-sm text-on-surface-variant italic">—</span>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 3 — libp2p swarm status row.
 *
 * Renders directly beneath the Phase 2 [`PeerIdentitySection`] because
 * the two surfaces are derived from the same per-install Ed25519 seed
 * (see `src-tauri/src/servitude/identity.rs` for the architectural
 * unification note). The local libp2p `PeerId`, the multiaddrs the
 * swarm is listening on, the current connected-peer count, and a label
 * for the last observed swarm event are displayed.
 *
 * Web build (no `__TAURI_INTERNALS__`): renders a native-only
 * placeholder row matching the precedent set by
 * [`PeerIdentitySection`].
 *
 * Phase 3 polling note: we currently re-fetch on a 5-second cadence
 * via `setInterval`. A future revision will switch this to the
 * `peer_swarm_event` Tauri event bus the backend already publishes,
 * eliminating the poll entirely. The polling fallback is acceptable
 * here because the swarm cache update on the backend is itself an
 * O(1) lock-and-clone; the cost is one IPC round-trip every 5 s
 * with the Settings → Profile tab open.
 */
function SwarmStatusSection() {
  const peerId = useIdentityStore((s) => s.swarmPeerId);
  const multiaddrs = useIdentityStore((s) => s.swarmMultiaddrs);
  const peerCount = useIdentityStore((s) => s.swarmPeerCount);
  const lastEvent = useIdentityStore((s) => s.swarmLastEvent);
  const isLoading = useIdentityStore((s) => s.swarmLoading);
  const error = useIdentityStore((s) => s.swarmError);

  useEffect(() => {
    // Initial fetch, then poll on a 5 s cadence while the tab is mounted.
    // See the function-doc note above for why polling is acceptable in
    // Phase 3.
    useIdentityStore.getState().loadSwarm();
    if (!isTauri()) return;
    const id = setInterval(() => {
      useIdentityStore.getState().loadSwarm();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Native-only placeholder for the web build. Same convention as
  // PeerIdentitySection above — render the row so the visual structure
  // stays consistent between native + web.
  if (!isTauri() || error === IDENTITY_ERROR_NATIVE_ONLY) {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-on-surface-variant">Swarm</span>
        <span className="text-sm text-on-surface-variant italic">
          native builds only
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-2">
      {/* Our PeerId */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-on-surface-variant pt-0.5">
          Our PeerId
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {isLoading && !peerId ? (
            <span className="text-sm text-on-surface-variant italic">
              Loading…
            </span>
          ) : error && !peerId ? (
            <span
              className="text-sm text-error truncate"
              title={error}
            >
              Failed to load
            </span>
          ) : peerId ? (
            <span
              className="text-sm text-on-surface-variant font-mono truncate"
              title={peerId}
            >
              {peerId}
            </span>
          ) : (
            <span className="text-sm text-on-surface-variant italic">
              swarm not started
            </span>
          )}
        </div>
      </div>

      {/* Listening multiaddrs */}
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm text-on-surface-variant pt-0.5">
          Listening on
        </span>
        <div className="flex flex-col items-end gap-0.5 min-w-0">
          {multiaddrs.length === 0 ? (
            <span className="text-sm text-on-surface-variant italic">—</span>
          ) : (
            multiaddrs.map((addr) => (
              <span
                key={addr}
                className="text-xs text-on-surface-variant font-mono truncate"
                title={addr}
              >
                {addr}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Peer count */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-on-surface-variant">
          Peers connected
        </span>
        <span className="text-sm text-on-surface-variant font-mono">
          {peerCount}
        </span>
      </div>

      {/* Last event */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-on-surface-variant">Last event</span>
        <span
          className="text-xs text-on-surface-variant truncate"
          title={lastEvent ?? undefined}
        >
          {lastEvent ?? "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * Paired Peers (Phase 5 — peer pairing UX).
 *
 * Bundles the three pairing surfaces — display your card, add a peer,
 * list paired peers — into one Profile-tab section. Renders directly
 * beneath `SwarmStatusSection` (per the architecture note above).
 *
 * Native-only — but each child component handles its own web-build
 * placeholder so the section's outer chrome stays consistent.
 */
function PairedPeersSection() {
  const [scannerOpen, setScannerOpen] = useState(false);

  // Phase 9 (bundle split): the paired-peers surface is the other
  // trigger for lazily loading the browser libp2p stack. Mounting
  // this section means the user is actively looking at P2P state,
  // so we kick the swarm up here. No-op on Tauri (the Rust swarm IS
  // the libp2p layer) — see `useBrowserLibp2p` for the detect path.
  useBrowserLibp2p({ enabled: true });

  return (
    <div className="border-t border-outline-variant/15 pt-6 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-on-surface">Paired Peers</h4>
        <p className="text-xs text-on-surface-variant">
          Direct, server-less connections to other Concord installs.
        </p>
      </div>

      {/* Your card — QR + copyable link + post-to-room. */}
      <PeerCardDisplay />

      {/* Add-a-peer launcher. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setScannerOpen(true)}
          disabled={!isTauri()}
          className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
        >
          Add a peer…
        </button>
      </div>

      {/* List of currently paired peers. */}
      <KnownPeersList />

      {/* Peers on your LAN (post-2026-05-29 architecture redirect).
          mDNS-discovered peers on the local network are surfaced here
          alongside the persistent paired-peers list. One-click pair
          promotes a LAN peer into the persistent peer store. */}
      <LanPeersSection />

      {/* Scanner modal — mounted only while open so the camera
          permission prompt fires on demand, not on every Profile
          tab render. */}
      {scannerOpen && (
        <PeerCardScanner onClose={() => setScannerOpen(false)} />
      )}
    </div>
  );
}

/**
 * Peers on your LAN (post-2026-05-29 redirect).
 *
 * Subscribes to the `peer_lan_discovered` Tauri event via
 * `subscribeToLanPeers` and renders the mDNS-discovered peer list.
 * The list is session-scoped (resets each launch) — no persistence by
 * design; if the user wants to keep a LAN peer, they pair it into the
 * persistent peer store via the per-row "Pair" action.
 *
 * Native-only — browsers can't observe LAN peers (no portable mDNS
 * from a tab), so the section renders a thin placeholder on web.
 */
function LanPeersSection() {
  const [lanPeers, setLanPeers] = useState<LanPeer[]>([]);
  const addFromCard = usePeerStore((s) => s.addFromCard);
  const addToast = useToastStore((s) => s.addToast);

  useEffect(() => {
    const unsub = subscribeToLanPeers((peers) => setLanPeers(peers));
    return unsub;
  }, []);

  const handlePair = async (peer: LanPeer) => {
    // We have no public-key bytes from mDNS — the discovery payload
    // is just (peer_id, multiaddrs). The peer-store accepts a partial
    // card; the `publicKeyHex` field is derived from the peer_id by
    // the backend on the next handshake. For now we send empty
    // publicKeyHex; if the backend rejects it (it currently requires
    // a real key) the toast surfaces the error.
    const added = await addFromCard(
      {
        peerId: peer.peerId,
        publicKeyHex: "",
        multiaddrs: peer.multiaddrs,
      },
      // The PeerSource enum's broadest variant. mDNS / LAN-discovered
      // peers don't have a dedicated source today; "deeplink" is the
      // best fit because the user took an explicit pair action, which
      // is the same posture as clicking a `concord://` link.
      "deeplink",
    );
    if (added) {
      addToast("LAN peer paired", "success");
    } else {
      addToast("Could not pair LAN peer");
    }
  };

  if (!isTauri()) {
    return (
      <div className="space-y-1.5">
        <div className="text-xs text-on-surface-variant uppercase tracking-wide">
          Peers on your LAN
        </div>
        <p className="text-xs text-on-surface-variant italic">
          LAN peer discovery (mDNS) runs in native builds only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-on-surface-variant uppercase tracking-wide">
        Peers on your LAN
      </div>
      {lanPeers.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">
          No LAN peers discovered yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {lanPeers.map((peer) => (
            <li
              key={peer.peerId}
              className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-surface-container-high"
            >
              <span
                className="text-sm text-on-surface-variant font-mono truncate flex-1 min-w-0"
                title={peer.peerId}
              >
                {peer.peerId.slice(0, 12)}…
              </span>
              <button
                type="button"
                onClick={() => void handlePair(peer)}
                className="px-3 py-1 text-xs rounded-md primary-glow hover:brightness-110 text-on-surface transition-colors whitespace-nowrap"
              >
                Pair this peer
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
