import { ethers } from "ethers";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getMintAdapter } from "@/lib/adapters";
import type { SupportedCollection } from "@/lib/adapters/types";
import { executionManifestFor } from "@/lib/engines";
import {
  hashMintDefinition,
  mintDefinitionSchema,
  type MintDefinitionSnapshot,
} from "@/lib/mint-definitions";
import { stableHash, stableJson } from "@/lib/safety";
import { phaseTarget, reviewedContractAddresses, validateReviewedCallConfig } from "@/lib/reviewed-call-config";
import { certificationPhaseIds } from "@/lib/adapter-certification";

export const MINT_CERTIFIER_VERSION = "mint-certifier-v1" as const;
export const REQUIRED_CERTIFICATION_CHECKS = [
  "contract-code",
  "phase-matrix",
  "transaction-intent",
  "wallet-binding",
  "negative-paths",
  "restart-recovery",
  "fork-simulation",
  "adapter-byte-equivalence",
  "url-boundary",
] as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const addressSchema = z.string().refine(ethers.isAddress, "Invalid EVM address");

const evidenceCheckSchema = z.object({
  id: z.enum(REQUIRED_CERTIFICATION_CHECKS),
  status: z.literal("passed"),
  evidenceHash: hashSchema,
}).strict();

const transactionEvidenceSchema = z.object({
  from: addressSchema,
  to: addressSchema,
  recipient: addressSchema,
  chainId: z.number().int().positive(),
  value: z.string().regex(/^\d+$/),
  selector: z.string().regex(/^0x[a-fA-F0-9]{8}$/),
  dataHash: hashSchema,
  intentHash: hashSchema,
  adapterIntentHash: hashSchema,
  simulation: z.literal("passed"),
}).strict();

export const unsignedCertificationEvidenceSchema = z.object({
  runnerVersion: z.literal(MINT_CERTIFIER_VERSION),
  definitionHash: hashSchema,
  sourceCommit: z.union([z.literal("local"), z.string().regex(/^[a-f0-9]{7,64}$/)]),
  mode: z.enum(["fork", "replay"]),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  chainId: z.number().int().positive(),
  blockNumber: z.number().int().nonnegative(),
  blockHash: bytes32Schema,
  contracts: z.array(z.object({
    role: z.string().trim().min(1).max(50),
    address: addressSchema,
    codeHash: bytes32Schema,
  }).strict()).min(1).max(100),
  transaction: transactionEvidenceSchema,
  phaseTransactions: z.array(transactionEvidenceSchema.extend({
    phaseId: z.string().trim().min(1).max(100),
    quantity: z.number().int().positive().max(100_000),
  }).strict()).min(1).max(30).optional(),
  checks: z.array(evidenceCheckSchema).length(REQUIRED_CERTIFICATION_CHECKS.length),
}).strict();

export const certificationEvidenceSchema = unsignedCertificationEvidenceSchema.extend({
  attestation: hashSchema,
}).strict();

export type CertificationEvidence = z.infer<typeof certificationEvidenceSchema>;
export type UnsignedCertificationEvidence = z.infer<typeof unsignedCertificationEvidenceSchema>;
export type CertificationCheck = { id: string; passed: boolean; message: string };

function requireAttestationKey(key: string): void {
  if (key.length < 32) throw new Error("Certification attestation key must be at least 32 characters");
}

export function signCertificationEvidence(evidence: UnsignedCertificationEvidence, key: string): string {
  requireAttestationKey(key);
  return createHmac("sha256", key).update(stableJson(unsignedCertificationEvidenceSchema.parse(evidence))).digest("hex");
}

export function verifyCertificationEvidence(evidence: CertificationEvidence, key: string): boolean {
  requireAttestationKey(key);
  const { attestation, ...unsigned } = evidence;
  const expected = signCertificationEvidence(unsigned, key);
  return timingSafeEqual(Buffer.from(attestation, "hex"), Buffer.from(expected, "hex"));
}

