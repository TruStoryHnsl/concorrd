/**
 * Porch Phase E — Backup settings tab.
 *
 * Two surfaces in one component:
 *
 *   1. **My backup targets** — peers we push our porch backup to. The
 *      user adds a target by peer-id (paste from the peer's QR-share or
 *      `concord://` deeplink); per-target "Push now" / "Restore from
 *      this" actions; status badges showing last_success_at /
 *      last_failure_reason.
 *
 *   2. **Storing backups for** — the read-only role view. Whoever has
 *      added us as a target shows up here so the user knows who's
 *      relying on them. No actions; the backup-peer side stores
 *      whatever the upstream sends.
 *
 * Native only — browsers don't host a porch. The component renders an
 * empty-state notice when `isTauri()` returns false.
 */

import { useEffect, useState } from "react";
import {
  type BackupTarget,
  type ReceivedBackupSummary,
  porchBackupAddTarget,
  porchBackupCheckRemoteInfo,
  porchBackupListReceived,
  porchBackupListTargets,
  porchBackupPushNow,
  porchBackupRemoveTarget,
  porchBackupRestoreFrom,
} from "../../api/porch";

export function BackupSettings() {
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [received, setReceived] = useState<ReceivedBackupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draftPeerId, setDraftPeerId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingPeerId, setPendingPeerId] = useState<string | null>(null);
  // Confirm-modal state for destructive restore. `null` = closed.
  const [restorePeerId, setRestorePeerId] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [t, r] = await Promise.all([
        porchBackupListTargets(),
        porchBackupListReceived(),
      ]);
      setTargets(t);
      setReceived(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const peer = draftPeerId.trim();
    if (!peer) return;
    try {
      await porchBackupAddTarget(peer, draftLabel.trim() || null);
      setDraftPeerId("");
      setDraftLabel("");
      setAdding(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (peerId: string) => {
    try {
      await porchBackupRemoveTarget(peerId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePushNow = async (peerId: string) => {
    setPendingPeerId(peerId);
    setError(null);
    try {
      await porchBackupPushNow(peerId);
      setToast(`Backup pushed to ${shortPeerId(peerId)}.`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingPeerId(null);
    }
  };

  const handleConfirmRestore = async () => {
    if (!restorePeerId) return;
    const peer = restorePeerId;
    setRestorePeerId(null);
    setPendingPeerId(peer);
    setError(null);
    try {
      const result = await porchBackupRestoreFrom(peer, true);
      setToast(`Restored from ${shortPeerId(peer)} (schema v${result.schema_version}).`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingPeerId(null);
    }
  };

  // Background: probe each target for remote info so the UI can
  // display "remote schema v5, 1.2 MB". Done in a single effect on
  // mount + after reload; failures are silent so a single offline
  // target doesn't poison the whole list.
  const [remoteInfos, setRemoteInfos] = useState<
    Record<string, ReceivedBackupSummary | null>
  >({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const updates: Record<string, ReceivedBackupSummary | null> = {};
      for (const t of targets) {
        try {
          const info = await porchBackupCheckRemoteInfo(t.peer_id);
          if (cancelled) return;
          updates[t.peer_id] = info;
        } catch {
          updates[t.peer_id] = null;
        }
      }
      if (!cancelled) {
        setRemoteInfos(updates);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targets]);

  return (
    <div
      data-testid="backup-settings"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 12,
        background: "var(--surface, #18191c)",
        color: "var(--on-surface, #e3e4e6)",
      }}
    >
      <section
        style={{
          background: "var(--surface-container, #1f2125)",
          border: "1px solid var(--outline-variant, #2a2c30)",
          borderRadius: 8,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            opacity: 0.8,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>My backup targets</span>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              data-testid="backup-add-target-button"
              style={{
                fontSize: 11,
                background: "transparent",
                border: "1px solid var(--outline-variant, #2a2c30)",
                color: "inherit",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: "pointer",
                marginLeft: "auto",
                textTransform: "none",
                letterSpacing: 0,
              }}
            >
              + Add target
            </button>
          )}
        </div>

        {adding && (
          <form
            onSubmit={handleAdd}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
            data-testid="backup-add-target-form"
          >
            <input
              type="text"
              value={draftPeerId}
              onChange={(e) => setDraftPeerId(e.target.value)}
              placeholder="Peer id (12D3KooW…)"
              autoFocus
              data-testid="backup-add-target-peer-id"
              style={inputStyle}
            />
            <input
              type="text"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="Label (optional)"
              data-testid="backup-add-target-label"
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="submit"
                disabled={!draftPeerId.trim()}
                data-testid="backup-add-target-submit"
                style={{
                  ...buttonStyle,
                  background: "var(--primary, #4f9eff)",
                  color: "white",
                  cursor: draftPeerId.trim() ? "pointer" : "not-allowed",
                  opacity: draftPeerId.trim() ? 1 : 0.5,
                }}
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setDraftPeerId("");
                  setDraftLabel("");
                }}
                style={buttonStyle}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div style={{ fontSize: 13, opacity: 0.6, fontStyle: "italic" }}>
            Loading targets…
          </div>
        ) : targets.length === 0 ? (
          <div
            data-testid="backup-no-targets"
            style={{ fontSize: 13, opacity: 0.6, fontStyle: "italic" }}
          >
            No backup targets yet. Add a trusted peer to push encrypted
            backups to.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
            data-testid="backup-target-list"
          >
            {targets.map((t) => {
              const remote = remoteInfos[t.peer_id];
              const pending = pendingPeerId === t.peer_id;
              return (
                <li
                  key={t.peer_id}
                  data-testid={`backup-target-row-${t.peer_id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    fontSize: 13,
                    border: "1px solid var(--outline-variant, #2a2c30)",
                    borderRadius: 4,
                  }}
                >
                  <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: 500 }}>
                      {t.label ?? shortPeerId(t.peer_id)}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>
                      {shortPeerId(t.peer_id)}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      {t.last_success_at
                        ? `Last push: ${formatRelative(t.last_success_at)}`
                        : "Never pushed"}
                      {t.last_failure_reason && (
                        <span style={{ color: "var(--error, #e57373)" }}>
                          {" · "}Last error: {t.last_failure_reason}
                        </span>
                      )}
                    </span>
                    {remote && (
                      <span style={{ fontSize: 11, opacity: 0.6 }}>
                        Remote: schema v{remote.schema_version},{" "}
                        {formatBytes(remote.blob_size)} (received{" "}
                        {formatRelative(remote.received_at)})
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlePushNow(t.peer_id)}
                    disabled={pending}
                    data-testid={`backup-push-now-${t.peer_id}`}
                    style={{
                      ...buttonStyle,
                      background: "var(--primary, #4f9eff)",
                      color: "white",
                      opacity: pending ? 0.5 : 1,
                    }}
                  >
                    {pending ? "Pushing…" : "Push now"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRestorePeerId(t.peer_id)}
                    disabled={pending}
                    data-testid={`backup-restore-from-${t.peer_id}`}
                    style={buttonStyle}
                  >
                    Restore from this
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRemove(t.peer_id)}
                    data-testid={`backup-remove-target-${t.peer_id}`}
                    style={buttonStyle}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Backup-peer role surface. Read-only. */}
      <section
        style={{
          background: "var(--surface-container, #1f2125)",
          border: "1px solid var(--outline-variant, #2a2c30)",
          borderRadius: 8,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
        data-testid="backup-received-section"
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            opacity: 0.8,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Storing backups for
        </div>
        {received.length === 0 ? (
          <div
            data-testid="backup-no-received"
            style={{ fontSize: 13, opacity: 0.6, fontStyle: "italic" }}
          >
            No one is using this install as a backup peer.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {received.map((r) => (
              <li
                key={r.uploader_peer_id}
                data-testid={`backup-received-row-${r.uploader_peer_id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  fontSize: 13,
                  border: "1px solid var(--outline-variant, #2a2c30)",
                  borderRadius: 4,
                }}
              >
                <span style={{ flex: 1 }}>{shortPeerId(r.uploader_peer_id)}</span>
                <span style={{ fontSize: 11, opacity: 0.6 }}>
                  schema v{r.schema_version} · {formatBytes(r.blob_size)} ·{" "}
                  {formatRelative(r.received_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <div
          data-testid="backup-error"
          style={{
            fontSize: 12,
            color: "var(--error, #e57373)",
            background: "rgba(229, 115, 115, 0.08)",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}

      {toast && (
        <div
          data-testid="backup-toast"
          style={{
            fontSize: 12,
            color: "var(--primary, #4f9eff)",
            background: "rgba(79, 158, 255, 0.08)",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          {toast}
        </div>
      )}

      {restorePeerId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="backup-restore-confirm-title"
          data-testid="backup-restore-confirm-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "var(--surface, #18191c)",
              border: "1px solid var(--outline-variant, #2a2c30)",
              borderRadius: 8,
              padding: 16,
              maxWidth: 480,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <h2
              id="backup-restore-confirm-title"
              style={{ margin: 0, fontSize: 16 }}
            >
              Restore from backup?
            </h2>
            <p style={{ margin: 0, fontSize: 13 }}>
              This will replace your local porch DB with the one stored
              on{" "}
              <strong>{shortPeerId(restorePeerId)}</strong>. The current
              porch state will be overwritten. Continue?
            </p>
            <div
              style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
            >
              <button
                type="button"
                onClick={() => setRestorePeerId(null)}
                data-testid="backup-restore-confirm-cancel"
                style={buttonStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmRestore()}
                data-testid="backup-restore-confirm-yes"
                style={{
                  ...buttonStyle,
                  background: "var(--error, #e57373)",
                  color: "white",
                }}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: 4,
  border: "1px solid var(--outline-variant, #2a2c30)",
  background: "var(--surface, #18191c)",
  color: "inherit",
};

const buttonStyle: React.CSSProperties = {
  fontSize: 12,
  background: "transparent",
  border: "1px solid var(--outline-variant, #2a2c30)",
  color: "inherit",
  padding: "4px 10px",
  borderRadius: 4,
  cursor: "pointer",
};

function shortPeerId(peerId: string): string {
  if (peerId.length <= 16) return peerId;
  return `${peerId.slice(0, 8)}…${peerId.slice(-6)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(unixMs: number): string {
  const diff = Date.now() - unixMs;
  if (diff < 0) return "in the future";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default BackupSettings;
