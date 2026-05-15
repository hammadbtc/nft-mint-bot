"use client";

import { useEffect, useState } from "react";

interface Analytics {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  successRate: number;
  totalGasSpent: string;
  uniqueWallets: number;
  uniqueCollections: number;
  flashbotsJobs: number;
  dryRuns: number;
  recentTxns: {
    txHash: string;
    status: string;
    blockNumber: number | null;
    gasUsed: string | null;
    effectiveGasPrice: string | null;
    createdAt: string;
    chainId: number;
  }[];
  dailyStats: {
    date: string;
    total: number;
    completed: number;
    failed: number;
  }[];
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/analytics").then((r) => r.json().catch(() => null)),
    ]).then(([stats, analytics]) => {
      // Build analytics from stats + recent
      const recentTxns: any[] = [];

      // Collect all attempts with tx hashes
      fetch("/api/jobs?limit=200")
        .then((r) => r.json())
        .then(async (jobs) => {
          for (const job of jobs) {
            if (job.status === "completed") {
              const detail = await fetch(`/api/jobs/${job.id}`).then((r) => r.json());
              for (const attempt of (detail.attempts || [])) {
                if (attempt.txHash) {
                  recentTxns.push({
                    txHash: attempt.txHash,
                    status: attempt.status,
                    blockNumber: attempt.blockNumber,
                    gasUsed: attempt.gasUsed,
                    effectiveGasPrice: attempt.effectiveGasPrice,
                    createdAt: attempt.createdAt,
                    chainId: 1, // default
                  });
                }
              }
            }
          }

          // Calculate daily stats from jobs
          const dailyMap: Record<string, { total: number; completed: number; failed: number }> = {};
          for (const job of jobs) {
            const date = job.createdAt?.split("T")[0] || "unknown";
            if (!dailyMap[date]) dailyMap[date] = { total: 0, completed: 0, failed: 0 };
            dailyMap[date].total++;
            if (job.status === "completed") dailyMap[date].completed++;
            if (job.status === "failed") dailyMap[date].failed++;
          }

          const dailyStats = Object.entries(dailyMap)
            .map(([date, d]) => ({ date, ...d }))
            .sort((a, b) => b.date.localeCompare(a.date));

          // Total gas
          let totalGas = 0n;
          for (const tx of recentTxns) {
            if (tx.gasUsed && tx.effectiveGasPrice) {
              totalGas += BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPrice);
            }
          }

          setData({
            totalJobs: stats.jobs.total,
            completedJobs: stats.jobs.completed,
            failedJobs: stats.jobs.failed,
            successRate: stats.jobs.total > 0 ? (stats.jobs.completed / stats.jobs.total) * 100 : 0,
            totalGasSpent: totalGas.toString(),
            uniqueWallets: stats.wallets,
            uniqueCollections: stats.collections,
            flashbotsJobs: stats.jobs.flashbots || 0,
            dryRuns: stats.jobs.dryRuns || 0,
            recentTxns: recentTxns.slice(0, 20),
            dailyStats: dailyStats.slice(0, 30),
          });
          setLoading(false);
        });
    });
  }, []);

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;
  if (!data) return <div className="text-red-400">Failed to load analytics</div>;

  const formatEth = (wei: string) => {
    try {
      const val = BigInt(wei);
      if (val === 0n) return "0 ETH";
      return `${(Number(val) / 1e18).toFixed(6)} ETH`;
    } catch { return "—"; }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Analytics</h2>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard label="Success Rate" value={`${data.successRate.toFixed(1)}%`} color={data.successRate > 80 ? "green" : data.successRate > 50 ? "yellow" : "red"} />
        <SummaryCard label="Total Gas Spent" value={formatEth(data.totalGasSpent)} color="blue" />
        <SummaryCard label="Flashbots Jobs" value={data.flashbotsJobs.toString()} color="purple" />
        <SummaryCard label="Dry Runs" value={data.dryRuns.toString()} color="orange" />
      </div>

      {/* Daily stats */}
      <h3 className="text-lg font-semibold mb-3">Daily Activity</h3>
      {data.dailyStats.length === 0 ? (
        <p className="text-zinc-500 text-sm mb-8">No data yet.</p>
      ) : (
        <div className="overflow-x-auto mb-8">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-4">Date</th>
                <th className="pb-2 pr-4">Total</th>
                <th className="pb-2 pr-4">Completed</th>
                <th className="pb-2 pr-4">Failed</th>
                <th className="pb-2">Rate</th>
              </tr>
            </thead>
            <tbody>
              {data.dailyStats.map((d) => (
                <tr key={d.date} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-4 text-zinc-400">{d.date}</td>
                  <td className="py-2 pr-4">{d.total}</td>
                  <td className="py-2 pr-4 text-green-400">{d.completed}</td>
                  <td className="py-2 pr-4 text-red-400">{d.failed}</td>
                  <td className="py-2">
                    <span className={d.total > 0 && (d.completed / d.total) > 0.8 ? "text-green-400" : "text-yellow-400"}>
                      {d.total > 0 ? `${((d.completed / d.total) * 100).toFixed(0)}%` : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Transactions */}
      <h3 className="text-lg font-semibold mb-3">Recent Transactions</h3>
      {data.recentTxns.length === 0 ? (
        <p className="text-zinc-500 text-sm">No transactions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-4">Tx Hash</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Block</th>
                <th className="pb-2 pr-4">Gas Used</th>
                <th className="pb-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {data.recentTxns.map((tx, i) => (
                <tr key={i} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-4 font-mono text-xs text-blue-400">
                    {tx.txHash.slice(0, 10)}...{tx.txHash.slice(-8)}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="px-2 py-0.5 rounded-full text-xs bg-green-500/10 text-green-400 border border-green-500/30">
                      {tx.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-zinc-500">{tx.blockNumber || "—"}</td>
                  <td className="py-2 pr-4 text-zinc-500">{tx.gasUsed || "—"}</td>
                  <td className="py-2 text-zinc-500 text-xs">{tx.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    green: "border-green-500/30 bg-green-500/5 text-green-400",
    red: "border-red-500/30 bg-red-500/5 text-red-400",
    yellow: "border-yellow-500/30 bg-yellow-500/5 text-yellow-400",
    blue: "border-blue-500/30 bg-blue-500/5 text-blue-400",
    purple: "border-purple-500/30 bg-purple-500/5 text-purple-400",
    orange: "border-orange-500/30 bg-orange-500/5 text-orange-400",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color] || colors.green}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm opacity-70">{label}</div>
    </div>
  );
}
