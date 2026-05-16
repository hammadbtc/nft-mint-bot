"use client";

import { useEffect, useState } from "react";

interface Stats {
  wallets: number;
  collections: number;
  alerts: number;
  jobs: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    running: number;
    dryRuns: number;
    flashbots: number;
  };
  recentActivity: any[];
}

const cards = [
  { key: "wallets",    label: "WALLETS",      accent: "card-accent-emerald", valueKey: "wallets" as const },
  { key: "collections", label: "COLLECTIONS",  accent: "card-accent-blue",    valueKey: "collections" as const },
  { key: "total",      label: "TOTAL JOBS",    accent: "card-accent-purple",  valueKey: "total" as const },
  { key: "completed",  label: "COMPLETED",     accent: "card-accent-lime",    valueKey: "completed" as const },
  { key: "failed",     label: "FAILED",        accent: "card-accent-rose",    valueKey: "failed" as const },
  { key: "pending",    label: "PENDING",       accent: "card-accent-amber",   valueKey: "pending" as const },
  { key: "flashbots",  label: "FLASHBOTS",     accent: "card-accent-purple",  valueKey: "flashbots" as const },
  { key: "dryRuns",    label: "DRY RUNS",      accent: "card-accent-cyan",    valueKey: "dryRuns" as const },
];

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [liveJobs, setLiveJobs] = useState<any[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource("/api/stream");
      setConnected(true);

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "initial" || data.type === "update") {
            setLiveJobs(data.jobs || []);
          }
        } catch {}
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        reconnectTimer = setTimeout(connect, 5000);
      };
    };

    connect();
    return () => {
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-zinc-600 font-[family-name:var(--font-geist-mono)] text-xs uppercase tracking-widest animate-pulse">
          Loading...
        </span>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-red-400/60 font-[family-name:var(--font-geist-mono)] text-xs uppercase tracking-widest">
          Failed to load stats
        </span>
      </div>
    );
  }

  const successRate =
    stats.jobs.total > 0
      ? ((stats.jobs.completed / stats.jobs.total) * 100).toFixed(1)
      : "—";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-white text-lg font-semibold tracking-tight">Dashboard</h2>
          <p className="text-zinc-600 text-xs font-[family-name:var(--font-geist-mono)] uppercase tracking-widest mt-0.5">
            System Overview
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-zinc-600 text-[11px] font-[family-name:var(--font-geist-mono)]">
            SUCCESS RATE <span className="text-white font-semibold">{successRate}%</span>
          </span>
          <span className={`text-[10px] px-2 py-1 rounded font-[family-name:var(--font-geist-mono)] uppercase tracking-wider ${
            connected
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : "bg-red-500/10 text-red-400 border border-red-500/20"
          }`}>
            {connected ? "LIVE" : "OFFLINE"}
          </span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-10">
        {cards.map((card) => {
          const value = card.valueKey === "wallets" || card.valueKey === "collections"
            ? (stats as any)[card.valueKey]
            : (stats.jobs as any)[card.valueKey];
          return (
            <div
              key={card.key}
              className={`${card.accent} bg-zinc-900/70 border border-zinc-800/70 rounded-lg p-4 hover:bg-zinc-900 transition-colors`}
            >
              <div className="text-[10px] text-zinc-600 font-[family-name:var(--font-geist-mono)] uppercase tracking-widest mb-2">
                {card.label}
              </div>
              <div className="text-3xl font-semibold text-white tracking-tight font-[family-name:var(--font-geist-mono)]">
                {value ?? 0}
              </div>
            </div>
          );
        })}
      </div>

      {/* Live jobs */}
      <div>
        <h3 className="text-white text-sm font-semibold tracking-tight mb-4 flex items-center gap-2">
          LIVE JOBS
          {liveJobs.length > 0 && (
            <span className="text-[10px] text-zinc-600 font-[family-name:var(--font-geist-mono)]">
              SSE
            </span>
          )}
        </h3>

        {liveJobs.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
            <span className="text-zinc-600 text-xs font-[family-name:var(--font-geist-mono)] uppercase tracking-widest">
              No active jobs
            </span>
          </div>
        ) : (
          <div className="overflow-x-auto border border-zinc-800/50 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-zinc-800/50">
                  <th className="py-3 px-4 text-[10px] text-zinc-600 font-[family-name:var(--font-geist-mono)] uppercase tracking-widest font-medium">
                    Job
                  </th>
                  <th className="py-3 px-4 text-[10px] text-zinc-600 font-[family-name:var(--font-geist-mono)] uppercase tracking-widest font-medium">
                    Status
                  </th>
                  <th className="py-3 px-4 text-[10px] text-zinc-600 font-[family-name:var(--font-geist-mono)] uppercase tracking-widest font-medium hidden sm:table-cell">
                    Flags
                  </th>
                  <th className="py-3 px-4 text-[10px] text-zinc-600 font-[family-name:var(--font-geist-mono)] uppercase tracking-widest font-medium">
                    Error
                  </th>
                </tr>
              </thead>
              <tbody>
                {liveJobs.slice(0, 10).map((job: any) => (
                  <tr key={job.id} className="border-b border-zinc-800/30 hover:bg-zinc-900/50 transition-colors">
                    <td className="py-2.5 px-4 font-[family-name:var(--font-geist-mono)] text-xs text-zinc-500">
                      {job.id.slice(0, 8)}&hellip;
                    </td>
                    <td className="py-2.5 px-4">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="py-2.5 px-4 hidden sm:table-cell">
                      <div className="flex gap-1">
                        {job.useFlashbots && (
                          <span className="px-1.5 py-0.5 text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded font-[family-name:var(--font-geist-mono)] uppercase tracking-wider">
                            FB
                          </span>
                        )}
                        {job.dryRun && (
                          <span className="px-1.5 py-0.5 text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded font-[family-name:var(--font-geist-mono)] uppercase tracking-wider">
                            DRY
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-red-400/60 text-xs max-w-[140px] lg:max-w-[220px] truncate font-[family-name:var(--font-geist-mono)]">
                      {job.error || <span className="text-zinc-700">&mdash;</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    failed: "bg-red-500/10 text-red-400 border-red-500/20",
    pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    running: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    cancelled: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-[10px] border font-[family-name:var(--font-geist-mono)] uppercase tracking-wider ${
        styles[status] || styles.pending
      }`}
    >
      {status}
    </span>
  );
}
