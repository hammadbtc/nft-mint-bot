"use client";

import { useEffect, useState } from "react";

interface Wallet {
  id: string;
  label: string;
  address: string;
  chainId: number;
  keyFormat: string;
  active: boolean;
  createdAt: string;
}

interface Chain {
  id: number;
  name: string;
  symbol: string;
}

interface DerivedAddress {
  index: number;
  path: string;
  address: string;
}

export default function WalletsPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    label: "",
    chainId: 1,
    keyType: "private-key" as "private-key" | "mnemonic",
    key: "",
    hdPath: "m/44'/60'/0'/0/0",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [derivedAddresses, setDerivedAddresses] = useState<DerivedAddress[]>([]);
  const [deriving, setDeriving] = useState(false);
  const [selectedDerivedIndex, setSelectedDerivedIndex] = useState<number | null>(null);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/wallets").then((r) => r.json()),
      fetch("/api/chains").then((r) => r.json()),
    ]).then(([w, c]) => {
      setWallets(w);
      setChains(c);
      setLoading(false);
    });
  };

  useEffect(() => { fetchData(); }, []);

  // Derive addresses when mnemonic changes
  const handlePreviewMnemonic = async () => {
    if (form.keyType !== "mnemonic" || !form.key.trim()) return;
    setDeriving(true);
    try {
      const res = await fetch("/api/wallets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mnemonic: form.key,
          count: 10,
          basePath: form.hdPath.replace(/\/\d+$/, ""), // strip trailing index
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDerivedAddresses(data);
        setSelectedDerivedIndex(0); // default to first
      }
    } catch {}
    setDeriving(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      // If mnemonic with selected index, use that HD path
      const hdPath = form.keyType === "mnemonic" && selectedDerivedIndex !== null
        ? `${form.hdPath.replace(/\/\d+$/, "")}/${selectedDerivedIndex}`
        : form.hdPath;

      const res = await fetch("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, hdPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowForm(false);
      setForm({ label: "", chainId: 1, keyType: "private-key", key: "", hdPath: "m/44'/60'/0'/0/0" });
      setDerivedAddresses([]);
      setSelectedDerivedIndex(null);
      fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this wallet? This cannot be undone.")) return;
    await fetch(`/api/wallets/${id}`, { method: "DELETE" });
    fetchData();
  };

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Wallets</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {showForm ? "Cancel" : "+ Add Wallet"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-8 p-4 bg-zinc-900 rounded-xl border border-zinc-800 space-y-4">
          <h3 className="font-semibold">Import Wallet</h3>
          {error && <div className="text-red-400 text-sm bg-red-500/10 p-2 rounded">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Label</label>
              <input
                type="text"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="My Mint Wallet"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Chain</label>
              <select
                value={form.chainId}
                onChange={(e) => setForm({ ...form, chainId: parseInt(e.target.value) })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
              >
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Key Type</label>
              <select
                value={form.keyType}
                onChange={(e) => {
                  setForm({ ...form, keyType: e.target.value as any });
                  setDerivedAddresses([]);
                  setSelectedDerivedIndex(null);
                }}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
              >
                <option value="private-key">Private Key</option>
                <option value="mnemonic">Mnemonic (Seed Phrase)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                {form.keyType === "mnemonic" ? "Seed Phrase" : "Private Key"}
              </label>
              <input
                type="password"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                onBlur={handlePreviewMnemonic}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                placeholder={form.keyType === "mnemonic" ? "word1 word2 word3 ... (12-24 words)" : "0x..."}
                required
              />
            </div>

            {/* HD Path */}
            {form.keyType === "mnemonic" && (
              <div className="col-span-2">
                <label className="block text-sm text-zinc-400 mb-1">
                  Derivation Path
                  <span className="text-zinc-600 ml-2">(BIP44 standard)</span>
                </label>
                <input
                  type="text"
                  value={form.hdPath}
                  onChange={(e) => setForm({ ...form, hdPath: e.target.value })}
                  onBlur={handlePreviewMnemonic}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                />
              </div>
            )}
          </div>

          {/* Derived addresses preview */}
          {form.keyType === "mnemonic" && derivedAddresses.length > 0 && (
            <div>
              <label className="block text-sm text-zinc-400 mb-2">
                Derived Addresses <span className="text-zinc-600">({deriving ? "loading..." : `select one to import`})</span>
              </label>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {derivedAddresses.map((d) => (
                  <button
                    key={d.index}
                    type="button"
                    onClick={() => setSelectedDerivedIndex(d.index)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-mono transition-colors ${
                      selectedDerivedIndex === d.index
                        ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400"
                        : "bg-zinc-800/50 hover:bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    <span className="text-zinc-500 mr-2">#{d.index}</span>
                    {d.address}
                    <span className="text-zinc-600 text-xs ml-2">{d.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
          >
            {submitting ? "Importing..." : `Import Wallet${selectedDerivedIndex !== null ? ` (#${selectedDerivedIndex})` : ""}`}
          </button>
        </form>
      )}

      {wallets.length === 0 ? (
        <p className="text-zinc-500">No wallets yet. Add one to start minting.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-4">Label</th>
                <th className="pb-2 pr-4">Address</th>
                <th className="pb-2 pr-4">Chain</th>
                <th className="pb-2 pr-4">Type</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.id} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-4 font-medium">{w.label}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400">
                    {w.address.slice(0, 6)}...{w.address.slice(-4)}
                  </td>
                  <td className="py-2 pr-4">
                    {chains.find((c) => c.id === w.chainId)?.name || `Chain ${w.chainId}`}
                  </td>
                  <td className="py-2 pr-4 text-zinc-500">{w.keyFormat}</td>
                  <td className="py-2">
                    <button
                      onClick={() => handleDelete(w.id)}
                      className="text-red-400 hover:text-red-300 text-xs"
                    >
                      Delete
                    </button>
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
