import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db";

export async function GET() {
  const wallets = await db.select().from(schema.wallets);
  const collections = await db.select().from(schema.collections);
  const safetyList = await db.select().from(schema.contractSafetyList);
  const config = await db.select().from(schema.appConfig);

  const exportData = {
    version: "2.0",
    exportedAt: new Date().toISOString(),
    wallets: wallets.map((w) => ({
      label: w.label,
      address: w.address,
      chainId: w.chainId,
      keyFormat: w.keyFormat,
      spendLimit: w.spendLimit,
      active: w.active,
    })),
    collections: collections.map((c) => ({
      name: c.name,
      contractAddress: c.contractAddress,
      chainId: c.chainId,
      mintMethod: c.mintMethod,
      mintAbi: c.mintAbi,
      mintPrice: c.mintPrice,
      maxPerWallet: c.maxPerWallet,
      maxSupply: c.maxSupply,
      paymentToken: c.paymentToken,
      defaultGasLimit: c.defaultGasLimit,
      defaultMaxFeePerGas: c.defaultMaxFeePerGas,
      defaultMaxPriorityFeePerGas: c.defaultMaxPriorityFeePerGas,
      defaultUseFlashbots: c.defaultUseFlashbots,
      fcfsEnabled: c.fcfsEnabled,
      fcfsMintOpenSignature: c.fcfsMintOpenSignature,
      safetyCheck: c.safetyCheck,
    })),
    safetyList: safetyList.map((s) => ({
      address: s.address,
      list: s.list,
      note: s.note,
    })),
    config: config.map((c) => {
      // Redact sensitive values
      if (["VAULT_PASSPHRASE", "ALCHEMY_API_KEY", "DISCORD_ALERT_WEBHOOK"].includes(c.key)) {
        return { key: c.key, value: "<redacted>" };
      }
      return { key: c.key, value: c.value };
    }),
  };

  // NOTE: Encrypted keys are intentionally NOT exported — they must be re-imported
  return NextResponse.json(exportData, {
    headers: {
      "Content-Disposition": "attachment; filename=mintbot-export.json",
    },
  });
}