function asCollection(definition: MintDefinitionSnapshot): SupportedCollection {
  return {
    id: definition.collectionId,
    ...definition,
    active: false,
    verified: false,
    broadcastPaused: true,
    broadcastPauseReason: "Definition is undergoing certification",
    broadcastPauseUpdatedAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

function parsedJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function normalizedDomains(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("At least one exact mint domain is required");
  const domains = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Mint domains must be strings");
    const domain = item.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!domain || domain.includes("*") || domain.includes("/") || domain.includes(":")) throw new Error("Mint domains must be exact hostnames");
    const url = new URL(`https://${domain}`);
    if (url.hostname !== domain) throw new Error("Mint domain is invalid");
    return domain;
  });
  if (new Set(domains).size !== domains.length) throw new Error("Mint domains must be unique");
  return domains;
}

function phaseMatrixCheck(collection: SupportedCollection, config: Record<string, unknown>): void {
  const adapter = getMintAdapter(collection.adapterKey);
  if (!adapter) throw new Error("Mint adapter is not registered");
  if (collection.adapterKey === "reviewed-call-v1") {
    validateReviewedCallConfig(collection);
    return;
  }
  const candidates = Array.isArray(config.stages) ? config.stages : Array.isArray(config.phases) ? config.phases : [];
  const phases = candidates.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  const ids = phases.map((phase) => String(phase.id || phase.name || ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Reviewed phase identifiers must be present and unique");
  for (const phase of phases) {
    const id = String(phase.id || phase.name);
    const kind = phase.kind;
    const needsPayload = adapter.requiresPayloadWarmup?.(collection, id) === true;
    const provesEligibility = adapter.prearmedPayloadProvesEligibility?.(collection, id) === true;
    if (kind === "signed" && (!needsPayload || !provesEligibility || !adapter.warmTransaction)) {
      throw new Error(`${id} is signed but lacks complete wallet-payload arming`);
    }
    if (kind === "public" && (needsPayload || provesEligibility)) {
      throw new Error(`${id} is public but declares signed wallet-payload behavior`);
    }
  }
}

function runCheck(id: string, action: () => void): CertificationCheck {
  try {
    action();
    return { id, passed: true, message: "passed" };
  } catch (error) {
    return { id, passed: false, message: error instanceof Error ? error.message : "failed" };
  }
}

export function evaluateMintCertification(input: {
  definition: MintDefinitionSnapshot;
  evidence: CertificationEvidence;
  expectedSourceCommit: string;
  attestationKey: string;
  now?: Date;
}): {
  passed: boolean;
  checks: CertificationCheck[];
  definitionHash: string;
  evidenceJson: string;
  evidenceHash: string;
  certificateHash: string;
} {
  const definition = mintDefinitionSchema.parse(input.definition);
  const evidence = certificationEvidenceSchema.parse(input.evidence);
  const definitionHash = hashMintDefinition(definition);
  const now = input.now || new Date();
  const collection = asCollection(definition);

  const checks: CertificationCheck[] = [
    runCheck("definition-hash", () => {
      if (evidence.definitionHash !== definitionHash) throw new Error("Evidence targets a different definition hash");
    }),
    runCheck("runner-attestation", () => {
      if (!verifyCertificationEvidence(evidence, input.attestationKey)) throw new Error("Certification runner attestation is invalid");
    }),
    runCheck("source-commit", () => {
      if (input.expectedSourceCommit !== "local" && !evidence.sourceCommit.startsWith(input.expectedSourceCommit)) {
        throw new Error("Evidence was produced by a different deployment commit");
      }
    }),
    runCheck("freshness", () => {
      const observedAt = Date.parse(evidence.observedAt);
      const expiresAt = Date.parse(evidence.expiresAt);
      if (observedAt > now.getTime() + 60_000) throw new Error("Evidence timestamp is in the future");
      if (expiresAt <= now.getTime()) throw new Error("Certification evidence has expired");
      if (expiresAt - observedAt > 7 * 24 * 60 * 60 * 1000) throw new Error("Certification evidence lifetime exceeds seven days");
    }),
    runCheck("chain", () => {
      if (evidence.chainId !== definition.chainId || evidence.transaction.chainId !== definition.chainId) throw new Error("Evidence chain does not match the definition");
    }),
    runCheck("contract", () => {
      if (!ethers.isAddress(definition.contractAddress)) throw new Error("Collection contract is invalid");
      const addresses = new Set(evidence.contracts.map((contract) => contract.address.toLowerCase()));
      if (!addresses.has(definition.contractAddress.toLowerCase())) throw new Error("Collection bytecode evidence is missing");
      if (!addresses.has(evidence.transaction.to.toLowerCase())) throw new Error("Transaction target bytecode evidence is missing");
      if (definition.adapterKey === "reviewed-call-v1") {
        for (const address of reviewedContractAddresses(collection)) {
          if (!addresses.has(address.toLowerCase())) throw new Error(`Reviewed contract bytecode evidence is missing for ${address}`);
        }
      }
    }),
    runCheck("abi", () => {
      const parsed: unknown = JSON.parse(definition.mintAbi);
      if (!Array.isArray(parsed) || !parsed.length) throw new Error("Mint ABI must contain the reviewed function");
      const iface = new ethers.Interface(parsed);
      if (!iface.getFunction(definition.mintMethod)) throw new Error("Reviewed mint function is absent from the ABI");
    }),
    runCheck("payment-token", () => {
      if (definition.paymentToken && !ethers.isAddress(definition.paymentToken)) throw new Error("Payment token is invalid");
    }),
    runCheck("domains", () => {
      const domains = normalizedDomains(definition.domains);
      if (!definition.siteUrl) throw new Error("Official mint URL is required");
      const site = new URL(definition.siteUrl);
      const hostname = site.hostname.toLowerCase().replace(/^www\./, "");
      if (site.protocol !== "https:" || !domains.includes(hostname)) throw new Error("Official mint URL must use a reviewed exact HTTPS domain");
    }),
    runCheck("adapter-config", () => {
      const config = parsedJsonObject(definition.adapterConfig, "Adapter configuration");
      if (!getMintAdapter(definition.adapterKey)) throw new Error("Mint adapter is not registered");
      executionManifestFor(collection);
      phaseMatrixCheck(collection, config);
    }),
    runCheck("wallet-binding", () => {
      if (evidence.transaction.recipient.toLowerCase() !== evidence.transaction.from.toLowerCase()) {
        throw new Error("Fork transaction recipient is not bound to its signing wallet");
      }
    }),
    runCheck("transaction-intent", () => {
      const expected = stableHash({
        chainId: evidence.transaction.chainId,
        to: evidence.transaction.to.toLowerCase(),
        dataHash: evidence.transaction.dataHash,
        value: evidence.transaction.value,
      });
      if (evidence.transaction.intentHash !== expected) throw new Error("Fork transaction intent hash is inconsistent");
      if (evidence.transaction.adapterIntentHash !== expected) throw new Error("Fork transaction is not bound to adapter-built bytes");
    }),
    runCheck("adapter-phase-coverage", () => {
      const expected = certificationPhaseIds(collection);
      const observed = evidence.phaseTransactions?.map((item) => item.phaseId) || [];
      if (observed.length !== expected.length || expected.some((phaseId) => !observed.includes(phaseId))) {
        throw new Error("Certification does not cover every executable adapter phase");
      }
      if (new Set(observed).size !== observed.length) throw new Error("Certification phase transaction evidence is duplicated");
      for (const transaction of evidence.phaseTransactions || []) {
        if (transaction.chainId !== definition.chainId) throw new Error(`${transaction.phaseId} transaction uses another chain`);
        if (transaction.recipient.toLowerCase() !== transaction.from.toLowerCase()) throw new Error(`${transaction.phaseId} transaction recipient is not wallet-bound`);
        const expectedIntent = stableHash({
          chainId: transaction.chainId,
          to: transaction.to.toLowerCase(),
          dataHash: transaction.dataHash,
          value: transaction.value,
        });
        if (transaction.intentHash !== expectedIntent || transaction.adapterIntentHash !== expectedIntent) {
          throw new Error(`${transaction.phaseId} transaction is not bound to exact adapter-built bytes`);
        }
      }
    }),
    runCheck("reviewed-phase-transactions", () => {
      if (definition.adapterKey !== "reviewed-call-v1") return;
      const config = validateReviewedCallConfig(collection);
      const transactions = evidence.phaseTransactions || [];
      if (transactions.length !== config.phases.length) throw new Error("Every reviewed phase requires its own fork transaction evidence");
      if (new Set(transactions.map((transaction) => transaction.phaseId)).size !== transactions.length) throw new Error("Reviewed phase transaction evidence is duplicated");
      const contractInterface = new ethers.Interface(JSON.parse(definition.mintAbi) as ethers.InterfaceAbi);
      for (const phase of config.phases) {
        const transaction = transactions.find((item) => item.phaseId === phase.id);
        if (!transaction) throw new Error(`${phase.id} fork transaction evidence is missing`);
        if (transaction.chainId !== definition.chainId) throw new Error(`${phase.id} transaction uses another chain`);
        if (transaction.to.toLowerCase() !== phaseTarget(collection, phase).toLowerCase()) throw new Error(`${phase.id} transaction target does not match its reviewed call`);
        const selector = contractInterface.getFunction(phase.call.function)?.selector;
        if (!selector || transaction.selector.toLowerCase() !== selector.toLowerCase()) throw new Error(`${phase.id} selector does not match its reviewed function`);
        if (transaction.recipient.toLowerCase() !== transaction.from.toLowerCase()) throw new Error(`${phase.id} transaction recipient is not wallet-bound`);
        const expectedValue = phase.call.value.source === "zero" ? 0n
          : phase.call.value.source === "static" ? BigInt(phase.call.value.wei)
          : BigInt(phase.unitPriceWei) * BigInt(transaction.quantity);
        if (BigInt(transaction.value) !== expectedValue) throw new Error(`${phase.id} transaction value does not match its reviewed policy`);
        const expectedIntent = stableHash({
          chainId: transaction.chainId,
          to: transaction.to.toLowerCase(),
          dataHash: transaction.dataHash,
          value: transaction.value,
        });
        if (transaction.intentHash !== expectedIntent) throw new Error(`${phase.id} transaction intent hash is inconsistent`);
      }
    }),
    runCheck("evidence-matrix", () => {
      const ids = evidence.checks.map((check) => check.id);
      if (new Set(ids).size !== REQUIRED_CERTIFICATION_CHECKS.length) throw new Error("Certification evidence checks are duplicated");
      for (const required of REQUIRED_CERTIFICATION_CHECKS) if (!ids.includes(required)) throw new Error(`Certification evidence is missing ${required}`);
    }),
  ];
  const passed = checks.every((check) => check.passed);
  const evidenceJson = stableJson(evidence);
  const evidenceHash = stableHash(evidence);
  const checksJson = stableJson(checks);
  const certificateHash = stableHash({
    runnerVersion: MINT_CERTIFIER_VERSION,
    definitionHash,
    evidenceHash,
    checksJson,
  });
  return { passed, checks, definitionHash, evidenceJson, evidenceHash, certificateHash };
}

export function definitionCollectionFields(definition: MintDefinitionSnapshot) {
  return {
    name: definition.name,
    contractAddress: definition.contractAddress,
    chainId: definition.chainId,
    mintMethod: definition.mintMethod,
    mintAbi: definition.mintAbi,
    mintPrice: definition.mintPrice,
    maxPerWallet: definition.maxPerWallet,
    maxSupply: definition.maxSupply,
    defaultGasLimit: definition.defaultGasLimit,
    defaultMaxFeePerGas: definition.defaultMaxFeePerGas,
    defaultMaxPriorityFeePerGas: definition.defaultMaxPriorityFeePerGas,
    defaultUseFlashbots: definition.defaultUseFlashbots,
    fcfsEnabled: definition.fcfsEnabled,
    fcfsMintOpenSignature: definition.fcfsMintOpenSignature,
    paymentToken: definition.paymentToken,
    safetyCheck: definition.safetyCheck,
    slug: definition.slug,
    adapterKey: definition.adapterKey,
    domains: definition.domains,
    siteUrl: definition.siteUrl,
    imageUrl: definition.imageUrl,
    adapterConfig: definition.adapterConfig,
  };
}
