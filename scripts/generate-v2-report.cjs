const PDFDocument = require("pdfkit");
const fs = require("node:fs");
const path = require("node:path");

const output = path.resolve(__dirname, "../reports/MintBot_Mega_Plan_V2_Before_After.pdf");
fs.mkdirSync(path.dirname(output), { recursive: true });
const doc = new PDFDocument({ size: "A4", margins: { top: 46, bottom: 44, left: 48, right: 48 }, info: {
  Title: "MintBot Mega Plan V2 — Before/After Engineering Report",
  Author: "Agent69",
  Subject: "MintBot execution-engine rebuild and production audit",
} });
doc.pipe(fs.createWriteStream(output));

const C = { navy: "#101B33", blue: "#316BFF", cyan: "#24C7D9", ink: "#172033", muted: "#657087", pale: "#F1F5FA", green: "#148A64", red: "#B6404A", line: "#DCE4EF", white: "#FFFFFF" };
const W = 499;
const pageBottom = 760;

function footer() {
  const n = doc.bufferedPageRange().count;
  doc.font("Helvetica").fontSize(7).fillColor(C.muted).text(`MintBot Mega Plan V2  •  Release 3f23d06  •  Page ${n}`, 48, 786, { width: W, align: "center", lineBreak: false });
}
function newPage() { footer(); doc.addPage(); }
function ensure(h = 50) { if (doc.y + h > pageBottom) newPage(); }
function h1(text) { ensure(50); doc.moveDown(.45).font("Helvetica-Bold").fontSize(20).fillColor(C.navy).text(text); doc.moveDown(.35); }
function h2(text) { ensure(35); doc.moveDown(.65).font("Helvetica-Bold").fontSize(12.5).fillColor(C.blue).text(text.toUpperCase(), { characterSpacing: .35 }); doc.moveDown(.28); }
function p(text, opts = {}) { ensure(35); doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size || 9).fillColor(opts.color || C.ink).text(text, { width: W, lineGap: 2.1, ...opts }); doc.moveDown(.55); }
function bullet(text, color = C.blue) { ensure(24); const y = doc.y + 4; doc.circle(53, y, 2).fill(color); doc.font("Helvetica").fontSize(8.7).fillColor(C.ink).text(text, 63, doc.y, { width: W - 15, lineGap: 1.7 }); doc.moveDown(.34); }
function callout(title, text, color = C.blue) { ensure(85); const y = doc.y; const h = doc.heightOfString(text, { width: W - 30, lineGap: 2 }) + 45; doc.roundedRect(48, y, W, h, 6).fill(C.pale); doc.font("Helvetica-Bold").fontSize(9.5).fillColor(color).text(title.toUpperCase(), 63, y + 13, { width: W - 30 }); doc.font("Helvetica").fontSize(8.7).fillColor(C.ink).text(text, 63, y + 31, { width: W - 30, lineGap: 2 }); doc.y = y + h + 8; }
function metric(value, label, x, y, width, color = C.blue) { doc.roundedRect(x, y, width, 59, 5).fill(C.pale); doc.font("Helvetica-Bold").fontSize(18).fillColor(color).text(value, x + 10, y + 10, { width: width - 20, align: "center" }); doc.font("Helvetica").fontSize(7.3).fillColor(C.muted).text(label.toUpperCase(), x + 8, y + 36, { width: width - 16, align: "center", characterSpacing: .3 }); }
function row(left, right, y, leftW = 145) { const rightW = W - leftW; const lh = Math.max(doc.heightOfString(left, { width: leftW - 16 }), doc.heightOfString(right, { width: rightW - 16 })) + 16; doc.rect(48, y, leftW, lh).fill(C.pale); doc.rect(48 + leftW, y, rightW, lh).fill("#FAFCFF"); doc.font("Helvetica-Bold").fontSize(8).fillColor(C.navy).text(left, 56, y + 8, { width: leftW - 16 }); doc.font("Helvetica").fontSize(8).fillColor(C.ink).text(right, 56 + leftW, y + 8, { width: rightW - 16, lineGap: 1.3 }); return y + lh; }

