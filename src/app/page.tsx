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

function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  const colors: Record<string, string> = {
    emerald: "border-emerald-500/30 bg-emerald-500/5 text-emerald-400",
    blue: "border-blue-500/30 bg-blue-500/5 text-blue-400",
    green: "border-green-500/30 bg-green-500/5 text-green-400",
    red: "border-red-500/30 bg-red-500/5 text-red-400",
    yellow: "border-yellow-500/30 bg-yellow-500/5 text-yellow-400",
    purple: "border-purple-500/30 bg-purple-500/5 text-purple-400",
    orange: "border-orange-500/30 bg-orange-500/5 text-orange-400",
    pink: "border-pink-500/30 bg-pink-500/5 text-pink-400",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || colors.emerald}`}>
      <div className="text-2xl lg:text-3xl font-bold">{value}</div>
      <div className="text-sm opacity-70">{label}</div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [liveJobs, setLiveJobs] = useState<any[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  // Initial stats fetch
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      });
  }, []);

  // SSE connection for live job updates
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

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;
  if (!stats) return <div className="text-red-400">Failed to load stats</div>;

  const successRate =
    stats.jobs.total > 0
      ? ((stats.jobs.completed / stats.jobs.total) * 100).toFixed(1)
      : "—";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <span className={`text-xs px-2 py-1 rounded ${connected ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
          {connected ? "🟢 Live" : "🔴 Reconnecting..."}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 mb-8">
        <StatCard label="Wallets" value={stats.wallets} color="emerald" />
        <StatCard label="Collections" value={stats.collections} color="blue" />
        <StatCard label="Total Jobs" value={stats.jobs.total} color="purple" />
        <StatCard label="Completed" value={stats.jobs.completed} color="green" />
        <StatCard label="Failed" value={stats.jobs.failed} color="red" />
        <StatCard label="Pending" value={stats.jobs.pending} color="yellow" />
        <StatCard label="Flashbots" value={stats.jobs.flashbots} color="purple" />
        <StatCard label="Dry Runs" value={stats.jobs.dryRuns} color="orange" />
      </div>

      <div className="mb-8 flex gap-4 lg:gap-6 flex-wrap">
        <p className="text-sm text-zinc-400">
          Success rate: <span className="text-white font-semibold">{successRate}%</span>
        </p>
        {stats.alerts > 0 && (
          <p className="text-sm text-zinc-400">
            Alerts: <span className="text-orange-400 font-semibold">{stats.alerts}</span>
          </p>
        )}
      </div>

      {/* Live Jobs (SSE) */}
      <h3 className="text-lg font-semibold mb-3">Live Jobs {liveJobs.length > 0 && <span className="text-xs text-zinc-500">(SSE)</span>}</h3>
      {liveJobs.length === 0 ? (
        <p className="text-zinc-500 text-sm">No live job data yet. Create a mint job to see updates.</p>
      ) : (
        <div className="overflow-x-auto -mx-4 lg:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-3">Job</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3 hidden sm:table-cell">Flags</th>
                <th className="pb-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {liveJobs.slice(0, 10).map((job: any) => (
                <tr key={job.id} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-3 font-mono text-xs text-zinc-400">
                    {job.id.slice(0, 8)}...
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="py-2 pr-3 hidden sm:table-cell">
                    <div className="flex gap-1">
                      {job.useFlashbots && <span className="px-1.5 py-0.5 text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30 rounded">FB</span>}
                      {job.dryRun && <span className="px-1.5 py-0.5 text-[10px] bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 rounded">DRY</span>}
                    </div>
                  </td>
                  <td className="py-2 text-red-400 text-xs max-w-[120px] lg:max-w-[200px] truncate">
                    {job.error || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-green-500/10 text-green-400 border-green-500/30",
    failed: "bg-red-500/10 text-red-400 border-red-500/30",
    pending: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
    running: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    cancelled: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  );
}
