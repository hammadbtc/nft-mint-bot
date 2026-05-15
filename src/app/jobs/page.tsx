"use client";

import { useEffect, useState } from "react";

interface Job {
  id: string;
  walletId: string;
  collectionId: string;
  status: string;
  quantity: number;
  retryCount: number;
  maxRetries: number;
  useFlashbots: boolean;
  dryRun: boolean;
  error: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  const fetchJobs = () => {
    setLoading(true);
    const url = filter ? `/api/jobs?status=${filter}` : "/api/jobs";
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        setJobs(data);
        setLoading(false);
      });
  };

  useEffect(() => { fetchJobs(); }, [filter]);
  useEffect(() => {
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, [filter]);

  const handleAction = async (id: string, action: "retry" | "cancel" | "unstuck" | "speedup") => {
    await fetch(`/api/jobs/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    fetchJobs();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Jobs</h2>
        <div className="flex gap-3">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
          >
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            onClick={fetchJobs}
            className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-400 hover:text-white"
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="text-zinc-400 animate-pulse">Loading...</div>
      ) : jobs.length === 0 ? (
        <p className="text-zinc-500">No jobs found. Create one from the Batch Mint page.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-3">Job ID</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Flags</th>
                <th className="pb-2 pr-3">Qty</th>
                <th className="pb-2 pr-3">Retries</th>
                <th className="pb-2 pr-3">Created</th>
                <th className="pb-2 pr-3">Error</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-3 font-mono text-xs text-zinc-400">
                    {job.id.slice(0, 8)}...
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-1">
                      {job.useFlashbots && <span className="px-1.5 py-0.5 text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30 rounded">FB</span>}
                      {job.dryRun && <span className="px-1.5 py-0.5 text-[10px] bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 rounded">DRY</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{job.quantity}</td>
                  <td className="py-2 pr-3 text-zinc-500">
                    {job.retryCount}/{job.maxRetries}
                  </td>
                  <td className="py-2 pr-3 text-zinc-500 text-xs">{job.createdAt}</td>
                  <td className="py-2 pr-3 text-red-400 text-xs max-w-[120px] truncate">
                    {job.error || "—"}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-1.5 flex-wrap">
                      {job.status === "failed" && (
                        <button
                          onClick={() => handleAction(job.id, "retry")}
                          className="text-emerald-400 hover:text-emerald-300 text-xs"
                        >
                          Retry
                        </button>
                      )}
                      {(job.status === "pending" || job.status === "running") && (
                        <>
                          <button
                            onClick={() => handleAction(job.id, "cancel")}
                            className="text-yellow-400 hover:text-yellow-300 text-xs"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleAction(job.id, "unstuck")}
                            className="text-orange-400 hover:text-orange-300 text-xs"
                          >
                            Unstuck
                          </button>
                        </>
                      )}
                      {(job.status === "failed") && (
                        <button
                          onClick={() => handleAction(job.id, "speedup")}
                          className="text-blue-400 hover:text-blue-300 text-xs"
                        >
                          Speed↑
                        </button>
                      )}
                    </div>
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