doc.rect(0, 0, 595, 842).fill(C.navy);
doc.roundedRect(48, 62, 118, 24, 12).fill(C.blue);
doc.font("Helvetica-Bold").fontSize(8).fillColor(C.white).text("PRODUCTION RELEASE", 48, 70, { width: 118, align: "center", characterSpacing: .6 });
doc.font("Helvetica-Bold").fontSize(31).fillColor(C.white).text("MINTBOT", 48, 142);
doc.font("Helvetica-Bold").fontSize(31).fillColor(C.cyan).text("MEGA PLAN V2", 48, 180);
doc.font("Helvetica").fontSize(13).fillColor("#CCD7ED").text("Before / After Engineering Report", 48, 230);
doc.moveTo(48, 276).lineTo(547, 276).lineWidth(1).stroke("#34425F");
doc.font("Helvetica").fontSize(10).fillColor("#AEBBD3").text("From safety-first web scheduler to reusable low-latency launch engine", 48, 302, { width: 430, lineGap: 3 });
metric("107/107", "Automated tests", 48, 414, 150, C.cyan);
metric("0", "Known vulnerabilities", 222, 414, 150, C.green);
metric("HTTP 200", "Production health", 396, 414, 151, C.cyan);
doc.font("Helvetica").fontSize(8.5).fillColor("#AEBBD3").text("Release 3f23d06  •  Verified 18 August 2026, 03:50 UTC  •  Prepared for Hammad", 48, 748, { width: W });
newPage();

h1("Executive result");
p("MintBot has moved from a safety-first web scheduler into a reusable launch engine. Deterministic work now happens before opening; stealth launches wake from a provider WebSocket; exact signed bytes go sequencer-first; same-wallet sequences use atomic nonce ladders; and every important stage is measured and recoverable.");
callout("The honest promise", "V2 cannot guarantee a mint. FCFS competition, provider failures, launchpad throttling, contract changes and supply races still exist. V2 removes known self-inflicted delays and makes every miss explainable.", C.green);
h2("Incident baseline");
p("Terminal Assistants opened at 16:03:45 UTC and sold out at 16:04:52 UTC — a 67-second window. The previous path could spend 2.5 seconds before detecting the owner switch, repeat multi-block checks, estimate and simulate during the race, serialize five same-wallet jobs, and wait on receipts.");
p("Disperse accepted operations into PostgreSQL but exposed only “queued.” Its old 1.25× fee ceiling could reject an operation after review, failures were hard to see, and funding competed with mint execution.");
h2("Release evidence");
bullet("Production exact version: 3f23d06; PostgreSQL connected; execution worker healthy.", C.green);
bullet("Robinhood provider WebSocket configured, connected, processing fresh blocks, zero reconnects at verification.", C.green);
bullet("Zero armed jobs, zero launch timers, zero missing launch timers at deployment verification.", C.green);
bullet("No transaction was created, queued, signed or broadcast during verification.", C.green);

