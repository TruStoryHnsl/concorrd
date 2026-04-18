import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores/auth";
import { getServiceNodeConfig } from "../../api/concord";
import { servitudeStatus, isTauri, type ServitudeState } from "../../api/servitude";
import { ServiceNodeSection } from "./AdminTab";

export type HostingStatus = "loading" | "running" | "stopped" | "error";

function statusColor(status: HostingStatus): string {
  switch (status) {
    case "running": return "bg-green-500";
    case "stopped": return "bg-orange-400";
    case "error": return "bg-red-500";
    default: return "bg-outline-variant/40";
  }
}

function statusLabel(status: HostingStatus): string {
  switch (status) {
    case "running": return "Hosting active";
    case "stopped": return "Not hosting";
    case "error": return "Hosting error";
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
          const res = await servitudeStatus();
          if (cancelled) return;
          const state: ServitudeState = res.state;
          if (state === "running") setStatus("running");
          else if (state === "starting" || state === "stopping") setStatus("stopped");
          else setStatus("stopped");
          if (Object.keys(res.degraded_transports).length > 0) setStatus("error");
        } else {
          // Web: check if service node is configured and responding.
          if (!accessToken) { setStatus("stopped"); return; }
          const cfg = await getServiceNodeConfig(accessToken);
          if (cancelled) return;
          // Running if any transport is enabled.
          const anyTransport = cfg.transports &&
            Object.values(cfg.transports).some(Boolean);
          setStatus(anyTransport ? "running" : "stopped");
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
  const accessToken = useAuthStore((s) => s.accessToken);
  const hostingStatus = useHostingStatus();

  return (
    <div className="flex flex-col gap-6">
      {/* Status banner */}
      <div className="flex items-center gap-3 p-4 rounded-xl bg-surface-container">
        <div className={`w-3 h-3 rounded-full flex-shrink-0 ${statusColor(hostingStatus)}`} />
        <div>
          <div className="text-sm font-headline font-semibold text-on-surface">
            {statusLabel(hostingStatus)}
          </div>
          <div className="text-xs text-on-surface-variant font-body">
            Servitude manages your Concord hosting configuration
          </div>
        </div>
      </div>

      <ServiceNodeSection token={accessToken} />
    </div>
  );
}
