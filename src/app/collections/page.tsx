"use client";

import { useEffect, useState } from "react";

interface Collection {
  id: string;
  name: string;
  contractAddress: string;
  chainId: number;
  mintMethod: string;
  mintPrice: string | null;
  maxPerWallet: number | null;
  maxSupply: number | null;
  defaultGasLimit: string | null;
  defaultMaxFeePerGas: string | null;
  defaultMaxPriorityFeePerGas: string | null;
  defaultUseFlashbots: boolean;
  fcfsEnabled: boolean;
  fcfsMintOpenSignature: string | null;
  createdAt: string;
}

interface Chain {
  id: number;
  name: string;
}

interface FcfsStatus {
  collectionId: string;
  watching: boolean;
}

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
  const [fcfsStatus, setFcfsStatus] = useState<FcfsStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    contractAddress: "",
    chainId: 1,
    mintMethod: "mint",
    mintAbi: "",
    mintPrice: "",
    paymentToken: "",
    defaultGasLimit: "",
    defaultMaxFeePerGas: "",
    defaultMaxPriorityFeePerGas: "",
    defaultUseFlashbots: false,
    fcfsMintOpenSignature: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/collections").then((r) => r.json()),
      fetch("/api/chains").then((r) => r.json()),
      fetch("/api/fcfs").then((r) => r.json()),
    ]).then(([col, ch, fcs]) => {
      setCollections(col);
      setChains(ch);
      setFcfsStatus(fcs);
      setLoading(false);
    });
  };

  useEffect(() => { fetchData(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setShowForm(false);
      setForm({
        name: "", contractAddress: "", chainId: 1, mintMethod: "mint",
        mintAbi: "", mintPrice: "", paymentToken: "", defaultGasLimit: "",
        defaultMaxFeePerGas: "", defaultMaxPriorityFeePerGas: "",
        defaultUseFlashbots: false, fcfsMintOpenSignature: "",
      });
      fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this collection?")) return;
    await fetch(`/api/collections/${id}`, { method: "DELETE" });
    fetchData();
  };

  const toggleFcfs = async (id: string, enabled: boolean) => {
    await fetch("/api/fcfs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collectionId: id, action: enabled ? "start" : "stop" }),
    });
    fetchData();
  };

  const isWatching = (id: string) => fcfsStatus.some((s) => s.collectionId === id && s.watching);

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Collections</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {showForm ? "Cancel" : "+ Add Collection"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-8 p-4 bg-zinc-900 rounded-xl border border-zinc-800 space-y-4">
          <h3 className="font-semibold">Add NFT Collection</h3>
          {error && <div className="text-red-400 text-sm bg-red-500/10 p-2 rounded">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Collection Name</label>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm" placeholder="Bored Apes" required />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Chain</label>
              <select value={form.chainId} onChange={(e) => setForm({ ...form, chainId: parseInt(e.target.value) })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm">
                {chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Contract Address</label>
              <input type="text" value={form.contractAddress} onChange={(e) => setForm({ ...form, contractAddress: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono" placeholder="0x..." required />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Mint Function</label>
              <input type="text" value={form.mintMethod} onChange={(e) => setForm({ ...form, mintMethod: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm" placeholder="mint" />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Mint Price</label>
              <input type="text" value={form.mintPrice} onChange={(e) => setForm({ ...form, mintPrice: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm" placeholder="0.05" />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                Payment Token
                <span className="text-zinc-600 ml-2">ERC20 address (empty = native ETH)</span>
              </label>
              <input type="text" value={form.paymentToken} onChange={(e) => setForm({ ...form, paymentToken: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono" placeholder="0x... (optional)" />
            </div>
          </div>

          {/* ABI */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Mint ABI <span className="text-zinc-600">(JSON fragment)</span>
            </label>
            <textarea value={form.mintAbi} onChange={(e) => setForm({ ...form, mintAbi: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm font-mono h-24"
              placeholder='[{"type":"function","name":"mint","inputs":[{"type":"uint256","name":"quantity"}],"outputs":[],"stateMutability":"payable"}]' required />
          </div>

          {/* Advanced: Defaults */}
          <details className="text-sm">
            <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">▸ Collection Defaults (gas, Flashbots)</summary>
            <div className="mt-3 grid grid-cols-3 gap-3 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Default Gas Limit</label>
                <input type="text" value={form.defaultGasLimit} onChange={(e) => setForm({ ...form, defaultGasLimit: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm" placeholder="Auto" />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Default Max Fee (wei)</label>
                <input type="text" value={form.defaultMaxFeePerGas} onChange={(e) => setForm({ ...form, defaultMaxFeePerGas: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm" placeholder="Auto" />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Default Priority Fee</label>
                <input type="text" value={form.defaultMaxPriorityFeePerGas} onChange={(e) => setForm({ ...form, defaultMaxPriorityFeePerGas: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm" placeholder="Auto" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer col-span-3">
                <input type="checkbox" checked={form.defaultUseFlashbots} onChange={(e) => setForm({ ...form, defaultUseFlashbots: e.target.checked })}
                  className="accent-purple-500" />
                <span className="text-zinc-300">Default: Use Flashbots Protect</span>
              </label>
            </div>
          </details>

          {/* FCFS */}
          <details className="text-sm">
            <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">▸ FCFS (0-click auto-mint)</summary>
            <div className="mt-3 space-y-3 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Mint Open Event Signature
                  <span className="text-zinc-600 ml-2">e.g. MintOpen(uint256)</span>
                </label>
                <input type="text" value={form.fcfsMintOpenSignature}
                  onChange={(e) => setForm({ ...form, fcfsMintOpenSignature: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm font-mono"
                  placeholder="MintStarted()" />
              </div>
              <p className="text-xs text-zinc-600">
                When this event is emitted by the contract, the bot automatically mints with all active wallets on this chain.
                Leave blank to disable FCFS for this collection.
              </p>
            </div>
          </details>

          <button type="submit" disabled={submitting}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {submitting ? "Adding..." : "Add Collection"}
          </button>
        </form>
      )}

      {collections.length === 0 ? (
        <p className="text-zinc-500">No collections yet. Add one to start minting against it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Contract</th>
                <th className="pb-2 pr-4">Chain</th>
                <th className="pb-2 pr-4">Method</th>
                <th className="pb-2 pr-4">Price</th>
                <th className="pb-2 pr-4">FCFS</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr key={c.id} className="border-b border-zinc-800/50">
                  <td className="py-2 pr-4 font-medium">
                    {c.name}
                    {c.defaultUseFlashbots && <span className="ml-1 text-[10px] text-purple-400">FB</span>}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-400">
                    {c.contractAddress.slice(0, 6)}...{c.contractAddress.slice(-4)}
                  </td>
                  <td className="py-2 pr-4">{chains.find((ch) => ch.id === c.chainId)?.name || `Chain ${c.chainId}`}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-zinc-500">{c.mintMethod}</td>
                  <td className="py-2 pr-4">{c.mintPrice ? `${c.mintPrice} ETH` : "—"}</td>
                  <td className="py-2 pr-4">
                    {c.fcfsMintOpenSignature ? (
                      <button
                        onClick={() => toggleFcfs(c.id, !isWatching(c.id))}
                        className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                          isWatching(c.id)
                            ? "bg-green-500/10 text-green-400 border-green-500/30"
                            : "bg-zinc-500/10 text-zinc-400 border-zinc-500/30 hover:border-green-500/30"
                        }`}
                      >
                        {isWatching(c.id) ? "👁️ Live" : "▶ Start"}
                      </button>
                    ) : (
                      <span className="text-zinc-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    <button onClick={() => handleDelete(c.id)} className="text-red-400 hover:text-red-300 text-xs">Delete</button>
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