newPage(); h1("Architecture: before and now");
let y = doc.y;
y = row("BEFORE", "Web request / 250ms scheduler → resolve phase → repeated contract reads → estimate gas → simulate → balance check → reserve one nonce → sign → persist → provider broadcast → receipt wait → next task", y);
y = row("NOW: BEFORE LAUNCH", "Validated engine manifest → exact eligibility/intent → payload warmup → reviewed gas policy → balance/spend limit → atomic nonce reservation → durable signed bytes/hash → route warmup → final revalidation", y);
y = row("NOW: AT LAUNCH", "Precise timer or WebSocket signal → one pinned-state snapshot → direct sequencer submission → identical bytes to independent fallbacks → submit nonce N+1 without waiting for receipt N", y);
y = row("NOW: AFTER", "Route telemetry → exact-hash reconciliation → receipt confirmation → supply-aware suppression → incident replay", y);
doc.y = y + 8;
h2("Reusable engines");
bullet("scheduled-public-v1 — deterministic public calldata, durable pre-arm and precise timer.");
bullet("scheduled-server-signed-v1 — authenticated eligibility and wallet-bound payload warming.");
bullet("stealth-owner-switch-v1 — event-driven wakeup, pinned state and optional nonce ladder.");
bullet("custom-reviewed-v1 — explicit, reviewed fallback; never arbitrary ABI guessing.");
callout("Session reset solved", "New projects select a tested engine and supply a reviewed manifest. Transaction policy, safety checks, nonce handling, broadcast, retry and telemetry are reusable code—not chat memory.");

newPage(); h1("Launch-path improvements");
h2("Scheduled public");
bullet("Exact transaction intent and gas prepared before opening.");
bullet("Nonce reserved and signed bytes stored durably.");
bullet("Final target/data/value/signer/nonce/eligibility revalidation five seconds before opening.");
bullet("In-process precise timer never intentionally fires early.");
h2("Signed tiers / OpenSea");
bullet("Wallet authentication and eligibility are warmed before the race.");
bullet("Provider payload is fetched early when permitted and fully validated against chain, target, NFT, recipient, quantity, stage, price, limits, fees and signature.");
bullet("If early construction is refused, the task stays scheduled and uses a safe just-in-time fallback.");
h2("Stealth owner-switch");
bullet("Standard provider WebSocket new-head signal wakes the worker immediately.");
bullet("A 250ms HTTP readiness probe remains as bounded fallback.");
bullet("One pinned block supplies open state, supply and wallet allowance; mixed-height snapshots fail closed.");
bullet("Reviewed gas limit avoids launch-time estimate calls; exact simulation and final contract-specific validation remain.");
h2("Five one-per-transaction mints");
bullet("Operator chooses “5 sequential transactions” once on a dedicated worker wallet.");
bullet("PostgreSQL atomically reserves contiguous nonces and persists all signed payloads.");
bullet("All safe entries submit without waiting for previous receipts; excess entries are suppressed before signing.");

newPage(); h1("Broadcast, telemetry and recovery");
h2("Sequencer-first routing");
p("Robinhood Chain documents first-come, first-served ordering. V2 submits exact signed bytes to the direct sequencer first, then races the identical hash through configured Alchemy, dRPC, QuickNode, Chainstack and public fallback routes. Identical nonce and bytes cannot create duplicate mints.");
h2("Per-stage telemetry");
bullet("Open detection, phase resolution, payload acquisition and gas preparation.");
bullet("Simulation, final revalidation, signing, broadcast and receipt reconciliation.");
bullet("Monotonic duration plus wall-clock correlation; p50/p95 summaries.");
bullet("Route label/status/latency without endpoint URL or credential storage.");
h2("Restart safety");
bullet("Signed bytes and precomputed hash are persisted before broadcast.");
bullet("Ambiguous provider outcomes reconcile by hash; retries rebroadcast the same bytes only.");
bullet("Confirmed success requires a status-1 receipt.");
bullet("Worker heartbeat persists timer counts and watcher health across web/worker boundaries.");
callout("Health fails visibly", "Dead worker, stale watcher, missing launch timer, stale lease, unhealthy RPC and degraded broadcast routes now appear in health/status instead of becoming silent misses.", C.red);

