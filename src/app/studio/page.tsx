"use client";

import { useMemo, useState } from "react";
import {
  buildStudioDraftPayload,
  certificationCommand,
  emptyStudioDraft,
  parseStudioJson,
  studioDomains,
  studioDraftFromResolver,
  type StudioDraftFields,
} from "@/lib/mint-studio";

type ResolverDescriptor = { key: string; label: string; support: string; mode: string; notes: string };
type ResolverResult = {
  resolverRunId: string;
  status: "resolved" | "needs-input" | "unsupported";
  resolverKey: string;
  resolverVersion: string;
  blockers: string[];
  warnings: string[];
  draft?: Record<string, unknown>;
  evidence: { blockNumber: number; blockHash: string; contractCodeHash: string; observations: Record<string, unknown> };
};
type DraftResult = {
  collectionId: string;
  definitionVersionId: string;
  version: number;
  definitionHash: string;
  status: string;
  duplicate: boolean;
};
type DefinitionVersion = {
  id: string;
  version: number;
  status: string;
  definitionHash: string;
  definitionJson: string;
  source: string;
  createdAt: string;
  certifiedAt?: string | null;
  activatedAt?: string | null;
};
type Certification = {
  id: string;
  definitionVersionId: string;
  status: string;
  certificateHash: string;
  evidenceHash: string;
  runnerVersion: string;
  certifiedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};
type DefinitionsResponse = { collectionId: string; versions: DefinitionVersion[]; certifications: Certification[] };
type Collection = {
  id: string;
  name: string;
  chainId: number;
  contractAddress: string;
  active: boolean;
  verified: boolean;
  broadcastPaused: boolean;
  broadcastPauseReason: string | null;
};
type Wallet = { id: string; label: string; address: string; chainId: number; role: string; active: boolean };
type ReadinessCheck = { key: string; status: "pass" | "warn" | "fail"; detail: string };
type WalletReadiness = { walletId: string; label: string; phaseId: string | null; status: "ready" | "warning" | "blocked"; checks: ReadinessCheck[] };
type ReadinessResponse = {
  collectionId: string;
  chainId: number;
  quantity: number;
  wallets: WalletReadiness[];
  summary: { ready: number; warning: number; blocked: number };
};
type CutoverResponse = {
  state: { status: string; requiredSamples: number; matchedCount: number; mismatchedCount: number; errorCount: number; reason: string; auditCycle: number };
  readiness: { ready: boolean; blockers: string[] };
  comparisons?: Array<{ id: string; status: string; reason?: string; createdAt: string }>;
};
type Notice = { tone: "success" | "warning" | "danger"; text: string };

