import { NextRequest, NextResponse } from "next/server";
import { inArray, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { getMintAdapter } from "@/lib/adapters";
import { inspectWalletPhases } from "@/lib/phase-planning";
import { selectEligibleExecutionPhase } from "@/lib/mint-policy";
import { safeErrorMessage } from "@/lib/safety";
import { getProvider } from "@/lib/chains";
import { getSigner } from "@/lib/vault";
import { isOpenSeaRateLimitError } from "@/lib/opensea-auth";
import { OperationTimeoutError, withTimeout } from "@/lib/async-timeout";
import { executionManifestFor } from "@/lib/engines";

// A cold deployment may need to establish narrowly-scoped OpenSea sessions
// for many vault wallets. OpenSea deliberately rate-limits SIWE nonces, so let
// the bounded server queue finish instead of falsely returning unknown at 30s.
const WALLET_ELIGIBILITY_TIMEOUT_MS = 180_000;

const inputSchema = z.object({
  collectionId: z.string().uuid(),
  walletIds: z.array(z.string().uuid()).min(1).max(500),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
});

export async function POST(req: NextRequest) {
  try {
    const input = inputSchema.parse(await req.json());
    const walletIds = [...new Set(input.walletIds)];
    const [[collection], wallets] = await Promise.all([
      db.select().from(schema.collections).where(eq(schema.collections.id, input.collectionId)).limit(1),
      db.select().from(schema.wallets).where(inArray(schema.wallets.id, walletIds)),
    ]);
    if (!collection?.active || !collection.verified) throw new Error("Mint support is disabled or unavailable");
    if (wallets.length !== walletIds.length) throw new Error("One or more wallets were not found");
    const adapter = getMintAdapter(collection.adapterKey);
    if (!adapter) throw new Error("The reviewed mint adapter is unavailable");
    const phases = (await adapter.resolve(collection, "name")).phases;
    const manifest = executionManifestFor(collection);
    const transactionQuantity = manifest.onePerTransaction ? 1 : input.quantity;
    if (manifest.onePerTransaction && input.quantity > (manifest.maxPreparedTransactions || 1)) {
      throw new Error(`This mint supports at most ${manifest.maxPreparedTransactions || 1} sequential transactions per wallet`);
    }
    // Preserve the caller's order (the UI puts main wallets first). PostgreSQL
    // does not guarantee IN(...) result order, and cold OpenSea enrollment is
    // intentionally paced.
    const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));
    const orderedWallets = walletIds.map((id) => walletById.get(id)!);
    const results = await Promise.all(orderedWallets.map(async (wallet) => {
      const walletError = !wallet.active ? "Wallet is inactive" : undefined;
      if (walletError) return { walletId: wallet.id, eligible: false, reason: walletError, phases: [] };
      try {
        const signer = adapter.requiresSignerForEligibility
          ? await getSigner(wallet.id, getProvider(collection.chainId))
          : undefined;
        const plan = await withTimeout(
          inspectWalletPhases(collection, wallet.address, transactionQuantity, phases, { signer }),
          WALLET_ELIGIBILITY_TIMEOUT_MS,
          "OpenSea eligibility check timed out",
        );
        const displayedPhases = plan.phases.map((phase) => {
          const result = plan.eligibility.find((item) => item.phaseId === phase.id);
          return {
            ...phase,
            eligibility: result ? { phaseId: result.phaseId, status: result.status, reason: result.reason } : undefined,
          };
        });
        const unavailable = plan.eligibility.find((item) => ["unknown", "unsupported"].includes(item.status));
        try {
          const selectedPhase = selectEligibleExecutionPhase(plan.phases, plan.eligibility);
          return { walletId: wallet.id, eligible: true, selectedPhaseId: selectedPhase.id, selectedPhaseName: selectedPhase.name, scheduledAt: selectedPhase.status === "upcoming" ? selectedPhase.startsAt || null : null, phases: displayedPhases };
        } catch (error) {
          return {
            walletId: wallet.id,
            eligible: false,
            verificationUnavailable: Boolean(unavailable),
            reason: unavailable?.reason || safeErrorMessage(error, "No runnable phase"),
            phases: displayedPhases,
          };
        }
      } catch (error) {
        const timedOut = error instanceof OperationTimeoutError;
        return {
          walletId: wallet.id,
          eligible: false,
          verificationUnavailable: timedOut || isOpenSeaRateLimitError(error),
          reason: timedOut
            ? "OpenSea wallet authentication is still processing — retry after a few seconds"
            : isOpenSeaRateLimitError(error)
            ? "OpenSea rate limited the check — retrying shortly"
            : safeErrorMessage(error, "Eligibility could not be verified"),
          phases: [],
        };
      }
    }));
    return NextResponse.json({ phases, wallets: results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not check phase eligibility");
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
