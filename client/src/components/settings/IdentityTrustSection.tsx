/**
 * F-A — Settings → Hero Account → Identity & Trust subsection (stub UI).
 *
 * Surfaces the Concord-native user-definition protocol's trust-edge
 * mechanism. The component lists currently-active trust edges and lets
 * the user declare a new edge between two server ids.
 *
 * Polish is INTENTIONALLY light per the F-A spec — this is the surface,
 * not the styled control panel. A future iteration adds the descriptor
 * preview, the per-server-row picker, and the avatar bridge.
 *
 * Web build shows a "Native only" placeholder — the protocol depends on
 * the local Stronghold seed to sign edges, which the browser node
 * doesn't have.
 */

import { useEffect, useState } from "react";

import { isTauri } from "../../api/servitude";
import {
  addTrustEdge,
  listTrustEdges,
  revokeTrustEdge,
  type TrustEdge,
} from "../../api/concordUser";
import { useToastStore } from "../../stores/toast";
import { BringingUpSplash } from "../BringingUpSplash";

export function IdentityTrustSection() {
  if (!isTauri()) {
    return (
      <div
        className="border-t border-outline-variant/20 pt-6 space-y-3"
        data-testid="identity-trust-section"
      >
        <div>
          <h4 className="text-sm font-headline font-semibold text-on-surface">
            Identity & trust edges
          </h4>
          <p className="text-xs text-on-surface-variant mt-1">
            Available on the native build only. The browser tab can't sign
            trust declarations with this install's hero key.
          </p>
        </div>
      </div>
    );
  }
  return <IdentityTrustNative />;
}

function IdentityTrustNative() {
  const [edges, setEdges] = useState<TrustEdge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const addToast = useToastStore((s) => s.addToast);

  const reload = async () => {
    try {
      const list = await listTrustEdges();
      setEdges(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const handleRevoke = async (edge: TrustEdge) => {
    setPending(true);
    try {
      await revokeTrustEdge(edge.edge_id);
      addToast(
        `Revoked trust between ${edge.server_a} and ${edge.server_b}`,
        "success",
      );
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast(`Could not revoke: ${message}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="border-t border-outline-variant/20 pt-6 space-y-4"
      data-testid="identity-trust-section"
    >
      <div>
        <h4 className="text-sm font-headline font-semibold text-on-surface">
          Identity & trust edges
        </h4>
        <p className="text-xs text-on-surface-variant mt-1">
          Concord keeps a separate profile impression per server by
          default — your name, avatar, and bio on Server A don't leak to
          Server B. If you'd like two servers to share one merged
          impression, declare a trust edge between them below. Trust
          edges are append-only: revoking one writes a new revocation
          entry rather than deleting the original declaration.
        </p>
      </div>

      {error && (
        <div
          className="text-xs text-error border border-error/40 rounded-md px-3 py-2"
          data-testid="identity-trust-error"
        >
          {error}
        </div>
      )}

      {edges === null ? (
        <BringingUpSplash size="compact" status="Loading trust edges…" />
      ) : edges.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">
          No trust edges declared. Your servers are isolated from each
          other by default.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="identity-trust-list">
          {edges.map((edge) => (
            <li
              key={edge.edge_id}
              className="text-xs border border-outline-variant/20 rounded-md px-3 py-2 flex items-center gap-3 justify-between"
              data-testid={`identity-trust-edge-${edge.edge_id}`}
            >
              <div className="flex flex-col gap-0.5 truncate">
                <span className="font-medium text-on-surface truncate">
                  {edge.server_a} ↔ {edge.server_b}
                </span>
                <span className="text-on-surface-variant">
                  edge {edge.edge_id} · issued{" "}
                  {new Date(edge.issued_at * 1000).toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                className="text-error hover:underline disabled:opacity-50"
                onClick={() => void handleRevoke(edge)}
                disabled={pending}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <AddTrustEdgeForm
          onCancel={() => setShowAdd(false)}
          onAdded={async () => {
            setShowAdd(false);
            await reload();
          }}
        />
      ) : (
        <button
          type="button"
          className="text-xs font-medium text-primary hover:underline"
          onClick={() => setShowAdd(true)}
          data-testid="identity-trust-add"
        >
          Add new trust edge
        </button>
      )}
    </div>
  );
}

function AddTrustEdgeForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const [serverA, setServerA] = useState("");
  const [serverB, setServerB] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  const canSubmit =
    serverA.trim().length > 0 &&
    serverB.trim().length > 0 &&
    serverA.trim() !== serverB.trim() &&
    !pending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await addTrustEdge(serverA.trim(), serverB.trim());
      addToast(
        `Trust edge added: ${serverA.trim()} ↔ ${serverB.trim()}`,
        "success",
      );
      await onAdded();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      addToast(`Could not add edge: ${message}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 border border-outline-variant/20 rounded-md p-3"
      data-testid="identity-trust-add-form"
    >
      <p className="text-xs text-on-surface-variant">
        Use canonical server ids:{" "}
        <code className="text-on-surface">concord:&lt;domain&gt;</code>,{" "}
        <code className="text-on-surface">matrix:&lt;server_name&gt;</code>,
        or <code className="text-on-surface">porch:&lt;peer_id&gt;</code>.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-on-surface-variant">Server A</span>
        <input
          type="text"
          value={serverA}
          onChange={(e) => setServerA(e.target.value)}
          placeholder="concord:alpha.example"
          className="bg-surface border border-outline-variant/30 rounded-md px-2 py-1 text-sm text-on-surface"
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-on-surface-variant">Server B</span>
        <input
          type="text"
          value={serverB}
          onChange={(e) => setServerB(e.target.value)}
          placeholder="matrix:beta.example"
          className="bg-surface border border-outline-variant/30 rounded-md px-2 py-1 text-sm text-on-surface"
          disabled={pending}
        />
      </label>
      {error && (
        <div className="text-xs text-error">{error}</div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-on-surface-variant hover:underline"
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
        >
          {pending ? "Signing…" : "Sign + add"}
        </button>
      </div>
    </form>
  );
}
