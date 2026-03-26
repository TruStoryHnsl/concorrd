import { useEffect, useState, useCallback } from "react";
import { getSystemHealth } from "@/api/tauri";
import type { SystemHealth, HealthEvent } from "@/api/tauri";

function HealthPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const data = await getSystemHealth();
      setHealth(data);
    } catch (err) {
      console.warn("Failed to fetch system health:", err);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
    const interval = setInterval(() => void fetchHealth(), 5000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  if (!health) {
    return (
      <div className="mesh-background min-h-full flex items-center justify-center">
        <div className="relative z-10 text-center space-y-3">
          <span className="material-symbols-outlined text-5xl text-primary/40 animate-pulse">
            monitor_heart
          </span>
          <p className="font-headline font-semibold text-on-surface">
            Loading health data...
          </p>
        </div>
      </div>
    );
  }

  const ramPercent = Math.round((health.ramUsedGb / health.ramTotalGb) * 100);
  const diskPercent = Math.min(Math.round((health.diskIoMbps / 5) * 100), 100);
  const maxBandwidth = Math.max(...health.bandwidthIn, ...health.bandwidthOut, 1);

  return (
    <div className="mesh-background min-h-full">
      <div className="relative z-10 max-w-[1600px] mx-auto p-6 md:p-10">
        {/* Header Section */}
        <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <span className="text-primary font-headline text-sm tracking-widest uppercase font-bold">
              System Integrity
            </span>
            <h2 className="text-4xl md:text-5xl font-headline font-bold mt-2 tracking-tight">
              Health Pipeline
            </h2>
            <p className="text-on-surface-variant mt-3 max-w-xl leading-relaxed font-body">
              Monitoring real-time telemetry across decentralized nodes.
              Performance metrics reflect global network consensus and local
              resource allocation.
            </p>
          </div>
          <div className="flex gap-4">
            <button className="bg-surface-container-high text-on-surface px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-surface-container-highest transition-all active:scale-95 border border-outline-variant/10">
              <span className="material-symbols-outlined text-sm">
                download
              </span>
              Export CSV
            </button>
            <button className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-8 py-3 rounded-xl font-bold shadow-lg shadow-primary/10 hover:brightness-110 transition-all active:scale-95">
              Node Audit
            </button>
          </div>
        </div>

        {/* Bento Grid Layout */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Node Stability Index */}
          <div className="md:col-span-4 bg-surface-container-low rounded-2xl p-8 relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-6 opacity-10">
              <span className="material-symbols-outlined text-8xl">
                verified_user
              </span>
            </div>
            <div className="relative z-10 h-full flex flex-col justify-between">
              <div>
                <h3 className="text-on-surface-variant font-label text-xs uppercase tracking-[0.2em] font-bold">
                  Node Stability Index
                </h3>
                <div className="mt-6 flex items-baseline gap-2">
                  <span className="text-6xl font-headline font-bold text-secondary tracking-tighter">
                    {health.stabilityIndex.toFixed(1)}
                  </span>
                  <span className="text-2xl font-headline font-medium text-secondary/60">
                    %
                  </span>
                </div>
              </div>
              <div className="mt-8">
                <div className="h-2 w-full bg-surface-container-highest rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-secondary to-tertiary-dim rounded-full transition-all duration-700"
                    style={{ width: `${Math.min(health.stabilityIndex, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between mt-3">
                  <span className="text-[10px] text-on-surface-variant font-bold uppercase">
                    Optimal Threshold
                  </span>
                  <span className="text-[10px] text-secondary font-bold uppercase">
                    High Performance
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Real-time Bandwidth */}
          <div className="md:col-span-8 bg-surface-container-low rounded-2xl p-8 flex flex-col">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-on-surface-variant font-label text-xs uppercase tracking-[0.2em] font-bold">
                Real-time Bandwidth (kbps)
              </h3>
              <div className="flex gap-4">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-primary" />
                  <span className="text-[10px] text-on-surface-variant font-bold uppercase">
                    Inbound
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-secondary" />
                  <span className="text-[10px] text-on-surface-variant font-bold uppercase">
                    Outbound
                  </span>
                </div>
              </div>
            </div>
            {/* Bar Chart */}
            <div className="flex-grow flex items-end gap-1 h-48">
              {health.bandwidthIn.map((inVal, i) => {
                const outVal = health.bandwidthOut[i] ?? 0;
                const inHeight = Math.max((inVal / maxBandwidth) * 100, 4);
                const outHeight = Math.max((outVal / maxBandwidth) * 100, 4);
                return (
                  <div key={i} className="flex-1 flex items-end gap-[2px]">
                    <div
                      className="flex-1 bg-primary/20 rounded-t-sm hover:bg-primary/60 transition-colors cursor-help"
                      style={{ height: `${inHeight}%` }}
                      title={`In: ${inVal}kbps`}
                    />
                    <div
                      className="flex-1 bg-secondary/20 rounded-t-sm hover:bg-secondary/60 transition-colors cursor-help"
                      style={{ height: `${outHeight}%` }}
                      title={`Out: ${outVal}kbps`}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Latency + Active Peers (stacked) */}
          <div className="md:col-span-4 grid grid-rows-2 gap-6">
            {/* Network Latency */}
            <div className="bg-surface-container-high rounded-2xl p-6 flex items-center justify-between group hover:bg-surface-container-highest transition-colors">
              <div>
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider">
                  Network Latency
                </span>
                <div className="text-3xl font-headline font-bold text-primary mt-1">
                  {health.latencyMs}
                  <span className="text-lg opacity-50 ml-1">ms</span>
                </div>
              </div>
              <div className="w-12 h-12 rounded-full border border-primary/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                <span className="material-symbols-outlined text-primary">
                  speed
                </span>
              </div>
            </div>
            {/* Active Peers */}
            <div className="bg-surface-container-high rounded-2xl p-6 flex items-center justify-between group hover:bg-surface-container-highest transition-colors">
              <div>
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider">
                  Active Peers
                </span>
                <div className="text-3xl font-headline font-bold text-tertiary-dim mt-1">
                  {health.activePeers.toLocaleString()}
                </div>
              </div>
              <div className="w-12 h-12 rounded-full border border-tertiary-dim/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                <span className="material-symbols-outlined text-tertiary-dim">
                  group_work
                </span>
              </div>
            </div>
          </div>

          {/* Resource Allocation */}
          <div className="md:col-span-4 bg-surface-container-low rounded-2xl p-8">
            <h3 className="text-on-surface-variant font-label text-xs uppercase tracking-[0.2em] font-bold mb-8">
              Resource Allocation
            </h3>
            <div className="space-y-8">
              {/* CPU */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium font-body">
                    Local CPU Usage
                  </span>
                  <span className="text-sm font-bold text-primary">
                    {health.cpuPercent.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 w-full bg-surface-container-highest rounded-full">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-700"
                    style={{ width: `${Math.min(health.cpuPercent, 100)}%` }}
                  />
                </div>
              </div>
              {/* RAM */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium font-body">
                    Allocated RAM
                  </span>
                  <span className="text-sm font-bold text-secondary">
                    {health.ramUsedGb.toFixed(1)}
                    <span className="text-[10px] ml-1 opacity-60">GB</span>
                  </span>
                </div>
                <div className="h-1.5 w-full bg-surface-container-highest rounded-full">
                  <div
                    className="h-full bg-secondary rounded-full transition-all duration-700"
                    style={{ width: `${ramPercent}%` }}
                  />
                </div>
              </div>
              {/* Disk I/O */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium font-body">
                    Disk I/O
                  </span>
                  <span className="text-sm font-bold text-tertiary-dim">
                    {health.diskIoMbps.toFixed(1)}
                    <span className="text-[10px] ml-1 opacity-60">MB/s</span>
                  </span>
                </div>
                <div className="h-1.5 w-full bg-surface-container-highest rounded-full">
                  <div
                    className="h-full bg-tertiary-dim rounded-full transition-all duration-700"
                    style={{ width: `${diskPercent}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Node Event Log */}
          <div className="md:col-span-4 bg-surface-container-low rounded-2xl p-0 overflow-hidden flex flex-col">
            <div className="p-6 border-b border-outline-variant/10">
              <h3 className="text-on-surface-variant font-label text-xs uppercase tracking-[0.2em] font-bold">
                Node Event Log
              </h3>
            </div>
            <div className="flex-grow p-4 font-mono text-[11px] overflow-y-auto max-h-[250px] space-y-3 bg-surface-container-lowest/30">
              {health.events.map((event, i) => (
                <EventLogEntry key={i} event={event} />
              ))}
            </div>
            <div className="p-4 bg-surface-container-high flex items-center justify-center">
              <button className="text-[10px] font-bold uppercase tracking-widest text-primary hover:text-on-background transition-colors">
                View Full Registry
              </button>
            </div>
          </div>

          {/* Bottom Status Bar */}
          <div className="md:col-span-12 glass-panel rounded-2xl p-6 flex flex-wrap gap-12 items-center border border-outline-variant/5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-primary text-2xl">
                  dns
                </span>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase text-on-surface-variant">
                  Primary Hub
                </div>
                <div className="font-headline font-bold">
                  Western European Relay
                </div>
              </div>
            </div>
            <div className="h-8 w-px bg-outline-variant/20 hidden md:block" />
            <div className="flex-1 flex justify-around">
              <div className="text-center">
                <div className="text-[10px] font-bold uppercase text-on-surface-variant mb-1">
                  Uptime
                </div>
                <div className="font-headline text-lg font-bold">
                  {health.uptime}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] font-bold uppercase text-on-surface-variant mb-1">
                  Encrypted Traffic
                </div>
                <div className="font-headline text-lg font-bold text-secondary">
                  {health.encryptedTrafficTb.toFixed(1)} TB
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] font-bold uppercase text-on-surface-variant mb-1">
                  Node Reputation
                </div>
                <div className="font-headline text-lg font-bold text-primary">
                  {health.reputation}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Event Log Entry ────────────────────────────────────── */

function EventLogEntry({ event }: { event: HealthEvent }) {
  const levelColor =
    event.level === "OK"
      ? "text-secondary"
      : event.level === "INFO"
        ? "text-tertiary-dim"
        : "text-error";

  return (
    <div className="flex gap-3">
      <span className="text-primary opacity-50 shrink-0">
        {event.timestamp}
      </span>
      <span className={levelColor}>[{event.level}]</span>
      <span className="text-on-surface/80">{event.message}</span>
    </div>
  );
}

export default HealthPage;
