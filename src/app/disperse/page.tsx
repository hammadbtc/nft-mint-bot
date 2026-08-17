"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

type Wallet = { id:string; label:string; address:string; role:"main"|"worker"; parentWalletId:string|null; active:boolean };
type Chain = { id:number; name:string; symbol:string; explorerUrl?:string };
type Preview = { version:2; type:"fund"|"sweep"; mainWalletId:string; workerWalletIds:string[]; chainId:number; transfers:Array<{fromWalletId:string;toWalletId:string;amountWei:string;gasLimit:string;maxFeePerGas:string;maxPriorityFeePerGas:string|null}>; estimatedGasWei:string; totalRequiredWei:string; generatedAt:string; expiresAt:string; fingerprint:string };
type Transfer = { id:string; fromWalletId:string; toWalletId:string; amount:string; status:string; nonce:number|null; txHash:string|null; error:string|null; gasUsed:string|null; effectiveGasPrice:string|null; blockNumber:number|null; createdAt:string; preparedAt:string|null; broadcastAt:string|null; confirmedAt:string|null };
type Operation = { id:string; type:"fund"|"sweep"; mainWalletId:string; chainId:number; status:string; amountPerWallet:string|null; error:string|null; createdAt:string; updatedAt:string; completedAt:string|null; transfers:Transfer[] };

const inFlightStatuses = new Set(["pending", "running", "prepared", "submitted", "confirming"]);
const short = (value:string) => `${value.slice(0,7)}…${value.slice(-5)}`;