newPage(); h1("Disperse and sweep repair");
h2("What changed");
bullet("Mint and Disperse have independent execution lanes.");
bullet("Reviewed fee ceiling is 3× the preview quote; actual gas paid remains effective gas used.");
bullet("Funding from one main wallet uses an atomic nonce ladder and does not wait for each receipt before submitting the next transfer.");
bullet("Sweeps execute concurrently across independent worker nonce domains.");
bullet("UI shows operation and transfer status, error, amount, nonce, hash, explorer link, block and confirmation.");
bullet("Safe retry exists only for failed transfers with no nonce, no signed bytes and no transaction hash.");
h2("Bulk-contract policy");
p("Bulk-contract execution is gated by an approved chain/address, independent audit URL, verified-source URL and exact runtime bytecode hash. No Robinhood bulk contract is currently approved, so no unknown contract can activate or receive funds. The production fallback is the reviewed native-transfer nonce ladder.");
callout("Duplicate-payment boundary", "Prepared or submitted work is immutable and reconciled by exact hash. It is never converted into a new transfer under a fresh nonce.", C.green);

newPage(); h1("Verification and replay");
h2("Release checks");
bullet("107 automated tests passed; 0 failed.", C.green);
bullet("ESLint, strict TypeScript, optimized Next.js build and standalone assets passed.", C.green);
bullet("Drizzle schema check and production schema push passed.", C.green);
bullet("Full dependency tree valid; npm audit reports 0 vulnerabilities.", C.green);
bullet("CI now repeats install, test, lint, build, schema check and full audit on every main push/PR.", C.green);
h2("Historical Terminal replay");
p("The deterministic fixture replays 16:03:45–16:04:52 UTC. V2 budgets 80ms signal delay, 80ms pinned state, 60ms fee read, 70ms simulation, 25ms ladder signing and 70ms sequencer acknowledgement: 385ms from opening. The test fails above 500ms or when snapshot reads use inconsistent blocks.");
metric("385 ms", "Modeled V2 launch path", 48, doc.y + 10, 150, C.cyan);
metric("67 sec", "Historical sellout window", 222, doc.y + 10, 150, C.blue);
metric("0", "Launch-time DB discovery for armed public", 396, doc.y + 10, 151, C.green);
doc.y += 86;
h2("Operational constraints");
bullet("No FCFS bot can guarantee inclusion.", C.red);
bullet("Nonce-ladder wallets must not be used manually during the launch.", C.red);
bullet("Current Railway uses combined compatibility mode; dedicated web and worker roles are implemented and recommended when a second service is provisioned.", C.red);
bullet("No bulk contract is active until an independent audit and verified deployment are approved.", C.red);

newPage(); h1("Final assessment");
callout("What V2 means", "Prepare everything safely before the race. React through the fastest reviewed signal. Submit through the direct ordering endpoint. Explain every millisecond. Never duplicate or silently send funds.", C.blue);
p("MintBot no longer loses seconds to avoidable sleeps and duplicated reads; no longer waits for receipt N before submitting nonce N+1; no longer hides Disperse errors; and no longer relies on conversation memory to classify known mint types.");
p("The result is a reusable, observable, restart-safe transaction engine with explicit safety boundaries. The next infrastructure-only improvement is provisioning a separate Railway worker service so web traffic and deployments cannot share CPU/event-loop resources with launches.");
h2("Primary technical references");
p("Robinhood endpoints  •  docs.robinhood.com/chain/connecting/", { color: C.blue });
p("Robinhood FCFS ordering  •  docs.robinhood.com/chain/", { color: C.blue });
p("Robinhood sequencer feed / full node  •  docs.robinhood.com/chain/run-a-full-node/", { color: C.blue });
p("Ethereum JSON-RPC  •  ethereum.org/developers/docs/apis/json-rpc/", { color: C.blue });
p("OpenSea drop mint API  •  docs.opensea.io/docs/mint-from-a-drop", { color: C.blue });
doc.moveDown(1.5); doc.moveTo(48, doc.y).lineTo(547, doc.y).stroke(C.line); doc.moveDown(1);
p("Production release: 3f23d06  •  Generated 18 August 2026  •  Agent69", { size: 8, color: C.muted });

footer();
doc.end();
doc.on("end", () => console.log(output));
