"use client";

import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { formatContractTime } from "@/lib/format-contract-time";

type Wallet = { id: string; label: string; address: string; chainId: number; role: "main" | "worker"; active: boolean };
type Collection = { id: string; name: string; slug?: string | null; contractAddress: string; chainId: number; mintPrice: string | null; maxPerWallet: number | null; maxSupply: number | null; currentSupply: number | null; phaseName?: string; phaseStatus: string; startsAt: string | null; endsAt: string | null; active?: boolean; verified?: boolean; createdAt: string };
type Broadcast = { routeLabel: string; status: string; latencyMs: number | null };
type Attempt = { id: string; kind: "approval" | "mint"; status: string; txHash: string | null; gasUsed: string | null; effectiveGasPrice: string | null; error: string | null; broadcasts?: Broadcast[] };
type Job = { id: string; batchId: string | null; walletId: string; collectionId: string; status: string; quantity: number; dryRun: boolean; scheduledAt: string | null; launchTargetAt?: string | null; timingDriftMs?: number | null; createdAt: string; error?: string | null; attempts: Attempt[] };
type TaskEdit = { id: string; collectionId: string; walletId: string; quantity: number };

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
async function json(response: Response) {
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Server returned an invalid response (${response.status})`); }
  if (!response.ok) {
    if (typeof data === "object" && data) {
      if ("error" in data) throw new Error(String(data.error));
      if ("reason" in data) throw new Error(String(data.reason));
    }
    throw new Error(`Request failed (${response.status})`);
  }
  return data;
}

export default function MintsPage() {
  const [query, setQuery] = useState("");
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [project, setProject] = useState<Collection | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState("minted");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [taskEdit, setTaskEdit] = useState<TaskEdit | null>(null);
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [adminPassword, setAdminPassword] = useState("");

  const suggestions = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!showSuggestions || value.length < 2 || /^https?:\/\//i.test(value) || /^0x[a-f0-9]{40}$/i.test(value)) return [];
    const compact = value.replace(/[^a-z0-9]/g, "");
    return collections
      .filter((item) => item.active !== false && item.verified !== false)
      .filter((item) => {
        const name = item.name.toLowerCase();
        const slug = (item.slug || "").toLowerCase();
        return name.includes(value) || slug.includes(value) || name.replace(/[^a-z0-9]/g, "").includes(compact) || slug.replace(/[^a-z0-9]/g, "").includes(compact);
      })
      .slice(0, 5);
  }, [collections, query, showSuggestions]);

  const load = async () => {
    const [walletData, collectionData, jobData] = await Promise.all([
      fetch("/api/wallets", { cache: "no-store" }).then(json),
      fetch("/api/collections", { cache: "no-store" }).then(json),
      fetch("/api/jobs?limit=200", { cache: "no-store" }).then(json),
    ]);
    setWallets(Array.isArray(walletData) ? walletData as Wallet[] : []);
    setCollections(Array.isArray(collectionData) ? collectionData as Collection[] : []);
    setJobs(Array.isArray(jobData) ? jobData as Job[] : []);
  };

  useEffect(() => {
    const initial = setTimeout(() => void load().catch((error) => setMessage(error instanceof Error ? error.message : "Could not load MintBot")), 0);
    const interval = setInterval(() => void load().catch(() => undefined), 5_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);

  const compatible = useMemo(
    () => project ? wallets
      .filter((wallet) => wallet.chainId === project.chainId && wallet.active)
      .sort((left, right) => Number(left.role === "worker") - Number(right.role === "worker")) : [],
    [wallets, project],
  );

  const resolve = async (rawInput = query) => {
    const input = rawInput.trim();
    if (!input) return;
    setShowSuggestions(false);
    setBusy(true);
    setMessage("Scanning supported mint adapters…");
    try {
      const response = await fetch("/api/mints/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
      const data = await json(response) as Record<string, unknown>;
      if (!data.supported) throw new Error(String(data.reason || "This mint isn’t supported yet"));
      const phases = Array.isArray(data.phases) ? data.phases as Array<Record<string, unknown>> : [];
      const phase = phases.find((item) => item.status === "live") || phases.find((item) => item.status === "upcoming") || phases[0];
      setProject({
        id: String(data.collectionId), name: String(data.name), contractAddress: String(data.contractAddress), chainId: Number(data.chainId),
        mintPrice: phase?.priceWei ? String(phase.priceWei) : null, maxPerWallet: phase?.maxPerWallet ? Number(phase.maxPerWallet) : null,
        maxSupply: data.maxSupply ? Number(data.maxSupply) : null, currentSupply: data.currentSupply == null ? null : Number(data.currentSupply),
        phaseName: phase?.name ? String(phase.name) : "Mint phase", phaseStatus: String(phase?.status || "unknown"), startsAt: phase?.startsAt ? String(phase.startsAt) : null,
        endsAt: phase?.endsAt ? String(phase.endsAt) : null, createdAt: "",
      });
      setQty(1);
      setSelected(new Set());
      setMessage("");
    } catch (error) {
      setProject(null);
      setMessage(error instanceof Error ? error.message : "This mint isn’t supported yet");
    } finally { setBusy(false); }
  };

  const loadPastedMint = (value: string) => {
    const input = value.trim();
    setQuery(input);
    setShowSuggestions(false);
    if (/^(https?:\/\/|www\.)/i.test(input) || /^0x[a-fA-F0-9]{40}$/.test(input)) void resolve(input);
  };

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const schedule = async () => {
    if (!project || !selected.size) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/jobs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ collectionId: project.id, walletIds: [...selected], quantity: qty }),
      });
      const data = await json(response) as { scheduledAt?: string | null };
      setMessage(data.scheduledAt
        ? `${selected.size} mint task${selected.size > 1 ? "s" : ""} queued for the verified contract opening time. Broadcasting can remain locked until your final verification.`
        : `${selected.size} mint task${selected.size > 1 ? "s" : ""} queued. Broadcasting waits safely if the live gate is locked.`);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not schedule mint"); }
    finally { setBusy(false); }
  };

  const saveTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!taskEdit) return;
    setBusy(true); setMessage("");
    try {
      await json(await fetch(`/api/jobs/${taskEdit.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletId: taskEdit.walletId, quantity: taskEdit.quantity }),
      }));
      setTaskEdit(null); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not update mint task"); }
    finally { setBusy(false); }
  };

  const deleteTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!deleteTaskId) return;
    setBusy(true); setMessage("");
    try {
      await json(await fetch(`/api/jobs/${deleteTaskId}`, { method: "DELETE", headers: { "X-Admin-Password": adminPassword } }));
      setDeleteTaskId(null); setAdminPassword(""); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not delete mint task"); }
    finally { setBusy(false); }
  };

  const formatPrice = (wei: string | null) => wei ? `${ethers.formatEther(wei)} ETH` : "FREE";
  const groups = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of jobs) {
      const key = job.batchId || job.id;
      map.set(key, [...(map.get(key) || []), job]);
    }
    return [...map.entries()];
  }, [jobs]);

  return <>
    <div className="page-heading"><div><h1>Mints</h1><p>Paste a supported mint link or search by project name.</p></div></div>
    <div className="mint-search">
      <div className="search-box"><input value={query} onFocus={() => setShowSuggestions(true)} onChange={(event) => { setQuery(event.target.value); setShowSuggestions(true); }} onPaste={(event) => { const value = event.clipboardData.getData("text"); if (value) { event.preventDefault(); loadPastedMint(value); } }} onKeyDown={(event) => event.key === "Enter" && void resolve()} placeholder="Paste mint URL, contract, or search project name"/><button disabled={busy || !query.trim()} onClick={() => void resolve()}>{busy ? "Checking…" : "Find mint →"}</button></div>
      {suggestions.length > 0 && <div className="search-results" role="listbox" aria-label="Supported mint matches">{suggestions.map((item) => <button key={item.id} type="button" onClick={() => { setQuery(item.name); void resolve(item.name); }}><span>{item.name}</span><small>{short(item.contractAddress)}</small></button>)}</div>}
    </div>
    {message && <div className="alert" style={{ marginBottom: 18 }}>{message}</div>}
    {!project ? <div className="panel empty"><div><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M20 4c-8 0-14 3.5-14 10 0 3 2 5 5 5 6.5 0 9-7 9-15Z"/><path d="M4 21c2-5 6-8 11-11"/></svg><h2>No mint selected</h2><p>Supported and scheduled mints will appear here.</p></div></div> :
      <section className="panel mint-card">
        <div className="mint-hero"><div className="mint-identity"><div className="project-art">◈</div><div className="mint-title"><h2>{project.name}</h2><p>{short(project.contractAddress)} · Chain {project.chainId}</p></div></div><div className="supply"><b>{project.maxSupply ? `${(project.currentSupply || 0).toLocaleString()} / ${project.maxSupply.toLocaleString()}` : "Supported mint"}</b><span>On-chain supply</span><div className="progress"><i style={{ width: project.maxSupply ? `${Math.min(100, ((project.currentSupply || 0) / project.maxSupply) * 100)}%` : "0%" }}/></div></div></div>
        <div className="mint-body"><div className="mint-grid"><div className="phase-list"><div className="phase"><div className="phase-top"><h3>{(project.phaseName || "Mint phase").toUpperCase()}</h3><span className="status">{project.phaseStatus === "live" ? "Live" : project.phaseStatus === "upcoming" ? "Upcoming" : "Ended"}</span></div><div className="chip-row"><span className="chip">PRICE · <strong>{formatPrice(project.mintPrice)}</strong></span><span className="chip">MAX · <strong>{project.maxPerWallet || "—"}</strong></span><span className="chip">ELIGIBLE · <strong>{compatible.length}</strong></span></div></div><div className="phase"><div className="phase-top"><h3>Mint configuration</h3><span className="muted" style={{ fontSize: 12 }}>Automatic gas</span></div><div className="field" style={{ marginTop: 12 }}><label>Quantity per wallet</label><div className="amount-row"><input type="number" min="1" max={project.maxPerWallet || 100} value={qty} onChange={(event) => setQty(Math.min(project.maxPerWallet || 100, Math.max(1, Number(event.target.value) || 1)))}/><button className="secondary-btn" onClick={() => setQty(project.maxPerWallet || 1)}>Max</button></div></div></div></div>
          <div className="schedule-box"><div className="field"><label>Active wallets ({selected.size} selected)</label><div className="wallet-picker">{compatible.length ? compatible.map((wallet) => <label className="wallet-option" key={wallet.id}><input type="checkbox" checked={selected.has(wallet.id)} onChange={() => toggle(wallet.id)}/><span>{wallet.label} · {wallet.role === "main" ? "Main" : "Worker"}</span><small>{short(wallet.address)}</small></label>) : <div className="wallet-option muted">No compatible active wallets</div>}</div></div><div className="field"><label>Contract schedule</label><div className="alert">{project.phaseStatus === "upcoming" && project.startsAt ? `Server schedules against ${formatContractTime(project.startsAt)}` : project.phaseStatus === "ended" ? "This reviewed phase has ended." : formatContractTime(null)}</div></div><button className="primary-btn" disabled={!selected.size || busy || project.phaseStatus === "ended"} onClick={() => void schedule()}>{busy ? "Scheduling…" : "Schedule mint →"}</button><div className="alert">Main and worker wallets can mint. Every transaction uses the selected wallet as the simulation sender and is durably recorded before broadcast.</div></div>
        </div></div>
      </section>}
    {groups.length > 0 && <section className="scheduled"><div className="section-title"><h2>Scheduled & recent</h2><span className="muted" style={{ fontSize: 12 }}>{jobs.length} tasks</span></div>{groups.map(([batchId, items]) => {
      const collection = collections.find((item) => item.id === items[0]?.collectionId);
      const confirmed = items.filter((item) => item.status === "completed" && !item.dryRun).length;
      const simulated = items.filter((item) => item.status === "completed" && item.dryRun).length;
      return <div className="panel job" key={batchId}><div className="job-summary" onClick={() => setExpanded(expanded === batchId ? null : batchId)}><div className="job-art"/><div className="job-main"><b>{collection?.name || "Supported mint"}</b><span>{items.length} wallets · {items.reduce((total, item) => total + item.quantity, 0)} total · {confirmed} confirmed{simulated ? ` · ${simulated} simulated` : ""}</span></div><span className="status">{items.some((item) => item.status === "armed") ? "Armed" : items.some((item) => ["running", "confirming"].includes(item.status)) ? "Running" : items.some((item) => item.status === "pending") ? "Scheduled" : "Finished"}</span><span>{expanded === batchId ? "⌃" : "⌄"}</span></div>{expanded === batchId && <div className="result-panel"><div className="result-tabs">{["minted", "transactions", "analytics"].map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>)}</div>{tab === "analytics" ? <div className="summary-box"><div className="summary-line"><span>Total tasks</span><b>{items.length}</b></div><div className="summary-line"><span>Confirmed mints</span><b className="ok">{confirmed}</b></div><div className="summary-line"><span>Armed transactions</span><b>{items.filter((item) => item.status === "armed").length}</b></div><div className="summary-line"><span>Best timer drift</span><b>{items.some((item) => item.timingDriftMs != null) ? `${Math.min(...items.flatMap((item) => item.timingDriftMs == null ? [] : [item.timingDriftMs]))} ms` : "—"}</b></div><div className="summary-line"><span>Fastest route ACK</span><b>{items.flatMap((item) => item.attempts.flatMap((attempt) => attempt.broadcasts || [])).some((route) => route.latencyMs != null) ? `${Math.min(...items.flatMap((item) => item.attempts.flatMap((attempt) => (attempt.broadcasts || []).flatMap((route) => route.latencyMs == null ? [] : [route.latencyMs]))))} ms` : "—"}</b></div><div className="summary-line"><span>Simulation-only passes</span><b>{simulated}</b></div><div className="summary-line"><span>Failed</span><b className="failed">{items.filter((item) => item.status === "failed").length}</b></div></div> : <table className="result-table"><thead><tr><th>Status</th><th>{tab === "minted" ? "Wallet" : "Transaction"}</th><th>Amount</th><th>Result</th></tr></thead><tbody>{items.map((job) => {
        const wallet = wallets.find((item) => item.id === job.walletId);
        const attempt = job.attempts?.find((item) => item.kind === "mint") || job.attempts?.[0];
        const status = job.dryRun && job.status === "completed" ? "simulation passed" : attempt?.status || job.status;
        const gas = attempt?.gasUsed && attempt?.effectiveGasPrice ? `${ethers.formatEther(BigInt(attempt.gasUsed) * BigInt(attempt.effectiveGasPrice))} ETH gas` : null;
        return <tr key={job.id}><td className={job.status === "failed" ? "failed" : job.status === "completed" ? "ok" : ""}>{job.status === "failed" ? "✕" : job.status === "completed" ? "✓" : "…"}</td><td className="mono">{tab === "minted" ? short(wallet?.address || job.walletId) : attempt?.txHash ? short(attempt.txHash) : "No broadcast"}</td><td>{job.quantity}</td><td><div>{job.error || attempt?.error || `${status}${gas ? ` · ${gas}` : ""}`}</div>{job.status === "pending" && job.attempts.length === 0 && <div className="toolbar" style={{marginTop:8}}><button className="secondary-btn" style={{padding:"5px 8px"}} onClick={()=>{setMessage("");setTaskEdit({id:job.id,collectionId:job.collectionId,walletId:job.walletId,quantity:job.quantity})}}>Edit</button><button className="secondary-btn" style={{padding:"5px 8px",color:"var(--danger)"}} onClick={()=>{setMessage("");setDeleteTaskId(job.id);setAdminPassword("")}}>Delete</button></div>}</td></tr>;
      })}</tbody></table>}</div>}</div>;
    })}</section>}
    {taskEdit && <div className="modal-backdrop" onMouseDown={()=>setTaskEdit(null)}><form className="panel modal" onSubmit={saveTask} onMouseDown={(event)=>event.stopPropagation()}><div className="modal-head"><div><h2>Edit scheduled mint</h2><p className="muted" style={{fontSize:12,margin:"5px 0 0"}}>Only pending, unsigned tasks can change. Contract launch timing remains server-controlled.</p></div><button type="button" onClick={()=>setTaskEdit(null)}>×</button></div>{message&&<div className="alert" style={{color:"var(--danger)",marginBottom:14}}>{message}</div>}<div className="form-grid"><div className="field"><label>Wallet</label><select required value={taskEdit.walletId} onChange={(event)=>setTaskEdit({...taskEdit,walletId:event.target.value})}>{wallets.filter((wallet)=>wallet.active&&wallet.chainId===collections.find((item)=>item.id===taskEdit.collectionId)?.chainId).map((wallet)=><option key={wallet.id} value={wallet.id}>{wallet.label} · {short(wallet.address)}</option>)}</select></div><div className="field"><label>Quantity</label><input type="number" min="1" max={collections.find((item)=>item.id===taskEdit.collectionId)?.maxPerWallet||100} value={taskEdit.quantity} onChange={(event)=>setTaskEdit({...taskEdit,quantity:Math.max(1,Number(event.target.value)||1)})}/></div><button className="primary-btn" disabled={busy}>{busy?"Saving…":"Save task"}</button></div></form></div>}
    {deleteTaskId && <div className="modal-backdrop" onMouseDown={()=>setDeleteTaskId(null)}><form className="panel modal" onSubmit={deleteTask} onMouseDown={(event)=>event.stopPropagation()}><div className="modal-head"><div><h2>Delete scheduled task</h2><p className="muted" style={{fontSize:12,margin:"5px 0 0"}}>This permanently removes a pending, unsigned task.</p></div><button type="button" onClick={()=>setDeleteTaskId(null)}>×</button></div>{message&&<div className="alert" style={{color:"var(--danger)",marginBottom:14}}>{message}</div>}<div className="form-grid"><div className="field"><label>Admin password</label><input type="password" required autoFocus autoComplete="current-password" placeholder="App login password" value={adminPassword} onChange={(event)=>setAdminPassword(event.target.value)}/></div><button className="primary-btn" style={{background:"var(--danger)"}} disabled={busy||!adminPassword}>{busy?"Deleting…":"Confirm deletion"}</button></div></form></div>}
  </>;
}