export default function DispersePage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [chainId, setChainId] = useState(0);
  const [main, setMain] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"fund"|"sweep">("fund");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview|null>(null);
  const [busy, setBusy] = useState(false);
  const [mainBalanceWei, setMainBalanceWei] = useState<string|null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState("");

  const loadOperations = useCallback(async () => {
    try {
      const response = await fetch("/api/disperse?limit=50", { cache:"no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load Disperse operations");
      setOperations(Array.isArray(data) ? data : []);
      setHistoryError("");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load Disperse operations");
    }
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/wallets").then((response) => response.json()),
      fetch("/api/chains").then((response) => response.json()),
    ]).then(([walletData, chainData]) => {
      setWallets(Array.isArray(walletData) ? walletData : []);
      setChains(Array.isArray(chainData) ? chainData : []);
    }).catch(() => undefined);
    queueMicrotask(() => void loadOperations());
  }, [loadOperations]);

  useEffect(() => {
    const active = operations.some((operation) => inFlightStatuses.has(operation.status));
    const timer = setTimeout(() => void loadOperations(), active ? 1_000 : 5_000);
    return () => clearTimeout(timer);
  }, [operations, loadOperations]);

  useEffect(() => {
    if (!chainId || !main) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) setBalanceLoading(true); });
    fetch(`/api/wallets/${main}?chainId=${chainId}`, { cache:"no-store", signal:controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load wallet balance");
        setMainBalanceWei(String(data.balanceWei));
      })
      .catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) setBalanceError(error instanceof Error ? error.message : "Could not load wallet balance"); })
      .finally(() => { if (!controller.signal.aborted) setBalanceLoading(false); });
    return () => controller.abort();
  }, [chainId, main]);

  const mains = wallets.filter((wallet) => wallet.role === "main" && wallet.active);
  const workers = useMemo(() => wallets.filter((wallet) => wallet.role === "worker" && wallet.active && wallet.parentWalletId === main), [wallets, main]);
  const walletById = useMemo(() => new Map(wallets.map((wallet) => [wallet.id, wallet])), [wallets]);
  const chainById = useMemo(() => new Map(chains.map((chain) => [chain.id, chain])), [chains]);
  const clearBalance = () => { setMainBalanceWei(null); setBalanceError(""); setBalanceLoading(false); };
  const toggle = (id:string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPreview(null);
    return next;
  });
  const payload = () => ({ type, mainWalletId:main, workerWalletIds:[...selected], chainId, amountPerWallet:type === "fund" ? amount : undefined });
  const requestPreview = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/disperse", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"preview", ...payload()}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setPreview(data);
    } catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : "Could not preview"); }
    finally { setBusy(false); }
  };
  const execute = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const response = await fetch("/api/disperse", { method:"POST", headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()}, body:JSON.stringify({action:"execute", ...payload(), expected:preview}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(`Operation ${data.operationId} queued. Live status is shown below.`);
      setPreview(null);
      await loadOperations();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not execute"); }
    finally { setBusy(false); }
  };

  const selectedChain = chains.find((chain)=>chain.id === chainId);
  const displayBalance = mainBalanceWei == null ? "—" : `${Number(ethers.formatEther(mainBalanceWei)).toLocaleString(undefined, { maximumFractionDigits:6 })} ${selectedChain?.symbol || "native"}`;
  return <>
    <div className="page-heading"><div><h1>Disperse</h1><p>Fund and sweep with live per-transfer status, errors and transaction hashes.</p></div></div>
    <div className="panel disperse-grid">
      <div className="form-grid">
        <div className="segmented"><button className={type === "fund" ? "active" : ""} onClick={()=>{setType("fund");setPreview(null)}}>Fund workers</button><button className={type === "sweep" ? "active" : ""} onClick={()=>{setType("sweep");setPreview(null)}}>Sweep to main</button></div>
        <div className="field"><label>Network (required)</label><select value={chainId || ""} onChange={(event)=>{setChainId(Number(event.target.value));setSelected(new Set());setPreview(null);clearBalance()}}><option value="">Choose network</option>{chains.map((chain)=><option key={chain.id} value={chain.id}>{chain.name}</option>)}</select></div>
        <div className="field"><label>Main wallet</label><select disabled={!chainId} value={main} onChange={(event)=>{setMain(event.target.value);setSelected(new Set());setPreview(null);clearBalance()}}><option value="">{chainId ? "Choose main wallet" : "Choose network first"}</option>{mains.map((wallet)=><option key={wallet.id} value={wallet.id}>{wallet.label}</option>)}</select></div>
        {main && chainId > 0 && <div className="alert">Available on {selectedChain?.name || `Chain ${chainId}`}: <strong>{balanceLoading ? "Loading…" : balanceError || displayBalance}</strong></div>}
        <div className="field"><label>Workers ({selected.size} selected)</label><div className="wallet-picker">{workers.length ? workers.map((wallet)=><label className="wallet-option" key={wallet.id}><input type="checkbox" checked={selected.has(wallet.id)} onChange={()=>toggle(wallet.id)}/><span>{wallet.label}</span><small>{short(wallet.address)}</small></label>) : <div className="wallet-option muted">Choose a main wallet with workers</div>}</div></div>
        {type === "fund" && <div className="field"><label>Amount per worker</label><input value={amount} onChange={(event)=>{setAmount(event.target.value);setPreview(null)}} inputMode="decimal" placeholder="0.01"/></div>}
      </div>
      <div className="form-grid">
        <div className="summary-box"><div className="summary-line"><span>Network</span><b>{selectedChain?.name || "Not selected"}</b></div><div className="summary-line"><span>Main balance</span><b>{balanceLoading ? "Loading…" : balanceError || displayBalance}</b></div><div className="summary-line"><span>Direction</span><b>{type === "fund" ? "Main → workers" : "Workers → main"}</b></div><div className="summary-line"><span>Workers</span><b>{selected.size}</b></div><div className="summary-line"><span>Transfers</span><b>{preview?.transfers.length || 0}</b></div><div className="summary-line"><span>{type === "fund" ? "Maximum required" : "Estimated return"}</span><b>{preview ? ethers.formatEther(preview.totalRequiredWei) : "—"}</b></div><div className="summary-line"><span>Maximum network fee</span><b>{preview ? ethers.formatEther(preview.estimatedGasWei) : "—"}</b></div></div>
        {message && <div className="alert">{message}</div>}
        {!preview ? <button className="primary-btn" disabled={busy || !chainId || !main || balanceLoading || Boolean(balanceError) || !selected.size || (type === "fund" && !amount)} onClick={requestPreview}>{busy ? "Checking balances & fees…" : "Review disperse →"}</button> : <><div className="alert">Review complete. The chain, amount and 3× fee ceiling are locked for 60 seconds. Actual gas may be lower.</div><button className="primary-btn" disabled={busy} onClick={execute}>{busy ? "Submitting…" : type === "fund" ? "Confirm & fund workers" : "Confirm & sweep to main"}</button></>}
      </div>
    </div>

    <section className="scheduled">
      <div className="section-title"><h2>Disperse operations</h2><span className="muted" style={{fontSize:12}}>Auto-refreshing</span></div>
      {historyError && <div className="alert" style={{color:"var(--danger)"}}>{historyError}</div>}
      {!operations.length && !historyError && <div className="panel empty"><div><h2>No operations yet</h2><p>Queued funding and sweeps will appear here immediately.</p></div></div>}
      {operations.map((operation) => {
        const chain = chainById.get(operation.chainId);
        const confirmed = operation.transfers.filter((transfer) => transfer.status === "confirmed").length;
        const failed = operation.transfers.filter((transfer) => transfer.status === "failed").length;
        return <div className="panel job" key={operation.id} style={{marginBottom:12}}>
          <div className="job-summary" style={{cursor:"default"}}><div className="job-art"/><div className="job-main"><b>{operation.type === "fund" ? "Fund workers" : "Sweep to main"} · {chain?.name || `Chain ${operation.chainId}`}</b><span>{operation.transfers.length} transfers · {confirmed} confirmed{failed ? ` · ${failed} failed` : ""} · {new Date(operation.createdAt).toLocaleString()}</span></div><span className="status">{operation.status}</span></div>
          <div className="result-panel"><table className="result-table"><thead><tr><th>Status</th><th>Route</th><th>Amount</th><th>Result</th></tr></thead><tbody>{operation.transfers.map((transfer) => {
            const from = walletById.get(transfer.fromWalletId);
            const to = walletById.get(transfer.toWalletId);
            const href = transfer.txHash && chain?.explorerUrl ? `${chain.explorerUrl}/tx/${transfer.txHash}` : null;
            const result = transfer.error || (transfer.txHash ? `Tx ${short(transfer.txHash)}${transfer.blockNumber ? ` · block ${transfer.blockNumber}` : ""}` : transfer.status === "pending" ? "Waiting for worker" : "No broadcast");
            return <tr key={transfer.id}><td className={transfer.status === "failed" ? "failed" : transfer.status === "confirmed" ? "ok" : ""}>{transfer.status}</td><td>{from?.label || short(transfer.fromWalletId)} → {to?.label || short(transfer.toWalletId)}</td><td>{ethers.formatEther(transfer.amount)} {chain?.symbol || "native"}</td><td>{href ? <a href={href} target="_blank" rel="noreferrer">{result}</a> : result}</td></tr>;
          })}</tbody></table>{operation.error && <div className="alert" style={{margin:12,color:"var(--danger)"}}>{operation.error}</div>}</div>
        </div>;
      })}
    </section>
  </>;
}
