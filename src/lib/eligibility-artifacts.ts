import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/vault/crypto";
import { stableHash, stableJson } from "@/lib/safety";
import type { ReviewedCallPhase } from "@/lib/reviewed-call-config";
import { resolveBindingValues, reviewedArtifactKeys } from "@/lib/reviewed-call-config";

const artifactSchema = z.record(z.string().min(1).max(100), z.unknown());
export type EligibilityArtifact = z.infer<typeof artifactSchema>;

export function hashWalletAddress(address: string): string {
  return stableHash(ethers.getAddress(address).toLowerCase());
}

function merkleLeaf(phase: ReviewedCallPhase, walletAddress: string, payload: EligibilityArtifact): string {
  if (phase.eligibility.strategy !== "merkle-proof-v1") throw new Error("Phase is not Merkle-gated");
  const values = resolveBindingValues(phase.eligibility.leaf.values, { wallet: walletAddress, quantity: 1, artifact: payload });
  const encoded = phase.eligibility.leaf.encoding === "packed"
    ? ethers.solidityPacked(phase.eligibility.leaf.types, values)
    : ethers.AbiCoder.defaultAbiCoder().encode(phase.eligibility.leaf.types, values);
  const once = ethers.keccak256(encoded);
  return phase.eligibility.leaf.doubleHash ? ethers.keccak256(once) : once;
}

function verifySortedMerkleProof(proof: string[], root: string, leaf: string): boolean {
  const computed = proof.reduce((node, sibling) => {
    const [left, right] = node.toLowerCase() <= sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    return ethers.keccak256(ethers.concat([left, right]));
  }, leaf);
  return computed.toLowerCase() === root.toLowerCase();
}

export function validateEligibilityArtifact(input: {
  phase: ReviewedCallPhase;
  walletAddress: string;
  payload: unknown;
}): EligibilityArtifact {
  const payload = artifactSchema.parse(input.payload);
  const required = reviewedArtifactKeys(input.phase);
  for (const key of required) if (!(key in payload)) throw new Error(`Eligibility artifact is missing ${key}`);
  for (const binding of input.phase.call.args) {
    if (binding.source !== "artifact") continue;
    try { ethers.AbiCoder.defaultAbiCoder().encode([binding.abiType], [payload[binding.key]]); }
    catch { throw new Error(`Eligibility artifact ${binding.key} cannot be encoded as ${binding.abiType}`); }
  }
  if (input.phase.eligibility.strategy === "public" || input.phase.eligibility.strategy === "token-balance-v1" || input.phase.eligibility.strategy === "onchain-bool-v1") {
    throw new Error("This eligibility strategy does not accept stored wallet artifacts");
  }
  if (input.phase.eligibility.strategy === "server-signature-v1") {
    const signature = payload[input.phase.eligibility.signatureKey];
    if (typeof signature !== "string" || !ethers.isHexString(signature) || ethers.dataLength(signature) < 64) {
      throw new Error("Server signature artifact is invalid");
    }
    const message = input.phase.eligibility.message;
    const values = resolveBindingValues(message.values, { wallet: input.walletAddress, quantity: 1, artifact: payload });
    const encoded = message.encoding === "packed"
      ? ethers.solidityPacked(message.types, values)
      : ethers.AbiCoder.defaultAbiCoder().encode(message.types, values);
    const digest = ethers.keccak256(encoded);
    const recovered = message.signing === "eip191"
      ? ethers.verifyMessage(ethers.getBytes(digest), signature)
      : ethers.recoverAddress(digest, signature);
    if (recovered.toLowerCase() !== input.phase.eligibility.expectedSigner.toLowerCase()) {
      throw new Error("Server signature was not produced by the reviewed signer");
    }
  }
  if (input.phase.eligibility.strategy === "merkle-proof-v1") {
    const proof = payload[input.phase.eligibility.proofKey];
    if (!Array.isArray(proof) || proof.some((item) => typeof item !== "string" || !ethers.isHexString(item, 32))) {
      throw new Error("Merkle proof artifact is invalid");
    }
    const leaf = merkleLeaf(input.phase, input.walletAddress, payload);
    if (!verifySortedMerkleProof(proof, input.phase.eligibility.root, leaf)) {
      throw new Error("Merkle proof does not match the reviewed root and wallet leaf");
    }
  }
  return payload;
}

