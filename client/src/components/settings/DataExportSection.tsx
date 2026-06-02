/**
 * F1c — Settings → Hosting → Data — "Export this instance" section.
 *
 * Surfaces the two Tauri commands (`home_export_package` +
 * `home_send_export`) behind a single Export-and-Deliver flow:
 *
 *   1. Operator clicks "Export this instance".
 *   2. Modal opens — passphrase + confirmation, target-peer dropdown,
 *      Send button. The dropdown is populated from the local peer-store
 *      via {@link fetchKnownPeers}.
 *   3. On Send:
 *      - `homeExportPackage(passphrase, targetPeerId)` builds the
 *        sealed `.concord-pkg` file under `<app_data>/exports/`.
 *      - `homeSendExport(packagePath, targetPeerId)` streams it to the
 *        chosen peer over `/concord/home-export/1.0.0`.
 *   4. Result panel — SHA-256, bytes sent, accepted/rejected state.
 *      "Save package locally too" → native save dialog +
 *      `homeExportCopyTo` to copy the file to the chosen destination.
 *
 * In-flight states use `<BringingUpSplash size="compact" />` per the
 * standing rule that there is exactly ONE loading visual in this app.
 *
 * Native-only — the section renders a short read-only explainer in a
 * web build.
 */

import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import { isTauri } from "../../api/servitude";
import { fetchKnownPeers, type KnownPeer } from "../../api/peerStore";
import {
  homeExportCopyTo,
  homeExportPackage,
  homeSendExport,
  type DeliveryReceipt,
  type ExportManifest,
} from "../../api/homeExport";
import { BringingUpSplash } from "../BringingUpSplash";

type Phase =
  | { kind: "idle" }
  | { kind: "exporting" }
  | { kind: "sending"; manifest: ExportManifest }
  | { kind: "done"; manifest: ExportManifest; receipt: DeliveryReceipt }
  | { kind: "error"; message: string };

