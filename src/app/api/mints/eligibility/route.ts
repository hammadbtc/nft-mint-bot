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
    const results = await Promise.all(wallets.map(async (wallet) => {
      const walletError = !wallet.active ? "Wallet is inactive" : wallet.chainId !== collection.chainId ? "Wallet is on a different chain" : undefined;
      if (walletError) return { walletId: wallet.id, eligible: false, reason: walletError, phases: [] };
      try {
        const signer = adapter.requiresSignerForEligibility
          ? await getSigner(wallet.id, getProvider(collection.chainId))
          : undefined;
        const plan = await inspectWalletPhases(collection, wallet.address, input.quantity, phases, { signer });
        const displayedPhases = plan.phases.map((phase) => ({ ...phase, eligibility: plan.eligibility.find((item) => item.phaseId === phase.id) }));
        try {
          const selectedPhase = selectEligibleExecutionPhase(plan.phases, plan.eligibility);
          return { walletId: wallet.id, eligible: true, selectedPhaseId: selectedPhase.id, selectedPhaseName: selectedPhase.name, scheduledAt: selectedPhase.status === "upcoming" ? selectedPhase.startsAt || null : null, phases: displayedPhases };
        } catch (error) {
          return { walletId: wallet.id, eligible: false, reason: safeErrorMessage(error, "No runnable phase"), phases: displayedPhases };
        }
      } catch (error) {
        return { walletId: wallet.id, eligible: false, reason: safeErrorMessage(error, "Eligibility could not be verified"), phases: [] };
      }
    }));
    return NextResponse.json({ phases, wallets: results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not check phase eligibility");
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