export async function persistEligibilityArtifact(input: {
  collectionId: string;
  definitionVersionId: string;
  definitionHash: string;
  phase: ReviewedCallPhase;
  walletAddress: string;
  payload: unknown;
  expiresAt?: string | null;
  sourceHash: string;
}): Promise<{ id: string; artifactHash: string }> {
  const payload = validateEligibilityArtifact(input);
  const serialized = stableJson(payload);
  const artifactHash = stableHash(payload);
  const walletAddressHash = hashWalletAddress(input.walletAddress);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const values = {
    id,
    collectionId: input.collectionId,
    definitionVersionId: input.definitionVersionId,
    definitionHash: input.definitionHash,
    phaseId: input.phase.id,
    walletAddressHash,
    strategy: input.phase.eligibility.strategy,
    encryptedPayload: encryptSecret(serialized),
    artifactHash,
    sourceHash: input.sourceHash,
    expiresAt: input.expiresAt || null,
    updatedAt: now,
  };
  await db.insert(schema.mintEligibilityArtifacts).values(values).onConflictDoUpdate({
    target: [
      schema.mintEligibilityArtifacts.definitionVersionId,
      schema.mintEligibilityArtifacts.phaseId,
      schema.mintEligibilityArtifacts.walletAddressHash,
    ],
    set: {
      encryptedPayload: values.encryptedPayload,
      artifactHash,
      sourceHash: values.sourceHash,
      strategy: values.strategy,
      expiresAt: values.expiresAt,
      updatedAt: now,
    },
  });
  const [stored] = await db.select({ id: schema.mintEligibilityArtifacts.id }).from(schema.mintEligibilityArtifacts).where(and(
    eq(schema.mintEligibilityArtifacts.definitionVersionId, input.definitionVersionId),
    eq(schema.mintEligibilityArtifacts.phaseId, input.phase.id),
    eq(schema.mintEligibilityArtifacts.walletAddressHash, walletAddressHash),
  )).limit(1);
  if (!stored) throw new Error("Eligibility artifact was not stored");
  return { id: stored.id, artifactHash };
}

export async function loadEligibilityArtifact(input: {
  collectionId: string;
  definitionVersionId?: string;
  definitionHash: string;
  phase: ReviewedCallPhase;
  walletAddress: string;
  pinnedId?: string | null;
  pinnedHash?: string | null;
}): Promise<{ id: string; artifactHash: string; payload: EligibilityArtifact; expiresAt: string | null } | null> {
  const conditions = [
    eq(schema.mintEligibilityArtifacts.collectionId, input.collectionId),
    eq(schema.mintEligibilityArtifacts.definitionHash, input.definitionHash),
    eq(schema.mintEligibilityArtifacts.phaseId, input.phase.id),
    eq(schema.mintEligibilityArtifacts.walletAddressHash, hashWalletAddress(input.walletAddress)),
  ];
  if (input.definitionVersionId) conditions.push(eq(schema.mintEligibilityArtifacts.definitionVersionId, input.definitionVersionId));
  if (input.pinnedId) conditions.push(eq(schema.mintEligibilityArtifacts.id, input.pinnedId));
  const [row] = await db.select().from(schema.mintEligibilityArtifacts).where(and(...conditions)).limit(1);
  if (!row) return null;
  if (row.strategy !== input.phase.eligibility.strategy) throw new Error("Eligibility artifact strategy does not match the reviewed phase");
  if (row.expiresAt) {
    const expiresAt = Date.parse(row.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error("Eligibility artifact expiry is invalid");
    if (expiresAt <= Date.now()) return null;
  }
  if (input.pinnedHash && row.artifactHash !== input.pinnedHash) throw new Error("Pinned eligibility artifact hash changed");
  const payload = artifactSchema.parse(JSON.parse(decryptSecret(row.encryptedPayload)));
  if (stableHash(payload) !== row.artifactHash) throw new Error("Eligibility artifact failed its integrity check");
  validateEligibilityArtifact({ phase: input.phase, walletAddress: input.walletAddress, payload });
  return { id: row.id, artifactHash: row.artifactHash, payload, expiresAt: row.expiresAt };
}
