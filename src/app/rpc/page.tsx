"use client";

import { useEffect, useState } from "react";

interface RpcEndpoint {
  url: string;
  status: string;
  latencyMs: number | null;
}

interface RpcHealth {
  [chainId: number]: {
    name: string;
    endpoints: RpcEndpoint[];
  };
}

export default function RpcHealthPage() {
  const [health, setHealth] = useState<RpcHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  const fetchHealth = () => {
    setLoading(true);
    fetch("/api/rpc-health")
      .then((r) => r.json())
      .then((data) => {
        setHealth(data);
        setLoading(false);
      });
  };

  useEffect(() => { fetchHealth(); }, []);

  const runCheck = () => {
    setChecking(true);
    fetch("/api/rpc-health")
      .then((r) => r.json())
      .then((data) => {
        setHealth(data);
        setChecking(false);
      });
  };

  const statusColor = (status: string) =>
    status === "up" ? "text-green-400" : status === "down" ? "text-red-400" : "text-yellow-400";

  const statusDot = (status: string) =>
    status === "up" ? "🟢" : status === "down" ? "🔴" : "🟡";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">RPC Health</h2>
        <button
          onClick={runCheck}
          disabled={checking}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {checking ? "Checking..." : "🔄 Check All"}
        </button>
      </div>

      {loading ? (
        <div className="text-zinc-400 animate-pulse">Loading...</div>
      ) : !health ? (
        <p className="text-zinc-500">Failed to load RPC health data.</p>
      ) : (
        <div className="space-y-6">
          {Object.entries(health).map(([chainId, chainData]) => (
            <div key={chainId} className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
              <h3 className="text-lg font-semibold mb-3">
                {chainData.name}{" "}
                <span className="text-xs text-zinc-500">Chain ID: {chainId}</span>
              </h3>
              <div className="space-y-2">
                {chainData.endpoints.map((ep: RpcEndpoint, i: number) => (
                  <div
                    key={i}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      ep.status === "up"
                        ? "bg-green-500/5 border border-green-500/20"
                        : "bg-red-500/5 border border-red-500/20"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={statusColor(ep.status)}>{statusDot(ep.status)}</span>
                      <div>
                        <span className={`text-xs font-mono ${statusColor(ep.status)}`}>
                          {ep.url}
                        </span>
                        {i === 0 && (
                          <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30 rounded">
                            PRIMARY
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-zinc-500">
                      {ep.latencyMs !== null ? `${ep.latencyMs}ms` : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
