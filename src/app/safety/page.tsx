"use client";

import { useEffect, useState } from "react";

interface SafetyEntry {
  address: string;
  list: string;
  note: string | null;
  addedAt: string;
}

export default function SafetyPage() {
  const [entries, setEntries] = useState<SafetyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState({ address: "", list: "blacklist" as "whitelist" | "blacklist", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const fetchEntries = () => {
    setLoading(true);
    const url = filter ? `/api/safety?list=${filter}` : "/api/safety";
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        setEntries(data);
        setLoading(false);
      });
  };

  useEffect(() => { fetchEntries(); }, [filter]);

  const addEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      const res = await fetch("/api/safety", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setMessage("✅ Added");
        setForm({ address: "", list: "blacklist", note: "" });
        fetchEntries();
      } else {
        const data = await res.json();
        setMessage(`❌ ${data.error}`);
      }
    } catch {
      setMessage("❌ Failed");
    }
    setSubmitting(false);
  };

  const removeEntry = async (address: string) => {
    await fetch(`/api/safety?address=${address}`, { method: "DELETE" });
    fetchEntries();
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Contract Safety</h2>
      <p className="text-sm text-zinc-400 mb-6">
        Whitelist trusted contracts to bypass safety scans. Blacklist known scams to block all mints.
      </p>

      {/* Add form */}
      <form onSubmit={addEntry} className="mb-8 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 items-end">
          <div className="lg:col-span-2">
            <label className="block text-sm text-zinc-400 mb-1">Contract Address</label>
            <input
              type="text"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
              placeholder="0x..."
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">List</label>
            <select
              value={form.list}
              onChange={(e) => setForm({ ...form, list: e.target.value as any })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
            >
              <option value="blacklist">Blacklist</option>
              <option value="whitelist">Whitelist</option>
            </select>
          </div>
          <div className="hidden lg:block">
            <label className="block text-sm text-zinc-400 mb-1">Note</label>
            <input
              type="text"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="flex items-center gap-4 mt-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
          >
            {submitting ? "Adding..." : `+ Add to ${form.list}`}
          </button>
          {message && <span className={`text-sm ${message.startsWith("✅") ? "text-green-400" : "text-red-400"}`}>{message}</span>}
        </div>
      </form>

      {/* Filter */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => setFilter("")} className={`px-3 py-1 rounded text-xs ${!filter ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}>All</button>
        <button onClick={() => setFilter("blacklist")} className={`px-3 py-1 rounded text-xs ${filter === "blacklist" ? "bg-red-500/20 text-red-400" : "text-zinc-400 hover:text-white"}`}>Blacklist</button>
        <button onClick={() => setFilter("whitelist")} className={`px-3 py-1 rounded text-xs ${filter === "whitelist" ? "bg-green-500/20 text-green-400" : "text-zinc-400 hover:text-white"}`}>Whitelist</button>
      </div>

      {loading ? (
        <div className="text-zinc-400 animate-pulse">Loading...</div>
      ) : entries.length === 0 ? (
        <p className="text-zinc-500 text-sm">No entries. Add contracts above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-4">Address</th>
                <th className="pb-2 pr-4">List</th>
                <th className="pb-2 pr-4 hidden lg:table-cell">Note</th>
                <th className="pb-2 pr-4 hidden lg:table-cell">Added</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.address} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400">
                    {e.address.slice(0, 10)}...{e.address.slice(-6)}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs border ${
                      e.list === "whitelist"
                        ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : "bg-red-500/10 text-red-400 border-red-500/30"
                    }`}>
                      {e.list}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-zinc-500 hidden lg:table-cell">{e.note || "—"}</td>
                  <td className="py-2 pr-4 text-zinc-500 text-xs hidden lg:table-cell">{e.addedAt}</td>
                  <td className="py-2">
                    <button onClick={() => removeEntry(e.address)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
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
