"use client";

import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

type Wallet = { id:string; label:string; address:string; role:"main"|"worker"; parentWalletId:string|null; active:boolean };
type Chain = { id:number; name:string; symbol:string };
type Preview = { version:2; type:"fund"|"sweep"; mainWalletId:string; workerWalletIds:string[]; chainId:number; transfers:Array<{fromWalletId:string;toWalletId:string;amountWei:string;gasLimit:string;maxFeePerGas:string;maxPriorityFeePerGas:string|null}>; estimatedGasWei:string; totalRequiredWei:string; generatedAt:string; expiresAt:string; fingerprint:string };

export default function DispersePage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
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

  useEffect(() => {
    Promise.all([fetch("/api/wallets").then((response) => response.json()), fetch("/api/chains").then((response) => response.json())])
      .then(([walletData, chainData]) => {
        setWallets(Array.isArray(walletData) ? walletData : []);
        const activeChains = Array.isArray(chainData) ? chainData : [];
        setChains(activeChains);
      }).catch(() => undefined);
  }, []);

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
      setMessage(`Operation queued safely: ${data.operationId}. It will wait if broadcasting is locked.`); setPreview(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not execute"); }
    finally { setBusy(false); }
  };

  const selectedChain = chains.find((chain)=>chain.id === chainId);
  const displayBalance = mainBalanceWei == null ? "—" : `${Number(ethers.formatEther(mainBalanceWei)).toLocaleString(undefined, { maximumFractionDigits:6 })} ${selectedChain?.symbol || "native"}`;
  return <><div className="page-heading"><div><h1>Disperse</h1><p>Choose the network explicitly, then review balances before funding or sweeping.</p></div></div><div className="panel disperse-grid"><div className="form-grid"><div className="segmented"><button className={type === "fund" ? "active" : ""} onClick={()=>{setType("fund");setPreview(null)}}>Fund workers</button><button className={type === "sweep" ? "active" : ""} onClick={()=>{setType("sweep");setPreview(null)}}>Sweep to main</button></div><div className="field"><label>Network (required)</label><select value={chainId || ""} onChange={(event)=>{setChainId(Number(event.target.value));setSelected(new Set());setPreview(null);clearBalance()}}><option value="">Choose network</option>{chains.map((chain)=><option key={chain.id} value={chain.id}>{chain.name}</option>)}</select></div><div className="field"><label>Main wallet</label><select disabled={!chainId} value={main} onChange={(event)=>{setMain(event.target.value);setSelected(new Set());setPreview(null);clearBalance()}}><option value="">{chainId ? "Choose main wallet" : "Choose network first"}</option>{mains.map((wallet)=><option key={wallet.id} value={wallet.id}>{wallet.label}</option>)}</select></div>{main && chainId > 0 && <div className="alert">Available on {selectedChain?.name || `Chain ${chainId}`}: <strong>{balanceLoading ? "Loading…" : balanceError || displayBalance}</strong></div>}<div className="field"><label>Workers ({selected.size} selected)</label><div className="wallet-picker">{workers.length ? workers.map((wallet)=><label className="wallet-option" key={wallet.id}><input type="checkbox" checked={selected.has(wallet.id)} onChange={()=>toggle(wallet.id)}/><span>{wallet.label}</span><small>{wallet.address.slice(0,7)}…{wallet.address.slice(-5)}</small></label>) : <div className="wallet-option muted">Choose a main wallet with workers</div>}</div></div>{type === "fund" && <div className="field"><label>Amount per worker</label><input value={amount} onChange={(event)=>{setAmount(event.target.value);setPreview(null)}} inputMode="decimal" placeholder="0.01"/></div>}</div><div className="form-grid"><div className="summary-box"><div className="summary-line"><span>Network</span><b>{selectedChain?.name || "Not selected"}</b></div><div className="summary-line"><span>Main balance</span><b>{balanceLoading ? "Loading…" : balanceError || displayBalance}</b></div><div className="summary-line"><span>Direction</span><b>{type === "fund" ? "Main → workers" : "Workers → main"}</b></div><div className="summary-line"><span>Workers</span><b>{selected.size}</b></div><div className="summary-line"><span>Transfers</span><b>{preview?.transfers.length || 0}</b></div><div className="summary-line"><span>{type === "fund" ? "Total required" : "Estimated return"}</span><b>{preview ? ethers.formatEther(preview.totalRequiredWei) : "—"}</b></div><div className="summary-line"><span>Estimated network fee</span><b>{preview ? ethers.formatEther(preview.estimatedGasWei) : "—"}</b></div></div>{message && <div className="alert">{message}</div>}{!preview ? <button className="primary-btn" disabled={busy || !chainId || !main || balanceLoading || Boolean(balanceError) || !selected.size || (type === "fund" && !amount)} onClick={requestPreview}>{busy ? "Checking balances & fees…" : "Review disperse →"}</button> : <><div className="alert">Review complete. The chain, amount and fee ceiling are locked for 60 seconds.</div><button className="primary-btn" disabled={busy} onClick={execute}>{busy ? "Submitting…" : type === "fund" ? "Confirm & fund workers" : "Confirm & sweep to main"}</button></>}</div></div></>;
}
