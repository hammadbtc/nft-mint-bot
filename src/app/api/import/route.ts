import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/db";
import { addToSafetyList } from "@/lib/engine/safety";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (!body.collections && !body.safetyList && !body.config) {
      return NextResponse.json({ error: "No importable data found" }, { status: 400 });
    }

    let imported = { collections: 0, safetyList: 0, config: 0 };

    // Import collections
    if (Array.isArray(body.collections)) {
      for (const col of body.collections) {
        if (!col.name || !col.contractAddress || !col.chainId || !col.mintMethod || !col.mintAbi) continue;

        const { v4: uuidv4 } = await import("uuid");
        const id = uuidv4();

        try {
          await db.insert(schema.collections).values({
            id,
            name: col.name,
            contractAddress: col.contractAddress,
            chainId: col.chainId,
            mintMethod: col.mintMethod,
            mintAbi: typeof col.mintAbi === "string" ? col.mintAbi : JSON.stringify(col.mintAbi),
            mintPrice: col.mintPrice?.toString() || null,
            maxPerWallet: col.maxPerWallet || null,
            maxSupply: col.maxSupply || null,
            paymentToken: col.paymentToken || null,
            defaultGasLimit: col.defaultGasLimit || null,
            defaultMaxFeePerGas: col.defaultMaxFeePerGas || null,
            defaultMaxPriorityFeePerGas: col.defaultMaxPriorityFeePerGas || null,
            defaultUseFlashbots: col.defaultUseFlashbots ?? false,
            fcfsEnabled: col.fcfsEnabled ?? false,
            fcfsMintOpenSignature: col.fcfsMintOpenSignature || null,
            safetyCheck: col.safetyCheck ?? true,
          });
          imported.collections++;
        } catch { /* duplicate, skip */ }
      }
    }

    // Import safety list
    if (Array.isArray(body.safetyList)) {
      for (const s of body.safetyList) {
        if (!s.address || !s.list) continue;
        try {
          await addToSafetyList(s.address, s.list, s.note);
          imported.safetyList++;
        } catch { /* skip */ }
      }
    }

    // Import config
    if (Array.isArray(body.config)) {
      for (const c of body.config) {
        if (!c.key || c.value === "<redacted>") continue;
        try {
          await db
            .insert(schema.appConfig)
            .values({ key: c.key, value: c.value })
            .onConflictDoUpdate({
              target: schema.appConfig.key,
              set: { value: c.value, updatedAt: new Date().toISOString() },
            });
          imported.config++;
        } catch { /* skip */ }
      }
    }

    return NextResponse.json({ success: true, imported });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
