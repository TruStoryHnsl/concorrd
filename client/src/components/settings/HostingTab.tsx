import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import { getServerUrl } from "../../api/serverUrl";
import { servitudeStatus, isTauri, type ServitudeState } from "../../api/servitude";
import { AdminTab } from "./AdminTab";

export type HostingStatus = "loading" | "running" | "stopped" | "error";

function statusColor(status: HostingStatus): string {
  switch (status) {
    case "running": return "bg-green-500";
    case "stopped": return "bg-orange-400";
    case "error": return "bg-red-500";
    default: return "bg-outline-variant/40 animate-pulse";
  }
}

function statusLabel(status: HostingStatus): string {
  switch (status) {
    case "running": return "Instance online";
    case "stopped": return "Server offline";
    case "error": return "Server error";
    default: return "Checking…";
  }
}

export function useHostingStatus(): HostingStatus {
  const [status, setStatus] = useState<HostingStatus>("loading");
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        if (isTauri()) {
          // Native: query embedded servitude lifecycle state.
          const res = await servitudeStatus();
          if (cancelled) return;
          const state: ServitudeState = res.state;
          if (Object.keys(res.degraded_transports).length > 0) {
            setStatus("error");
          } else if (state === "running") {
            setStatus("running");
          } else {
            setStatus("stopped");
          }
        } else {
          // Web/Docker: if /api/health responds, the server is running.
          // We're already talking to it (the page loaded), so this should
          // always be green unless the API goes down mid-session.
          const base = getServerUrl().replace(/\/$/, "");
          const res = await fetch(`${base}/api/health`, { cache: "no-store" });
          if (cancelled) return;
          setStatus(res.ok ? "running" : "error");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    check();
    const interval = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [accessToken]);

  return status;
}

export function HostingTab() {
  const hostingStatus = useHostingStatus();

  return (
    <div className="flex flex-col gap-4">
      {/* Status banner */}
      <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-container">
        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusColor(hostingStatus)}`} />
        <span className="text-sm font-headline font-semibold text-on-surface">
          {statusLabel(hostingStatus)}
        </span>
      </div>

      <AdminTab />
    </div>
  );
}