const CHAINS = [
  [1, "Ethereum"], [10, "Optimism"], [137, "Polygon"], [8453, "Base"], [42161, "Arbitrum"], [43114, "Avalanche"], [4663, "Robinhood"],
] as const;

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let value: unknown = {};
  try { value = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Server returned an invalid response (${response.status})`); }
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value ? String(value.error) : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return value as T;
}

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function MintStudioPage() {
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [resolvers, setResolvers] = useState<ResolverDescriptor[]>([]);
  const [resolver, setResolver] = useState({ platform: "opensea-seadrop-v1", chainId: "1", contractAddress: "", name: "", slug: "", siteUrl: "", domains: "", feeRecipient: "", providerPayload: "" });
  const [resolverResult, setResolverResult] = useState<ResolverResult | null>(null);
  const [draft, setDraft] = useState<StudioDraftFields>(emptyStudioDraft);
  const [collection, setCollection] = useState<Collection | null>(null);
  const [definitions, setDefinitions] = useState<DefinitionsResponse | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [certificationJson, setCertificationJson] = useState("");
  const [artifactPhaseId, setArtifactPhaseId] = useState("");
  const [artifactJson, setArtifactJson] = useState("[]");
  const [cutover, setCutover] = useState<CutoverResponse | null>(null);
  const [shadowSamples, setShadowSamples] = useState(20);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selectedWalletIds, setSelectedWalletIds] = useState<Set<string>>(new Set());
  const [quantity, setQuantity] = useState(1);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [releaseConfirmation, setReleaseConfirmation] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [scheduleConfirmation, setScheduleConfirmation] = useState("");

  const selectedVersion = definitions?.versions.find((item) => item.id === selectedVersionId) || null;
  const selectedCertificate = definitions?.certifications.find((item) => item.definitionVersionId === selectedVersionId && item.status === "passed" && !item.revokedAt) || null;
  const compatibleWallets = useMemo(() => wallets.filter((item) => item.active && (!collection || item.chainId === collection.chainId)), [wallets, collection]);
  const selectedRows = useMemo(() => readiness?.wallets.filter((item) => selectedWalletIds.has(item.walletId)) || [], [readiness, selectedWalletIds]);
  const scheduleReady = selectedWalletIds.size > 0 && selectedRows.length === selectedWalletIds.size && selectedRows.every((item) => item.status === "ready" && item.phaseId);

  const adminHeaders = (): HeadersInit => ({ "Content-Type": "application/json", "x-support-admin-token": token });
  const showError = (error: unknown) => setNotice({ tone: "danger", text: error instanceof Error ? error.message : "Mint Studio operation failed" });
  const setField = <K extends keyof StudioDraftFields>(key: K, value: StudioDraftFields[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function unlock(): Promise<void> {
    if (!token.trim()) return;
    setBusy("unlock"); setNotice(null);
    try {
      const data = await responseJson<{ resolvers: ResolverDescriptor[] }>(await fetch("/api/resolvers", { headers: adminHeaders(), cache: "no-store" }));
      setResolvers(data.resolvers);
      setUnlocked(true);
      setNotice({ tone: "success", text: "Operator session unlocked. The token stays only in this browser tab's memory." });
    } catch (error) { setUnlocked(false); showError(error); }
    finally { setBusy(""); }
  }

  async function inspectResolver(): Promise<void> {
    setBusy("resolver"); setNotice(null); setResolverResult(null);
    try {
      const body: Record<string, unknown> = {
        platform: resolver.platform,
        chainId: Number(resolver.chainId),
        contractAddress: resolver.contractAddress.trim(),
        ...(resolver.name.trim() ? { name: resolver.name.trim() } : {}),
        ...(resolver.slug.trim() ? { slug: resolver.slug.trim() } : {}),
        ...(resolver.siteUrl.trim() ? { siteUrl: resolver.siteUrl.trim() } : {}),
        ...(studioDomains(resolver.domains).length ? { domains: studioDomains(resolver.domains) } : {}),
        ...(resolver.feeRecipient.trim() ? { feeRecipient: resolver.feeRecipient.trim() } : {}),
        ...(resolver.providerPayload.trim() ? { providerPayload: parseStudioJson(resolver.providerPayload, "Provider payload") } : {}),
      };
      const result = await responseJson<ResolverResult>(await fetch("/api/resolvers", { method: "POST", headers: adminHeaders(), body: JSON.stringify(body) }));
      setResolverResult(result);
      if (result.draft) setDraft((current) => studioDraftFromResolver(result.draft!, current));
      setNotice({ tone: result.status === "resolved" ? "success" : "warning", text: result.status === "resolved" ? "Resolver produced an evidence-backed draft. Review every field before saving." : "Inspection completed, but the resolver needs operator evidence before this mint can become a valid draft." });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function refreshWorkspace(collectionId: string, preferVersionId?: string): Promise<void> {
    const [definitionData, collectionData, walletData] = await Promise.all([
      responseJson<DefinitionsResponse>(await fetch(`/api/collections/${collectionId}/definitions`, { headers: adminHeaders(), cache: "no-store" })),
      responseJson<Collection[]>(await fetch("/api/collections", { cache: "no-store" })),
      responseJson<Wallet[]>(await fetch("/api/wallets", { cache: "no-store" })),
    ]);
    const found = collectionData.find((item) => item.id === collectionId);
    if (!found) throw new Error("Collection was not found");
    setDefinitions(definitionData);
    setCollection(found);
    setWallets(walletData);
    setSelectedVersionId((current) => preferVersionId || (definitionData.versions.some((item) => item.id === current) ? current : definitionData.versions[0]?.id || ""));
    setSelectedWalletIds(new Set());
    setReadiness(null);
    try {
      setCutover(await responseJson<CutoverResponse>(await fetch(`/api/collections/${collectionId}/cutover`, { headers: adminHeaders(), cache: "no-store" })));
    } catch { setCutover(null); }
  }

  async function loadExisting(): Promise<void> {
    if (!draft.id.trim()) return;
    setBusy("load"); setNotice(null);
    try {
      await refreshWorkspace(draft.id.trim());
      setNotice({ tone: "success", text: "Existing mint lifecycle loaded." });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function createDraft(): Promise<void> {
    setBusy("draft"); setNotice(null);
    try {
      const payload = buildStudioDraftPayload(draft);
      const result = await responseJson<DraftResult>(await fetch("/api/collections", { method: "POST", headers: adminHeaders(), body: JSON.stringify(payload) }));
      setDraft((current) => ({ ...current, id: result.collectionId }));
      await refreshWorkspace(result.collectionId, result.definitionVersionId);
      setNotice({ tone: "success", text: result.duplicate ? `Identical draft v${result.version} loaded; nothing was overwritten.` : `Immutable draft v${result.version} created. It is inactive and broadcast-locked.` });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function importCertification(): Promise<void> {
    if (!collection || !selectedVersionId) return;
    setBusy("certify"); setNotice(null);
    try {
      const parsed = parseStudioJson(certificationJson, "Certification evidence");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Certification evidence must be a JSON object");
      const evidence = "evidence" in parsed ? parsed.evidence : parsed;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Certification output does not contain an evidence object");
      const result = await responseJson<{ status: string; certificateHash: string }>(await fetch(`/api/collections/${collection.id}/definitions/${selectedVersionId}/certify`, {
        method: "POST", headers: adminHeaders(), body: JSON.stringify({ evidence }),
      }));
      await refreshWorkspace(collection.id, selectedVersionId);
      setNotice({ tone: "success", text: `Controlled evidence accepted. Certificate ${short(result.certificateHash)} is ${result.status}.` });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function uploadArtifacts(): Promise<void> {
    if (!collection || !selectedVersionId) return;
    setBusy("artifacts"); setNotice(null);
    try {
      const parsed = parseStudioJson(artifactJson, "Eligibility artifacts");
      const artifacts = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "artifacts" in parsed ? parsed.artifacts : null;
      if (!Array.isArray(artifacts)) throw new Error("Eligibility artifacts must be a JSON array or an object containing artifacts");
      const result = await responseJson<{ stored: unknown[] }>(await fetch(`/api/collections/${collection.id}/definitions/${selectedVersionId}/eligibility-artifacts`, {
        method: "POST", headers: adminHeaders(), body: JSON.stringify({ phaseId: artifactPhaseId.trim(), artifacts }),
      }));
      setNotice({ tone: "success", text: `${result.stored.length} wallet artifact${result.stored.length === 1 ? "" : "s"} validated, encrypted, and pinned to this definition.` });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function cutoverAction(action: "start-shadow" | "evaluate"): Promise<void> {
    if (!collection || !selectedVersionId) return;
    setBusy("cutover"); setNotice(null);
    try {
      const body = action === "start-shadow" ? { action, candidateDefinitionVersionId: selectedVersionId, requiredSamples: shadowSamples } : { action };
      const result = await responseJson<CutoverResponse>(await fetch(`/api/collections/${collection.id}/cutover`, { method: "POST", headers: adminHeaders(), body: JSON.stringify(body) }));
      setCutover(result);
      setNotice({ tone: result.readiness.ready ? "success" : "warning", text: result.readiness.ready ? "Exact transaction-intent parity is ready for atomic activation." : result.state.reason });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function activate(): Promise<void> {
    if (!collection || !selectedVersionId) return;
    setBusy("activate"); setNotice(null);
    try {
      await responseJson(await fetch(`/api/collections/${collection.id}/definitions/${selectedVersionId}/activate`, { method: "POST", headers: adminHeaders(), body: "{}" }));
      await refreshWorkspace(collection.id, selectedVersionId);
      setNotice({ tone: "success", text: "Definition activated atomically. Broadcasting is still paused until the separate release step." });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function releaseBroadcast(): Promise<void> {
    if (!collection || releaseConfirmation !== "RELEASE BROADCAST") return;
    setBusy("release"); setNotice(null);
    try {
      await responseJson(await fetch(`/api/collections/${collection.id}/controls`, {
        method: "PATCH", headers: adminHeaders(), body: JSON.stringify({ projectPaused: false, reason: "Explicit Mint Studio operator release after readiness review" }),
      }));
      setReleaseConfirmation("");
      await refreshWorkspace(collection.id, selectedVersionId);
      setNotice({ tone: "success", text: "Project broadcast control released. Global transaction gates and per-phase controls still apply." });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function runReadiness(): Promise<void> {
    if (!collection || !selectedWalletIds.size) return;
    setBusy("readiness"); setNotice(null);
    try {
      const result = await responseJson<ReadinessResponse>(await fetch(`/api/collections/${collection.id}/readiness`, {
        method: "POST", headers: adminHeaders(), body: JSON.stringify({ walletIds: [...selectedWalletIds], quantity }),
      }));
      setReadiness(result);
      setNotice({ tone: result.summary.blocked ? "warning" : "success", text: `${result.summary.ready} ready · ${result.summary.warning} warning · ${result.summary.blocked} blocked.` });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  async function scheduleTasks(): Promise<void> {
    if (!collection || !scheduleReady || (!dryRun && scheduleConfirmation !== "SCHEDULE LIVE")) return;
    setBusy("schedule"); setNotice(null);
    try {
      const phases = selectedRows.map((item) => ({ walletId: item.walletId, phaseId: item.phaseId! }));
      const result = await responseJson<{ batchId: string; jobs?: unknown[] }>(await fetch("/api/jobs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ collectionId: collection.id, walletIds: [...selectedWalletIds], phases, quantity, dryRun }),
      }));
      setScheduleConfirmation("");
      setNotice({ tone: "success", text: `${dryRun ? "Dry-run" : "Live"} batch ${short(result.batchId)} accepted with exact phase and definition pins.` });
    } catch (error) { showError(error); }
    finally { setBusy(""); }
  }

  return <div className="studio-page">
    <div className="page-heading studio-heading">
      <div><h1>Mint Studio</h1><p>Compile, certify, activate, and schedule byte-pinned mint definitions.</p></div>
      <span className={`studio-lock ${unlocked ? "unlocked" : ""}`}>{unlocked ? "Operator unlocked" : "Locked"}</span>
    </div>

    {notice && <div className={`studio-notice ${notice.tone}`} role="status">{notice.text}</div>}

    <section className="panel studio-section">
      <div className="studio-section-head"><span className="studio-step">1</span><div><h2>Operator access</h2><p>Required for resolver, definition, certification, cutover, and readiness APIs.</p></div></div>
      <div className="studio-inline">
        <div className="field grow"><label htmlFor="studio-token">Support admin token</label><input id="studio-token" type="password" autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); setUnlocked(false); }} onKeyDown={(event) => { if (event.key === "Enter") void unlock(); }} /></div>
        <button className="primary-btn" disabled={!token.trim() || busy === "unlock"} onClick={() => void unlock()}>{busy === "unlock" ? "Checking…" : "Unlock tab"}</button>
      </div>
      <p className="studio-footnote">The token is held in React memory only—never written to local storage, a URL, or the repository.</p>
    </section>

    <fieldset disabled={!unlocked || Boolean(busy)} className="studio-fieldset">
      <section className="panel studio-section">
        <div className="studio-section-head"><span className="studio-step">2</span><div><h2>Inspect launchpad</h2><p>Pin current bytecode/state and prefill only what the resolver can prove.</p></div></div>
        <div className="studio-grid three">
          <div className="field"><label>Resolver</label><select value={resolver.platform} onChange={(event) => setResolver((current) => ({ ...current, platform: event.target.value }))}>{(resolvers.length ? resolvers : [{ key: "opensea-seadrop-v1", label: "OpenSea SeaDrop V1", support: "", mode: "", notes: "" }]).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></div>
          <div className="field"><label>Chain</label><select value={resolver.chainId} onChange={(event) => setResolver((current) => ({ ...current, chainId: event.target.value }))}>{CHAINS.map(([id, name]) => <option value={id} key={id}>{name} · {id}</option>)}</select></div>
          <div className="field"><label>Contract</label><input className="mono" value={resolver.contractAddress} onChange={(event) => setResolver((current) => ({ ...current, contractAddress: event.target.value }))} placeholder="0x…" /></div>
          <div className="field"><label>Name</label><input value={resolver.name} onChange={(event) => setResolver((current) => ({ ...current, name: event.target.value }))} /></div>
          <div className="field"><label>Slug</label><input value={resolver.slug} onChange={(event) => setResolver((current) => ({ ...current, slug: event.target.value }))} /></div>
          <div className="field"><label>Fee recipient</label><input className="mono" value={resolver.feeRecipient} onChange={(event) => setResolver((current) => ({ ...current, feeRecipient: event.target.value }))} placeholder="Required by SeaDrop public" /></div>
          <div className="field span-two"><label>Canonical mint URL</label><input value={resolver.siteUrl} onChange={(event) => setResolver((current) => ({ ...current, siteUrl: event.target.value }))} placeholder="https://…" /></div>
          <div className="field"><label>Exact domains</label><input value={resolver.domains} onChange={(event) => setResolver((current) => ({ ...current, domains: event.target.value }))} placeholder="mint.example.com" /></div>
        </div>
        <details className="studio-details"><summary>Provider payload (only for payload-based resolvers)</summary><div className="field"><textarea className="studio-code" value={resolver.providerPayload} onChange={(event) => setResolver((current) => ({ ...current, providerPayload: event.target.value }))} placeholder="{ &quot;transaction&quot;: { … }, &quot;phases&quot;: [ … ] }" /></div></details>
        <div className="studio-actions"><button className="primary-btn" onClick={() => void inspectResolver()}>{busy === "resolver" ? "Inspecting…" : "Inspect and pin evidence"}</button></div>
        {resolverResult && <div className="studio-result">
          <div className="studio-result-top"><span className={`studio-badge ${resolverResult.status}`}>{resolverResult.status}</span><code>{resolverResult.resolverKey} · {resolverResult.resolverVersion}</code></div>
          <p>Block {resolverResult.evidence.blockNumber} · {short(resolverResult.evidence.blockHash)} · code {short(resolverResult.evidence.contractCodeHash)}</p>
          {!!resolverResult.blockers.length && <ul>{resolverResult.blockers.map((item) => <li key={item}>{item}</li>)}</ul>}
          {!!resolverResult.warnings.length && <ul className="studio-warnings">{resolverResult.warnings.map((item) => <li key={item}>{item}</li>)}</ul>}
          {resolverResult.draft && <p className="ok">Evidence-backed values have been copied into the draft editor below.</p>}
        </div>}
      </section>

      <section className="panel studio-section">
        <div className="studio-section-head"><span className="studio-step">3</span><div><h2>Compile immutable draft</h2><p>Existing collection IDs create a new version without mutating the live definition.</p></div></div>
        <div className="studio-inline studio-load"><div className="field grow"><label>Existing collection UUID (optional)</label><input className="mono" value={draft.id} onChange={(event) => setField("id", event.target.value)} placeholder="Leave blank for a new mint" /></div><button className="secondary-btn" disabled={!draft.id.trim()} onClick={() => void loadExisting()}>{busy === "load" ? "Loading…" : "Load lifecycle"}</button></div>
        <div className="studio-grid three">
          <div className="field"><label>Name</label><input value={draft.name} onChange={(event) => setField("name", event.target.value)} /></div>
          <div className="field"><label>Slug</label><input value={draft.slug} onChange={(event) => setField("slug", event.target.value)} /></div>
          <div className="field"><label>Chain ID</label><input inputMode="numeric" value={draft.chainId} onChange={(event) => setField("chainId", event.target.value)} /></div>
          <div className="field span-two"><label>Collection contract</label><input className="mono" value={draft.contractAddress} onChange={(event) => setField("contractAddress", event.target.value)} placeholder="0x…" /></div>
          <div className="field"><label>Adapter</label><select value={draft.adapterKey} onChange={(event) => setField("adapterKey", event.target.value)}><option value="reviewed-call-v1">Reviewed call v1</option><option value="opensea-signed-seadrop-v1">OpenSea signed SeaDrop v1</option></select></div>
          <div className="field span-two"><label>Canonical mint URL</label><input value={draft.siteUrl} onChange={(event) => setField("siteUrl", event.target.value)} /></div>
          <div className="field"><label>Exact domains (comma/newline)</label><input value={draft.domains} onChange={(event) => setField("domains", event.target.value)} /></div>
          <div className="field span-two"><label>Canonical function signature</label><input className="mono" value={draft.mintMethod} onChange={(event) => setField("mintMethod", event.target.value)} placeholder="mint(address,uint256,bytes32[])" /></div>
          <div className="field"><label>Mint price (wei)</label><input className="mono" inputMode="numeric" value={draft.mintPrice} onChange={(event) => setField("mintPrice", event.target.value)} /></div>
          <div className="field"><label>Max per wallet</label><input inputMode="numeric" value={draft.maxPerWallet} onChange={(event) => setField("maxPerWallet", event.target.value)} /></div>
          <div className="field"><label>Max supply</label><input inputMode="numeric" value={draft.maxSupply} onChange={(event) => setField("maxSupply", event.target.value)} /></div>
          <div className="field"><label>ERC-20 payment token (optional)</label><input className="mono" value={draft.paymentToken} onChange={(event) => setField("paymentToken", event.target.value)} /></div>
          <div className="field span-three"><label>Image URL (optional)</label><input value={draft.imageUrl} onChange={(event) => setField("imageUrl", event.target.value)} /></div>
          <div className="field span-three"><label>ABI JSON</label><textarea className="studio-code" value={draft.mintAbi} onChange={(event) => setField("mintAbi", event.target.value)} /></div>
          <div className="field span-three"><label>Reviewed adapter configuration JSON</label><textarea className="studio-code tall" value={draft.adapterConfig} onChange={(event) => setField("adapterConfig", event.target.value)} /></div>
        </div>
        <div className="studio-safety">Draft submission validates canonical ABI bindings, eligibility rules, phase windows, wallet/quantity bindings, and payment value rules server-side. It cannot self-certify or self-activate.</div>
        <div className="studio-actions"><button className="primary-btn" onClick={() => void createDraft()}>{busy === "draft" ? "Compiling…" : "Validate and create draft"}</button></div>
      </section>

      {collection && definitions && <>
        <section className="panel studio-section">
          <div className="studio-section-head"><span className="studio-step">4</span><div><h2>Certify exact transaction bytes</h2><p>Run the controlled certifier against a pinned fork/replay RPC, then import its signed evidence.</p></div></div>
          <div className="studio-status-grid">
            <div><span>Mint</span><strong>{collection.name}</strong><code>{short(collection.id)}</code></div>
            <div><span>State</span><strong>{collection.active ? "active" : "inactive"} · {collection.verified ? "verified" : "unverified"}</strong><code>{collection.broadcastPaused ? "broadcast paused" : "broadcast released"}</code></div>
            <div><span>Contract</span><strong>Chain {collection.chainId}</strong><code>{short(collection.contractAddress)}</code></div>
          </div>
          <div className="field"><label>Definition version</label><select value={selectedVersionId} onChange={(event) => { setSelectedVersionId(event.target.value); setReadiness(null); }}>{definitions.versions.map((item) => <option value={item.id} key={item.id}>v{item.version} · {item.status} · {short(item.definitionHash)}</option>)}</select></div>
          {selectedVersion && <>
            <div className="studio-command"><code>{certificationCommand(selectedVersion.id)}</code><button type="button" onClick={() => void navigator.clipboard.writeText(certificationCommand(selectedVersion.id))}>Copy</button></div>
            <p className="studio-footnote">The transaction file must include one exact adapter-built transaction for every executable phase. The output expires after 24 hours and is bound to the deployed commit.</p>
            <div className="field"><label>Signed certification evidence JSON</label><textarea className="studio-code tall" value={certificationJson} onChange={(event) => setCertificationJson(event.target.value)} placeholder="Paste certification-evidence.json" /></div>
            <div className="studio-actions"><button className="primary-btn" disabled={!certificationJson.trim()} onClick={() => void importCertification()}>{busy === "certify" ? "Verifying…" : "Verify and import evidence"}</button></div>
          </>}
          <div className="table-wrap studio-table-wrap"><table className="wallet-table"><thead><tr><th>Version</th><th>Status</th><th>Definition hash</th><th>Certificate</th><th>Created</th></tr></thead><tbody>{definitions.versions.map((item) => { const cert = definitions.certifications.find((value) => value.definitionVersionId === item.id && value.status === "passed" && !value.revokedAt); return <tr key={item.id}><td>v{item.version}</td><td><span className={`studio-badge ${item.status}`}>{item.status}</span></td><td className="mono">{short(item.definitionHash)}</td><td>{cert ? <span className="ok">valid until {formatDate(cert.expiresAt)}</span> : <span className="muted">none</span>}</td><td>{formatDate(item.createdAt)}</td></tr>; })}</tbody></table></div>
        </section>

        <section className="panel studio-section">
          <div className="studio-section-head"><span className="studio-step">5</span><div><h2>WL artifacts and cutover</h2><p>Pin wallet-specific proofs/signatures, or prove parity before replacing a live definition.</p></div></div>
          <div className="studio-split">
            <div>
              <h3>Eligibility artifact import</h3>
              <div className="field"><label>Reviewed phase ID</label><input value={artifactPhaseId} onChange={(event) => setArtifactPhaseId(event.target.value)} placeholder="allowlist" /></div>
              <div className="field"><label>Wallet artifacts JSON</label><textarea className="studio-code" value={artifactJson} onChange={(event) => setArtifactJson(event.target.value)} /></div>
              <button className="secondary-btn" disabled={!selectedCertificate || !artifactPhaseId.trim()} onClick={() => void uploadArtifacts()}>{busy === "artifacts" ? "Validating…" : "Validate and pin artifacts"}</button>
              {!selectedCertificate && <p className="studio-footnote">Select a certified definition before importing wallet artifacts.</p>}
            </div>
            <div>
              <h3>Exact shadow parity</h3>
              {cutover ? <div className="studio-result"><div className="studio-result-top"><span className={`studio-badge ${cutover.state.status}`}>{cutover.state.status}</span><code>cycle {cutover.state.auditCycle}</code></div><p>{cutover.state.matchedCount}/{cutover.state.requiredSamples} match · {cutover.state.mismatchedCount} mismatch · {cutover.state.errorCount} error</p><p>{cutover.state.reason}</p>{cutover.readiness.blockers?.map((item) => <p className="failed" key={item}>{item}</p>)}</div> : <p className="muted">New mints do not need shadow cutover. Replacements do.</p>}
              <div className="studio-inline"><div className="field grow"><label>Required exact samples</label><input type="number" min={3} max={10000} value={shadowSamples} onChange={(event) => setShadowSamples(Number(event.target.value))} /></div><button className="secondary-btn" disabled={selectedVersion?.status !== "certified" || Boolean(cutover && cutover.state.status !== "rollback")} onClick={() => void cutoverAction("start-shadow")}>Start audit</button><button className="secondary-btn" disabled={!cutover || cutover.state.status !== "shadow"} onClick={() => void cutoverAction("evaluate")}>Evaluate</button></div>
            </div>
          </div>
        </section>

        <section className="panel studio-section">
          <div className="studio-section-head"><span className="studio-step">6</span><div><h2>Activate and release</h2><p>Activation remains paused. Broadcast release is a separate, typed-confirmation operation.</p></div></div>
          <div className="studio-split">
            <div className="studio-action-card"><h3>Activate selected version</h3><p>Requires a valid unexpired certificate. Replacements additionally require a ready exact-parity audit.</p><button className="primary-btn" disabled={selectedVersion?.status !== "certified" || !selectedCertificate} onClick={() => void activate()}>{busy === "activate" ? "Activating…" : "Activate, keep paused"}</button></div>
            <div className="studio-action-card danger"><h3>Release project broadcast</h3><p>Type <code>RELEASE BROADCAST</code>. Global live-transaction gates and phase controls remain authoritative.</p><div className="field"><input value={releaseConfirmation} onChange={(event) => setReleaseConfirmation(event.target.value)} placeholder="RELEASE BROADCAST" /></div><button className="primary-btn" disabled={!collection.active || !collection.broadcastPaused || releaseConfirmation !== "RELEASE BROADCAST"} onClick={() => void releaseBroadcast()}>{busy === "release" ? "Releasing…" : "Release project control"}</button></div>
          </div>
        </section>

        <section className="panel studio-section">
          <div className="studio-section-head"><span className="studio-step">7</span><div><h2>Wallet readiness and schedule</h2><p>Every selected wallet must pass definition, RPC, controls, eligibility, funds, nonce, and execution-state checks.</p></div></div>
          <div className="studio-inline"><div className="field"><label>Quantity</label><input type="number" min={1} max={100} value={quantity} onChange={(event) => { setQuantity(Number(event.target.value)); setReadiness(null); }} /></div><button className="secondary-btn" onClick={() => setSelectedWalletIds(new Set(compatibleWallets.map((item) => item.id)))}>Select compatible</button><button className="primary-btn" disabled={!selectedWalletIds.size} onClick={() => void runReadiness()}>{busy === "readiness" ? "Checking…" : `Check ${selectedWalletIds.size} wallet${selectedWalletIds.size === 1 ? "" : "s"}`}</button></div>
          <div className="studio-wallets">{compatibleWallets.map((wallet) => <label key={wallet.id} className="studio-wallet"><input type="checkbox" checked={selectedWalletIds.has(wallet.id)} onChange={() => { setSelectedWalletIds((current) => { const next = new Set(current); if (next.has(wallet.id)) next.delete(wallet.id); else next.add(wallet.id); return next; }); setReadiness(null); }} /><span><strong>{wallet.label}</strong><small>{wallet.role} · {short(wallet.address)}</small></span></label>)}</div>
          {readiness && <div className="studio-readiness">{readiness.wallets.map((row) => <details key={row.walletId} open={row.status === "blocked"}><summary><span>{row.label}</span><span className={`studio-badge ${row.status}`}>{row.status}</span><code>{row.phaseId || "no phase"}</code></summary><ul>{row.checks.map((check) => <li key={check.key} className={check.status === "pass" ? "ok" : check.status === "fail" ? "failed" : "muted"}><strong>{check.key}</strong> — {check.detail}</li>)}</ul></details>)}</div>}
          <div className="studio-schedule">
            <label className="studio-mode"><input type="radio" checked={dryRun} onChange={() => { setDryRun(true); setScheduleConfirmation(""); }} /><span><strong>Dry run</strong><small>Default. Simulate without broadcasting.</small></span></label>
            <label className="studio-mode"><input type="radio" checked={!dryRun} onChange={() => setDryRun(false)} /><span><strong>Live tasks</strong><small>Requires all production gates and project controls.</small></span></label>
            {!dryRun && <div className="field"><label>Type SCHEDULE LIVE</label><input value={scheduleConfirmation} onChange={(event) => setScheduleConfirmation(event.target.value)} /></div>}
            <button className="primary-btn" disabled={!scheduleReady || (!dryRun && scheduleConfirmation !== "SCHEDULE LIVE")} onClick={() => void scheduleTasks()}>{busy === "schedule" ? "Scheduling…" : dryRun ? "Create pinned dry run" : "Create pinned live tasks"}</button>
            {!scheduleReady && <p className="studio-footnote">Run readiness after selecting wallets. Every selected row must be ready and resolve to an exact phase.</p>}
          </div>
        </section>
      </>}
    </fieldset>
  </div>;
}