function shortPeer(peerId: string): string {
  if (peerId.length <= 12) return peerId;
  return `${peerId.slice(0, 8)}…${peerId.slice(-4)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [target, setTarget] = useState("");
  const [peers, setPeers] = useState<KnownPeer[] | null>(null);
  const [peersError, setPeersError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  // Load paired peers for the dropdown.
  useEffect(() => {
    let cancelled = false;
    fetchKnownPeers()
      .then((list) => {
        if (!cancelled) setPeers(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPeersError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const passOk = pass1.length > 0 && pass1 === pass2;
  const canSend =
    phase.kind === "idle" &&
    passOk &&
    target.length > 0 &&
    peers !== null;

  const handleSend = async () => {
    if (!canSend) return;
    setPhase({ kind: "exporting" });
    try {
      const manifest = await homeExportPackage(pass1, target);
      setPhase({ kind: "sending", manifest });
      const receipt = await homeSendExport(
        manifest.packagePath,
        manifest.targetPeerId,
      );
      setPhase({ kind: "done", manifest, receipt });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message });
    }
  };

  const handleSaveLocal = async () => {
    if (phase.kind !== "done") return;
    try {
      const dst = await saveDialog({
        defaultPath: phase.manifest.packagePath.split("/").pop() ??
          "concord-home-export.concord-pkg",
        filters: [{ name: "Concord package", extensions: ["concord-pkg"] }],
      });
      if (!dst) return;
      await homeExportCopyTo(phase.manifest.packagePath, dst);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget && phase.kind !== "exporting" && phase.kind !== "sending") {
          onClose();
        }
      }}
    >
      <div
        className="bg-surface-container rounded-xl border border-outline-variant/15 shadow-2xl w-full max-w-lg mx-4"
        data-testid="home-export-modal"
      >
        <div className="flex items-center justify-between p-4 border-b border-outline-variant/15">
          <h2 className="text-lg font-semibold text-on-surface">
            Export this instance
          </h2>
          <button
            onClick={onClose}
            disabled={phase.kind === "exporting" || phase.kind === "sending"}
            aria-label="Close export modal"
            className="text-on-surface-variant hover:text-on-surface disabled:opacity-30 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {(phase.kind === "idle" || phase.kind === "error") && (
            <>
              <p className="text-sm text-on-surface-variant">
                Package your home server&apos;s data and deliver it to a
                paired peer for longer-term storage and analysis. The
                bundle is encrypted with a passphrase only you know.
              </p>

              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">
                  Passphrase
                </label>
                <input
                  type="password"
                  value={pass1}
                  onChange={(e) => setPass1(e.target.value)}
                  autoComplete="new-password"
                  className="w-full px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
                  data-testid="home-export-pass1"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">
                  Confirm passphrase
                </label>
                <input
                  type="password"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  autoComplete="new-password"
                  className="w-full px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
                  data-testid="home-export-pass2"
                />
                {pass2.length > 0 && pass1 !== pass2 && (
                  <p className="mt-1 text-xs text-red-400">
                    Passphrases don&apos;t match.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-on-surface mb-1">
                  Send to
                </label>
                {peersError && (
                  <p className="text-xs text-red-400">
                    Couldn&apos;t load paired peers: {peersError}
                  </p>
                )}
                {peers === null && !peersError && (
                  <BringingUpSplash size="compact" status="Loading peers…" />
                )}
                {peers !== null && peers.length === 0 && (
                  <p className="text-xs text-on-surface-variant">
                    No paired peers yet. Pair another instance from
                    Settings → Profile first.
                  </p>
                )}
                {peers !== null && peers.length > 0 && (
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-outline-variant rounded text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary/30"
                    data-testid="home-export-target-select"
                  >
                    <option value="">— pick a paired peer —</option>
                    {peers.map((p) => (
                      <option key={p.peerId} value={p.peerId}>
                        {shortPeer(p.peerId)} ({p.source})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {phase.kind === "error" && (
                <div
                  className="text-xs text-red-400 break-words"
                  data-testid="home-export-error"
                >
                  {phase.message}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className="px-4 py-2 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface text-sm rounded-md transition-colors"
                  data-testid="home-export-send"
                >
                  Send
                </button>
              </div>
            </>
          )}

          {phase.kind === "exporting" && (
            <BringingUpSplash
              size="compact"
              status="Sealing the package — this can take a moment (Argon2id at 64 MiB)…"
            />
          )}

          {phase.kind === "sending" && (
            <div className="space-y-2">
              <BringingUpSplash size="compact" status="Delivering to peer…" />
              <p className="text-xs text-on-surface-variant break-all">
                {formatBytes(phase.manifest.sizeBytes)} → {shortPeer(phase.manifest.targetPeerId)}
              </p>
            </div>
          )}

          {phase.kind === "done" && (
            <div className="space-y-3" data-testid="home-export-done">
              <h3 className="text-sm font-semibold text-on-surface">
                {phase.receipt.rejectedReason === null
                  ? "Delivered."
                  : "Receiver rejected the delivery."}
              </h3>
              <dl className="text-xs text-on-surface-variant space-y-1">
                <div className="flex justify-between gap-2">
                  <dt>SHA-256</dt>
                  <dd className="break-all text-right font-mono">
                    {phase.receipt.packageSha256}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Bytes sent</dt>
                  <dd>{formatBytes(phase.receipt.bytesSent)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Package</dt>
                  <dd className="break-all text-right">
                    {phase.manifest.packagePath}
                  </dd>
                </div>
                {phase.receipt.rejectedReason !== null && (
                  <div className="flex justify-between gap-2">
                    <dt>Reason</dt>
                    <dd>{phase.receipt.rejectedReason}</dd>
                  </div>
                )}
              </dl>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={handleSaveLocal}
                  className="px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface border border-outline-variant rounded transition-colors"
                  data-testid="home-export-save-local"
                >
                  Save package locally too
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs primary-glow hover:brightness-110 text-on-surface rounded-md transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DataExportSection() {
  const [open, setOpen] = useState(false);

  if (!isTauri()) {
    return (
      <section className="flex flex-col gap-2 p-3 rounded-xl bg-surface-container">
        <h3 className="text-sm font-headline font-semibold text-on-surface">
          Data
        </h3>
        <p className="text-xs text-on-surface-variant">
          Encrypted home-server exports are a native-only feature. Open
          Concord on the device hosting your home server to package its
          data for a trusted outside instance.
        </p>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-2 p-3 rounded-xl bg-surface-container"
      data-testid="data-export-section"
    >
      <h3 className="text-sm font-headline font-semibold text-on-surface">
        Data
      </h3>
      <p className="text-xs text-on-surface-variant">
        Send an encrypted copy of this instance&apos;s home server (the
        persistent space — porch state is never exported) to a paired
        peer for longer-term storage and more advanced analysis.
      </p>
      <div>
        <button
          onClick={() => setOpen(true)}
          className="px-3 py-1.5 text-xs primary-glow hover:brightness-110 text-on-surface rounded-md transition-colors"
          data-testid="data-export-open"
        >
          Export this instance
        </button>
      </div>
      {open && <ExportModal onClose={() => setOpen(false)} />}
    </section>
  );
}
