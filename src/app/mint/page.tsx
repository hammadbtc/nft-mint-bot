"use client";

import { useEffect, useState } from "react";

interface Wallet {
  id: string;
  label: string;
  address: string;
  chainId: number;
}

interface Collection {
  id: string;
  name: string;
  contractAddress: string;
  chainId: number;
  mintPrice: string | null;
}

export default function BatchMintPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState("");
  const [selectedWalletIds, setSelectedWalletIds] = useState<Set<string>>(new Set());
  const [quantity, setQuantity] = useState(1);
  const [minting, setMinting] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState("");

  // Gas controls
  const [useFlashbots, setUseFlashbots] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [gasLimit, setGasLimit] = useState("");
  const [maxFeePerGas, setMaxFeePerGas] = useState("");
  const [maxPriorityFeePerGas, setMaxPriorityFeePerGas] = useState("");

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      fetch("/api/wallets").then((r) => r.json()),
      fetch("/api/collections").then((r) => r.json()),
    ]).then(([w, c]) => {
      setWallets(w);
      setCollections(c);
      setLoading(false);
    });
  };

  useEffect(() => { fetchData(); }, []);

  const selectedCol = collections.find((c) => c.id === selectedCollection);
  const compatibleWallets = selectedCol
    ? wallets.filter((w) => w.chainId === selectedCol.chainId)
    : wallets;

  const toggleWallet = (id: string) => {
    const next = new Set(selectedWalletIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedWalletIds(next);
  };

  const selectAll = () => {
    if (selectedWalletIds.size === compatibleWallets.length) {
      setSelectedWalletIds(new Set());
    } else {
      setSelectedWalletIds(new Set(compatibleWallets.map((w) => w.id)));
    }
  };

  const handleMint = async () => {
    if (!selectedCollection || selectedWalletIds.size === 0) {
      setError("Select a collection and at least one wallet");
      return;
    }
    setMinting(true);
    setError("");
    setResults(null);

    try {
      const res = await fetch("/api/jobs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionId: selectedCollection,
          walletIds: Array.from(selectedWalletIds),
          quantity,
          useFlashbots,
          dryRun,
          gasLimit: gasLimit || undefined,
          maxFeePerGas: maxFeePerGas || undefined,
          maxPriorityFeePerGas: maxPriorityFeePerGas || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResults(data.results);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setMinting(false);
    }
  };

  if (loading) return <div className="text-zinc-400 animate-pulse">Loading...</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Batch Mint</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-8 mb-8">
        {/* Left: Selection */}
        <div className="space-y-6">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Collection</label>
            <select
              value={selectedCollection}
              onChange={(e) => {
                setSelectedCollection(e.target.value);
                setSelectedWalletIds(new Set());
              }}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
            >
              <option value="">Select collection...</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.contractAddress.slice(0, 6)}...) — {c.mintPrice ? `${c.mintPrice} ETH` : "Free"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1">Quantity per wallet</label>
            <input
              type="number"
              min={1}
              max={100}
              value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm"
            />
          </div>

          {/* Flashbots & Dry Run toggles */}
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useFlashbots}
                onChange={(e) => setUseFlashbots(e.target.checked)}
                className="accent-purple-500"
              />
              <span className="text-sm text-zinc-300">🛡️ Flashbots Protect</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="accent-yellow-500"
              />
              <span className="text-sm text-zinc-300">🔬 Dry Run (simulate only)</span>
            </label>
          </div>

          {/* Advanced gas controls */}
          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              {showAdvanced ? "▾ Hide" : "▸ Show"} Advanced Gas Settings
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 p-3 bg-zinc-900 rounded-lg border border-zinc-800">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Gas Limit (override)</label>
                  <input
                    type="text"
                    value={gasLimit}
                    onChange={(e) => setGasLimit(e.target.value)}
                    placeholder="Auto-estimate"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Max Fee Per Gas (wei)</label>
                  <input
                    type="text"
                    value={maxFeePerGas}
                    onChange={(e) => setMaxFeePerGas(e.target.value)}
                    placeholder="Auto"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Max Priority Fee (wei)</label>
                  <input
                    type="text"
                    value={maxPriorityFeePerGas}
                    onChange={(e) => setMaxPriorityFeePerGas(e.target.value)}
                    placeholder="Auto"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-white text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Wallet selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-zinc-400">
                Wallets ({compatibleWallets.length} compatible)
              </label>
              <button onClick={selectAll} className="text-xs text-emerald-400 hover:text-emerald-300">
                {selectedWalletIds.size === compatibleWallets.length ? "Deselect All" : "Select All"}
              </button>
            </div>

            {compatibleWallets.length === 0 ? (
              <p className="text-zinc-500 text-sm">
                {selectedCol ? "No wallets on this chain. Add wallets first." : "Select a collection to see compatible wallets."}
              </p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {compatibleWallets.map((w) => (
                  <label
                    key={w.id}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedWalletIds.has(w.id)}
                      onChange={() => toggleWallet(w.id)}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm font-medium">{w.label}</span>
                    <span className="text-xs text-zinc-500 font-mono">
                      {w.address.slice(0, 6)}...{w.address.slice(-4)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={handleMint}
            disabled={minting || !selectedCollection || selectedWalletIds.size === 0}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
          >
            {minting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="animate-spin">⏳</span> {dryRun ? "Simulating..." : "Minting..."}
              </span>
            ) : (
              `${dryRun ? "🔬 Simulate" : "🚀 Mint"} with ${selectedWalletIds.size} wallet${selectedWalletIds.size !== 1 ? "s" : ""}`
            )}
          </button>
        </div>

        {/* Right: Results */}
        <div>
          <h3 className="text-lg font-semibold mb-3">Results{dryRun && results ? " (Dry Run)" : ""}</h3>
          {results === null ? (
            <p className="text-zinc-500 text-sm">Results will appear here after minting.</p>
          ) : results.length === 0 ? (
            <p className="text-zinc-500 text-sm">No results.</p>
          ) : (
            <div className="space-y-2">
              {results.map((r: any, i: number) => (
                <div
                  key={i}
                  className={`p-3 rounded-lg border text-sm ${
                    r.status === "completed"
                      ? "bg-green-500/5 border-green-500/30"
                      : "bg-red-500/5 border-red-500/30"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-zinc-400">
                      {r.walletId.slice(0, 8)}...
                    </span>
                    <span className={r.status === "completed" ? "text-green-400" : "text-red-400"}>
                      {r.status}
                    </span>
                  </div>
                  {r.txHash && (
                    <div className="mt-1 text-xs text-zinc-500">
                      TX: <a href={`https://etherscan.io/tx/${r.txHash}`} target="_blank" className="text-blue-400 hover:underline">{r.txHash.slice(0, 10)}...{r.txHash.slice(-8)}</a>
                    </div>
                  )}
                  {r.error && (
                    <div className="mt-1 text-xs text-red-400 truncate">{r.error}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
