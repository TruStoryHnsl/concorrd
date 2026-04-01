import { useState } from "react";
import { setServerUrl } from "../../api/serverUrl";

interface Props {
  onConnected: () => void;
}

export function ServerConnect({ onConnected }: Props) {
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    const cleaned = url.trim().replace(/\/$/, "");
    setTesting(true);
    setError("");

    try {
      // Test connectivity by hitting the health endpoint
      const resp = await fetch(`${cleaned}/api/health`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const data = await resp.json();
      if (data.status !== "ok") throw new Error("Unexpected health response");

      // Save and proceed
      await setServerUrl(cleaned);
      onConnected();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message === "Failed to fetch"
            ? "Cannot reach server. Check the URL and try again."
            : err.message
          : "Connection failed",
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="h-screen bg-surface flex items-center justify-center mesh-background">
      <div className="relative z-10 w-full max-w-md px-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-headline font-bold text-on-surface mb-2">
            Concord
          </h1>
          <p className="text-on-surface-variant text-sm font-body">
            Connect to your Concord server
          </p>
        </div>

        <form onSubmit={handleConnect} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-on-surface mb-1.5">
              Server URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setError(""); }}
              placeholder="https://chat.example.com"
              autoFocus
              required
              className="w-full px-4 py-3 bg-surface-container border border-outline-variant rounded-lg text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 font-mono text-sm"
            />
            <p className="text-xs text-on-surface-variant mt-1.5">
              Enter the URL of your Concord instance
            </p>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-error-container/10 border border-error/20">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={testing || !url.trim()}
            className="w-full py-3 primary-glow hover:brightness-110 disabled:opacity-40 text-on-surface font-medium rounded-lg transition-all text-sm"
          >
            {testing ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-on-surface/30 border-t-on-surface rounded-full animate-spin" />
                Connecting...
              </span>
            ) : (
              "Connect"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
