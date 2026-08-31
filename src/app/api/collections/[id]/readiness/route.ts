import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ethers } from "ethers";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { getMintAdapter } from "@/lib/adapters";
import { checkRpcHealth, getProvider } from "@/lib/chains";
import { getSigner } from "@/lib/vault";
import { inspectWalletPhases } from "@/lib/phase-planning";
import { mintWalletEligibilityError } from "@/lib/mint-wallet-policy";
import { scheduleMintDefinition } from "@/lib/mint-definitions";
import { summarizeReadiness, type ReadinessCheck } from "@/lib/mint-readiness";
import { liveTransactionsEnabled, safeErrorMessage, safeSecretEqual } from "@/lib/safety";
import { signedTransactionIsSealed } from "@/lib/signed-transaction-vault";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };
const inputSchema = z.object({ walletIds: z.array(z.string().uuid()).min(1).max(100), quantity: z.number().int().min(1).max(100).default(1) }).strict();
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const expected = process.env.SUPPORT_ADMIN_TOKEN || "";
    if (!expected || !safeSecretEqual(req.headers.get("x-support-admin-token") || "", expected)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id } = await params;
    const input = inputSchema.parse(await req.json());
    const [[collection], wallets] = await Promise.all([
      db.select().from(schema.collections).where(eq(schema.collections.id, id)).limit(1),
      db.select().from(schema.wallets).where(inArray(schema.wallets.id, [...new Set(input.walletIds)])),
    ]);
    if (!collection) throw new Error("Mint collection was not found");
    if (wallets.length !== new Set(input.walletIds).size) throw new Error("One or more wallets were not found");
    const adapter = getMintAdapter(collection.adapterKey);
    if (!adapter) throw new Error("Reviewed mint adapter is unavailable");
    const provider = getProvider(collection.chainId);
    const parentIds = [...new Set(wallets.flatMap((wallet) => wallet.parentWalletId ? [wallet.parentWalletId] : []))];
    const [parents, jobs, rpc, definitionResult, phases, phaseControls, feeData] = await Promise.all([
      parentIds.length ? db.select().from(schema.wallets).where(inArray(schema.wallets.id, parentIds)) : [],
      db.select().from(schema.mintJobs).where(and(eq(schema.mintJobs.collectionId, id), inArray(schema.mintJobs.walletId, wallets.map((wallet) => wallet.id)), inArray(schema.mintJobs.status, ["pending", "armed", "running", "confirming"]))),
      checkRpcHealth(collection.chainId),
      scheduleMintDefinition(collection).then(() => ({ ok: true as const })).catch((error) => ({ ok: false as const, error: safeErrorMessage(error) })),
      adapter.resolve(collection, "name").then((value) => value.phases),
      db.select().from(schema.mintPhaseControls).where(eq(schema.mintPhaseControls.collectionId, id)),
      provider.getFeeData(),
    ]);
    const attempts = jobs.length ? await db.select().from(schema.mintAttempts)
      .where(inArray(schema.mintAttempts.jobId, jobs.map((job) => job.id)))
      .orderBy(desc(schema.mintAttempts.createdAt)) : [];
    const parentById = new Map(parents.map((item) => [item.id, item]));
    const phaseControlById = new Map(phaseControls.map((item) => [item.phaseId, item]));
    const healthyRoutes = rpc.filter((item) => item.status === "up").length;
    const requiredHealthyRoutes = liveTransactionsEnabled() ? 2 : 1;
    const rows = await Promise.all(wallets.map(async (wallet) => {
      const checks: ReadinessCheck[] = [];
      checks.push({ key: "definition", status: definitionResult.ok ? "pass" : "fail", detail: definitionResult.ok ? "Active definition has a valid hash-bound certificate" : definitionResult.error });
      checks.push({ key: "controls", status: collection.active && collection.verified && !collection.broadcastPaused ? "pass" : "fail", detail: collection.broadcastPaused ? collection.broadcastPauseReason || "Broadcasting is paused" : collection.active && collection.verified ? "Collection controls released" : "Collection support is disabled" });
      checks.push({ key: "rpc", status: healthyRoutes >= requiredHealthyRoutes ? "pass" : "fail", detail: `${healthyRoutes}/${rpc.length} RPC routes healthy; ${requiredHealthyRoutes} required` });
      const policyError = mintWalletEligibilityError(wallet, collection.chainId, wallet.parentWalletId ? parentById.get(wallet.parentWalletId) : undefined);
      checks.push({ key: "wallet-policy", status: policyError ? "fail" : "pass", detail: policyError || `${wallet.role} wallet is active on chain ${wallet.chainId}` });
      let selectedPhase: (typeof phases)[number] | undefined;
      if (!policyError) {
        try {
          const signer = adapter.requiresSignerForEligibility ? await getSigner(wallet.id, provider) : undefined;
          const inspected = await inspectWalletPhases(collection, wallet.address, input.quantity, phases, { signer });
          selectedPhase = inspected.phases.find((phase) => phase.status === "live" && inspected.eligibility.find((item) => item.phaseId === phase.id)?.status === "eligible")
            || inspected.phases.find((phase) => phase.status === "upcoming" && inspected.eligibility.find((item) => item.phaseId === phase.id)?.status === "eligible");
          const eligibility = selectedPhase ? inspected.eligibility.find((item) => item.phaseId === selectedPhase!.id) : undefined;
          checks.push({ key: "eligibility", status: selectedPhase ? "pass" : "fail", detail: selectedPhase ? `Eligible for ${selectedPhase.name}${eligibility?.artifactHash ? " with a pinned artifact" : ""}` : "No live or upcoming phase has proven eligibility" });
          const phaseControl = selectedPhase ? phaseControlById.get(selectedPhase.id) : undefined;
          checks.push({ key: "phase-control", status: phaseControl?.paused ? "fail" : "pass", detail: phaseControl?.paused ? phaseControl.reason || `${selectedPhase?.name || "Selected phase"} is paused` : "Selected phase broadcasting is released" });
          if (eligibility?.artifactExpiresAt) checks.push({ key: "artifact-expiry", status: !selectedPhase?.startsAt || Date.parse(eligibility.artifactExpiresAt) > Date.parse(selectedPhase.startsAt) ? "pass" : "fail", detail: `Eligibility artifact expires ${eligibility.artifactExpiresAt}` });
        } catch (error) {
          checks.push({ key: "eligibility", status: "fail", detail: safeErrorMessage(error, "Eligibility check failed") });
        }
      }
      const balance = await provider.getBalance(wallet.address).catch(() => null);
      const mintValue = !collection.paymentToken && selectedPhase?.priceWei ? BigInt(selectedPhase.priceWei) * BigInt(input.quantity) : 0n;
      if (collection.paymentToken) {
        const tokenRequired = selectedPhase?.priceWei ? BigInt(selectedPhase.priceWei) * BigInt(input.quantity) : null;
        const tokenBalance = await new ethers.Contract(collection.paymentToken, ERC20_BALANCE_ABI, provider)
          .getFunction("balanceOf").staticCall(wallet.address).then(BigInt).catch(() => null);
        checks.push({
          key: "payment-token-balance",
          status: tokenRequired != null && tokenRequired > 0n && tokenBalance != null && tokenBalance >= tokenRequired ? "pass" : "fail",
          detail: tokenRequired == null || tokenRequired <= 0n ? "Selected payment-token phase has no exact positive unit price"
            : tokenBalance == null ? "Payment-token balance could not be read"
              : `${tokenBalance.toString()} token base units available; ${tokenRequired.toString()} required`,
        });
      }
      const walletJobs = jobs.filter((job) => job.walletId === wallet.id);
      const phaseJobs = selectedPhase ? walletJobs.filter((job) => job.phaseId === selectedPhase.id) : walletJobs;
      const selectedJob = phaseJobs.find((job) => job.status === "armed") || phaseJobs[0];
      const gasLimitRaw = selectedJob?.gasLimit || collection.defaultGasLimit || adapter.recommendedGasLimit?.toString();
      const feeRaw = selectedJob?.maxFeePerGas || feeData.maxFeePerGas?.toString() || feeData.gasPrice?.toString();
      const gasReserve = gasLimitRaw && feeRaw ? BigInt(gasLimitRaw) * BigInt(feeRaw) : null;
      const requiredBalance = gasReserve == null ? null : mintValue + gasReserve;
      checks.push({
        key: "native-balance",
        status: balance == null || requiredBalance == null || balance < requiredBalance ? "fail" : "pass",
        detail: balance == null ? "Native balance could not be read"
          : requiredBalance == null ? "Exact mint gas reserve could not be calculated"
            : `${ethers.formatEther(balance)} available; up to ${ethers.formatEther(requiredBalance)} required including gas`,
      });
      checks.push({ key: "scheduled-job", status: walletJobs.length ? "pass" : "warn", detail: walletJobs.length ? `${walletJobs.length} active task(s): ${walletJobs.map((job) => `${job.phaseId || "unselected"}/${job.status}`).join(", ")}` : "No active task is scheduled for this wallet" });
      if (selectedJob?.status === "armed") {
        const attempt = attempts.find((item) => item.jobId === selectedJob.id && item.kind === "mint");
        const pendingNonce = await provider.getTransactionCount(wallet.address, "pending").catch(() => null);
        const armedValid = Boolean(attempt?.txHash && attempt.rawTx && signedTransactionIsSealed(attempt.rawTx) && attempt.nonce != null && pendingNonce === attempt.nonce);
        checks.push({ key: "execution-state", status: armedValid ? "pass" : "fail", detail: armedValid ? `Armed transaction ${attempt!.txHash!.slice(0, 10)}… is pinned at pending nonce ${pendingNonce}` : "Armed transaction, signed payload, or pending nonce is inconsistent" });
      } else {
        checks.push({ key: "execution-state", status: "warn", detail: selectedJob ? `${selectedJob.status} task has not produced an armed transaction yet` : "No selected task is armed" });
      }
      return { walletId: wallet.id, label: wallet.label, addressHash: ethers.keccak256(ethers.toUtf8Bytes(wallet.address.toLowerCase())), phaseId: selectedPhase?.id || null, checks, ...summarizeReadiness(checks) };
    }));
    return NextResponse.json({ collectionId: id, chainId: collection.chainId, quantity: input.quantity, rpc, wallets: rows, summary: { ready: rows.filter((row) => row.status === "ready").length, warning: rows.filter((row) => row.status === "warning").length, blocked: rows.filter((row) => row.status === "blocked").length } }, { headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not calculate mint readiness");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
