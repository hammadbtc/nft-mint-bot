"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const COLLECTION_ID = "c00c1e20-7ba1-4663-9000-000000000005";
type Wallet = { id: string; label: string; address: string; role: "main" | "worker"; active: boolean };
type Attempt = { status: string; txHash?: string | null };
type Job = { id: string; collectionId: string; walletId: string; status: string; error?: string | null; attempts: Attempt[] };

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
async function json(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(String(data.error || "Request failed"));
  return data;
}

export default function CookiezQuickClaimPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [walletId, setWalletId] = useState("");
  const [target, setTarget] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const keyRef = useRef("");

  const load = async () => {
    const [walletData, jobData] = await Promise.all([
      fetch("/api/wallets?chainId=4663", { cache: "no-store" }).then(json),
      fetch("/api/jobs?limit=200", { cache: "no-store" }).then(json),
    ]);
    const active = (walletData as Wallet[]).filter((wallet) => wallet.active);
    setWallets(active);
    setWalletId((current) => current || active[0]?.id || "");
    setJobs((jobData as Job[]).filter((job) => job.collectionId === COLLECTION_ID));
  };

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void load().catch((error) => setMessage(error instanceof Error ? error.message : "Could not load COOKIEZ"));
    }, 0);
    const timer = setInterval(() => void load().catch(() => undefined), 2_000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  const selectedWallet = wallets.find((wallet) => wallet.id === walletId);
  const walletJobs = useMemo(() => jobs.filter((job) => job.walletId === walletId), [jobs, walletId]);
  const confirmed = walletJobs.filter((job) => job.status === "completed" && job.attempts.some((attempt) => attempt.status === "confirmed")).length;
  const active = walletJobs.filter((job) => ["pending", "running", "confirming"].includes(job.status)).length;

  const start = async () => {
    if (!walletId) return;
    setBusy(true); setMessage("");
    try {
      keyRef.current ||= crypto.randomUUID();
      const data = await fetch("/api/cookiez/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": keyRef.current },
        body: JSON.stringify({ walletId, target }),
      }).then(json) as { alreadyComplete?: boolean; current?: number; needed?: number };
      setMessage(data.alreadyComplete
        ? `Wallet already holds ${data.current} BAKERs—target complete.`
        : `Automation started: ${data.needed} sequential claim${data.needed === 1 ? "" : "s"} queued. It will retry TooSoon and stop at ${target}.`);
      keyRef.current = "";
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start claims");
    } finally { setBusy(false); }
  };

  return <>
    <div className="page-heading"><div><h1>COOKIEZ Quick Claim</h1><p>Temporary direct automation using your existing encrypted MintBot wallets.</p></div></div>
    {message && <div className="alert" style={{marginBottom:18}}>{message}</div>}
    <section className="panel mint-card">
      <div className="mint-body"><div className="mint-grid">
        <div className="phase-list">
          <div className="phase"><div className="phase-top"><h3>FREE BAKER AUTOMATION</h3><span className="status">Live</span></div><p className="muted">One global claim opens every five seconds. MintBot simulates from your wallet, treats only <span className="mono">TooSoon()</span> as a wait, signs locally and waits for confirmation before continuing.</p></div>
          <div className="phase"><div className="phase-top"><h3>Current selection</h3><span className="muted">Gas only</span></div><div className="summary-line"><span>Wallet</span><b>{selectedWallet ? `${selectedWallet.label} · ${short(selectedWallet.address)}` : "None"}</b></div><div className="summary-line"><span>Confirmed in recent tasks</span><b>{confirmed}</b></div><div className="summary-line"><span>Active claim steps</span><b>{active}</b></div></div>
        </div>
        <div className="schedule-box">
          <div className="field"><label>MintBot wallet</label><select value={walletId} onChange={(event)=>{setWalletId(event.target.value);keyRef.current=""}}>{wallets.map((wallet)=><option key={wallet.id} value={wallet.id}>{wallet.label} · {wallet.role} · {short(wallet.address)}</option>)}</select></div>
          <div className="field"><label>Target final BAKER balance</label><div className="amount-row"><input type="number" min="1" max="5" value={target} onChange={(event)=>{setTarget(Math.min(5,Math.max(1,Number(event.target.value)||1)));keyRef.current=""}}/><button className="secondary-btn" onClick={()=>setTarget(5)}>Max</button></div><small className="muted">The server reads the wallet’s current BAKER balance and queues only what is still needed.</small></div>
          <button className="primary-btn" disabled={busy||!walletId||active>0} onClick={()=>void start()}>{busy?"Starting…":active>0?"Automation already running":`Start → claim until ${target}`}</button>
          <div className="alert">No private key input. No MetaMask. No COOKIEZ Discord failure alerts. Unknown reverts still stop safely.</div>
        </div>
      </div></div>
    </section>
  </>;
}
