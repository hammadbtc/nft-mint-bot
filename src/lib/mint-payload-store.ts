import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { stableHash, stableJson } from "@/lib/safety";
import { decryptSecret, encryptSecret } from "@/lib/vault/crypto";

const storedPayloadSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: z.string().regex(/^\d+$/),
  chainId: z.number().int().positive(),
});

export type StoredMintPayload = z.infer<typeof storedPayloadSchema>;

export function normalizeMintPayload(request: ethers.TransactionRequest): StoredMintPayload {
  if (typeof request.to !== "string" || !ethers.isAddress(request.to)) throw new Error("Mint payload target is invalid");
  if (typeof request.data !== "string" || !ethers.isHexString(request.data)) throw new Error("Mint payload calldata is invalid");
  const chainId = Number(request.chainId);
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("Mint payload chain is invalid");
  return storedPayloadSchema.parse({
    to: request.to,
    data: request.data,
    value: BigInt(request.value || 0).toString(),
    chainId,
  });
}

export function deserializeMintPayload(serialized: string, expectedHash: string): ethers.TransactionRequest {
  const parsed = storedPayloadSchema.parse(JSON.parse(serialized));
  if (stableHash(parsed) !== expectedHash) throw new Error("Stored mint payload failed its integrity check");
  return { ...parsed, value: BigInt(parsed.value) };
}

function walletAddressHash(address: string): string {
  return stableHash(address.toLowerCase());
}

export async function persistMintPayload(input: {
  collectionId: string;
  definitionHash: string;
  walletAddress: string;
  phaseId: string;
  quantity: number;
  expiresAt: string;
  request: ethers.TransactionRequest;
}): Promise<void> {
  const payload = normalizeMintPayload(input.request);
  const serialized = stableJson(payload);
  const now = new Date().toISOString();
  const values = {
    id: crypto.randomUUID(),
    collectionId: input.collectionId,
    definitionHash: input.definitionHash,
    walletAddressHash: walletAddressHash(input.walletAddress),
    phaseId: input.phaseId,
    quantity: input.quantity,
    encryptedPayload: encryptSecret(serialized),
    payloadHash: stableHash(payload),
    expiresAt: input.expiresAt,
    updatedAt: now,
  };
  await db.insert(schema.mintPayloadArtifacts).values(values).onConflictDoUpdate({
    target: [
      schema.mintPayloadArtifacts.collectionId,
      schema.mintPayloadArtifacts.definitionHash,
      schema.mintPayloadArtifacts.walletAddressHash,
      schema.mintPayloadArtifacts.phaseId,
      schema.mintPayloadArtifacts.quantity,
    ],
    set: {
      encryptedPayload: values.encryptedPayload,
      payloadHash: values.payloadHash,
      expiresAt: values.expiresAt,
      updatedAt: now,
    },
  });
}

export async function loadMintPayload(input: {
  collectionId: string;
  definitionHash: string;
  walletAddress: string;
  phaseId: string;
  quantity: number;
}): Promise<{ expiresAt: number; request: ethers.TransactionRequest } | null> {
  const [artifact] = await db.select().from(schema.mintPayloadArtifacts).where(and(
    eq(schema.mintPayloadArtifacts.collectionId, input.collectionId),
    eq(schema.mintPayloadArtifacts.definitionHash, input.definitionHash),
    eq(schema.mintPayloadArtifacts.walletAddressHash, walletAddressHash(input.walletAddress)),
    eq(schema.mintPayloadArtifacts.phaseId, input.phaseId),
    eq(schema.mintPayloadArtifacts.quantity, input.quantity),
  )).limit(1);
  if (!artifact) return null;
  const expiresAt = Date.parse(artifact.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  const serialized = decryptSecret(artifact.encryptedPayload);
  return { expiresAt, request: deserializeMintPayload(serialized, artifact.payloadHash) };
}
