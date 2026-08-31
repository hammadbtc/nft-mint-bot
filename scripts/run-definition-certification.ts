import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import postgres from "postgres";
import { z } from "zod";
import {
  evaluateMintCertification,
  MINT_CERTIFIER_VERSION,
  REQUIRED_CERTIFICATION_CHECKS,
  type CertificationEvidence,
  signCertificationEvidence,
  type UnsignedCertificationEvidence,
} from "../src/lib/mint-certification";
import { hashMintDefinition, parseMintDefinition } from "../src/lib/mint-definitions";
import { stableHash } from "../src/lib/safety";
import { compileReviewedTransaction, phaseTarget, reviewedContractAddresses, validateReviewedCallConfig } from "../src/lib/reviewed-call-config";
import { canonicalCertificationIntent, certificationPhaseIds, assertExactCertificationIntent } from "../src/lib/adapter-certification";
import { getMintAdapter } from "../src/lib/adapters";
import { openSeaChainForChainId, signedSeaDropStageFor, validateOpenSeaSignedTransaction } from "../src/lib/adapters/opensea-signed-seadrop-v1";
import type { SupportedCollection } from "../src/lib/adapters/types";

const execFileAsync = promisify(execFile);
const transactionItemSchema = z.object({
  phaseId: z.string().min(1).max(100).optional(),
  quantity: z.number().int().positive().max(100_000).default(1),
  from: z.string().refine(ethers.isAddress),
  to: z.string().refine(ethers.isAddress),
  recipient: z.string().refine(ethers.isAddress),
  data: z.string().refine(ethers.isHexString),
  value: z.string().regex(/^\d+$/),
  artifact: z.record(z.string(), z.unknown()).optional(),
}).strict();
const contractInputSchema = z.object({ role: z.string().min(1).max(50), address: z.string().refine(ethers.isAddress) }).strict();
const transactionFileSchema = z.union([
  transactionItemSchema.extend({
    mode: z.enum(["fork", "replay"]).default("fork"),
    contracts: z.array(contractInputSchema).default([]),
  }).strict(),
  z.object({
    mode: z.enum(["fork", "replay"]).default("fork"),
    contracts: z.array(contractInputSchema).default([]),
    transactions: z.array(transactionItemSchema).min(1).max(30),
  }).strict(),
]);

const [versionId, transactionPath] = process.argv.slice(2);
if (!versionId || !transactionPath) throw new Error("Usage: npm run support:certify-definition -- <definition-version-id> <transaction.json>");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.CERTIFICATION_RPC_URL) throw new Error("CERTIFICATION_RPC_URL must point to the controlled fork/replay RPC");
if (!process.env.CERTIFICATION_ATTESTATION_KEY || process.env.CERTIFICATION_ATTESTATION_KEY.length < 32) throw new Error("CERTIFICATION_ATTESTATION_KEY must be at least 32 characters");

const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  const [version] = await sql`
    select id, definition_json, definition_hash from mint_definition_versions
    where id = ${versionId} limit 1
  `;
  if (!version) throw new Error("Mint definition version was not found");
  const definition = parseMintDefinition(version.definition_json);
  const definitionHash = hashMintDefinition(definition);
  if (definitionHash !== version.definition_hash) throw new Error("Stored mint definition failed its integrity check");
  const transactionFile = transactionFileSchema.parse(JSON.parse(await readFile(transactionPath, "utf8")));
  const transactions = "transactions" in transactionFile ? transactionFile.transactions : [transactionFile];
  const transaction = transactions[0];
  const certificationCollection: SupportedCollection = {
    id: definition.collectionId,
    ...definition,
    active: false,
    verified: false,
    broadcastPaused: true,
    broadcastPauseReason: "Certification",
    broadcastPauseUpdatedAt: null,
    createdAt: new Date(0).toISOString(),
  };
  const expectedPhaseIds = certificationPhaseIds(certificationCollection);
  if (transactions.length !== expectedPhaseIds.length) throw new Error("Certification input must contain one transaction for every executable adapter phase");
  if (new Set(transactions.map((item) => item.phaseId)).size !== transactions.length
    || expectedPhaseIds.some((phaseId) => !transactions.some((item) => item.phaseId === phaseId))) {
    throw new Error("Certification transaction phase IDs must exactly match the adapter phase policy");
  }
  const reviewedConfig = definition.adapterKey === "reviewed-call-v1" ? validateReviewedCallConfig(definition) : null;
  if (reviewedConfig) {
    if (transactions.length !== reviewedConfig.phases.length) throw new Error("Certification input must contain one transaction for every reviewed phase");
    if (new Set(transactions.map((item) => item.phaseId)).size !== transactions.length) throw new Error("Certification phase IDs must be unique");
    const contractInterface = new ethers.Interface(JSON.parse(definition.mintAbi) as ethers.InterfaceAbi);
    for (const phase of reviewedConfig.phases) {
      const item = transactions.find((candidate) => candidate.phaseId === phase.id);
      if (!item) throw new Error(`${phase.id} certification transaction is missing`);
      if (item.to.toLowerCase() !== phaseTarget(definition, phase).toLowerCase()) throw new Error(`${phase.id} transaction target is not reviewed`);
      if (item.recipient.toLowerCase() !== item.from.toLowerCase()) throw new Error(`${phase.id} recipient is not bound to the signing wallet`);
      const fragment = contractInterface.getFunction(phase.call.function);
      if (!fragment) throw new Error(`${phase.id} reviewed function is unavailable`);
      const decoded = contractInterface.decodeFunctionData(fragment, item.data);
      for (let index = 0; index < phase.call.args.length; index += 1) {
        const binding = phase.call.args[index];
        if (binding.source === "wallet" && String(decoded[index]).toLowerCase() !== item.from.toLowerCase()) throw new Error(`${phase.id} calldata wallet binding is incorrect`);
        if (binding.source === "quantity" && BigInt(decoded[index]) !== BigInt(item.quantity)) throw new Error(`${phase.id} calldata quantity binding is incorrect`);
        if (binding.source === "constant") {
          const expected = ethers.AbiCoder.defaultAbiCoder().encode([fragment.inputs[index]], [binding.value]);
          const observed = ethers.AbiCoder.defaultAbiCoder().encode([fragment.inputs[index]], [decoded[index]]);
          if (expected !== observed) throw new Error(`${phase.id} calldata constant binding is incorrect`);
        }
      }
      const expectedValue = phase.call.value.source === "zero" ? 0n
        : phase.call.value.source === "static" ? BigInt(phase.call.value.wei)
        : BigInt(phase.unitPriceWei) * BigInt(item.quantity);
      if (BigInt(item.value) !== expectedValue) throw new Error(`${phase.id} transaction value is incorrect`);
    }
  }

  const provider = new ethers.JsonRpcProvider(process.env.CERTIFICATION_RPC_URL, undefined, { staticNetwork: false });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== definition.chainId) throw new Error("Certification RPC is on the wrong chain");
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("Certification RPC did not return an anchored block");

  const adapter = getMintAdapter(definition.adapterKey);
  if (!adapter?.buildTransaction) throw new Error("Definition adapter cannot build certification transactions");
  for (const item of transactions) {
    let adapterRequest: ethers.TransactionRequest;
    if (definition.adapterKey === "reviewed-call-v1") {
      const phase = reviewedConfig!.phases.find((candidate) => candidate.id === item.phaseId)!;
      adapterRequest = compileReviewedTransaction({
        collection: certificationCollection,
        phase,
        wallet: item.from,
        quantity: item.quantity,
        artifact: item.artifact,
      });
    } else if (definition.adapterKey === "opensea-signed-seadrop-v1" && signedSeaDropStageFor(certificationCollection, item.phaseId!).kind === "signed") {
      const config = JSON.parse(definition.adapterConfig) as Parameters<typeof validateOpenSeaSignedTransaction>[1];
      adapterRequest = validateOpenSeaSignedTransaction(certificationCollection, config, signedSeaDropStageFor(certificationCollection, item.phaseId!), item.from, item.quantity, {
        to: item.to,
        data: item.data,
        value: item.value,
        chain: openSeaChainForChainId(definition.chainId),
      });
    } else {
      adapterRequest = await adapter.buildTransaction(certificationCollection, item.from, item.quantity, provider, { phaseId: item.phaseId, allowBeforeStart: true });
    }
    assertExactCertificationIntent(
      canonicalCertificationIntent({ chainId: Number(adapterRequest.chainId), to: String(adapterRequest.to), data: String(adapterRequest.data || "0x"), value: BigInt(adapterRequest.value ?? 0) }),
      canonicalCertificationIntent({ chainId: definition.chainId, to: item.to, data: item.data, value: item.value }),
    );
  }

  const contractMap = new Map<string, { role: string; address: string }>();
  for (const item of [
    { role: "collection", address: definition.contractAddress },
    { role: "transaction-target", address: transaction.to },
    ...transactions.map((item) => ({ role: `phase-${item.phaseId || "primary"}`, address: item.to })),
    ...(reviewedConfig ? reviewedContractAddresses(definition).map((address) => ({ role: "reviewed-contract", address })) : []),
    ...transactionFile.contracts,
  ]) contractMap.set(item.address.toLowerCase(), item);
  const contracts = await Promise.all([...contractMap.values()].map(async (item) => {
    const code = await provider.getCode(item.address, block.number);
    if (code === "0x") throw new Error(`${item.role} has no bytecode at the certification block`);
    return { ...item, codeHash: ethers.keccak256(code) };
  }));

  for (const item of transactions) {
    await provider.send("eth_call", [{
      from: item.from,
      to: item.to,
      data: item.data,
      value: ethers.toQuantity(BigInt(item.value)),
    }, ethers.toQuantity(block.number)]);
  }

  const testRun = await execFileAsync(process.execPath, [
    "--import", "tsx", "--test",
    "tests/support-certification.test.ts",
    "tests/launch-replay.test.ts",
    "tests/mainnet-safety.test.ts",
    "tests/supported-projects.test.ts",
    "tests/mint-definition-foundation.test.ts",
  ], { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 });
  const testRunHash = stableHash({ stdout: testRun.stdout, stderr: testRun.stderr });
  const transactionEvidence = transactions.map((item) => {
    const dataHash = stableHash(item.data.toLowerCase());
    const intentHash = stableHash({ chainId: definition.chainId, to: item.to.toLowerCase(), dataHash, value: item.value });
    return {
      from: item.from,
      to: item.to,
      recipient: item.recipient,
      chainId: definition.chainId,
      value: item.value,
      selector: item.data.slice(0, 10),
      dataHash,
      intentHash,
      adapterIntentHash: intentHash,
      simulation: "passed" as const,
      phaseId: item.phaseId,
      quantity: item.quantity,
    };
  });
  const primaryEvidence = transactionEvidence[0];
  const sourceCommit = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "local").toLowerCase();
  const observedAt = new Date();
  const baseEvidence = {
    definitionHash,
    blockHash: block.hash,
    blockNumber: block.number,
    contracts,
    transactions: transactionEvidence,
    testRunHash,
  };
  const unsignedEvidence: UnsignedCertificationEvidence = {
    runnerVersion: MINT_CERTIFIER_VERSION,
    definitionHash,
    sourceCommit,
    mode: transactionFile.mode,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    chainId: definition.chainId,
    blockNumber: block.number,
    blockHash: block.hash,
    contracts,
    transaction: {
      from: primaryEvidence.from,
      to: primaryEvidence.to,
      recipient: primaryEvidence.recipient,
      chainId: primaryEvidence.chainId,
      value: primaryEvidence.value,
      selector: primaryEvidence.selector,
      dataHash: primaryEvidence.dataHash,
        intentHash: primaryEvidence.intentHash,
        adapterIntentHash: primaryEvidence.adapterIntentHash,
      simulation: "passed",
    },
    phaseTransactions: transactionEvidence.map((item) => ({
        from: item.from,
        to: item.to,
        recipient: item.recipient,
        chainId: item.chainId,
        value: item.value,
        selector: item.selector,
        dataHash: item.dataHash,
            intentHash: item.intentHash,
            adapterIntentHash: item.adapterIntentHash,
        simulation: item.simulation,
        phaseId: item.phaseId!,
        quantity: item.quantity,
      })),
    checks: REQUIRED_CERTIFICATION_CHECKS.map((id) => ({
      id,
      status: "passed" as const,
      evidenceHash: stableHash({ id, baseEvidence }),
    })),
  };
  const evidence: CertificationEvidence = {
    ...unsignedEvidence,
    attestation: signCertificationEvidence(unsignedEvidence, process.env.CERTIFICATION_ATTESTATION_KEY),
  };
  const evaluated = evaluateMintCertification({
    definition,
    evidence,
    expectedSourceCommit: sourceCommit.slice(0, 7),
    attestationKey: process.env.CERTIFICATION_ATTESTATION_KEY,
  });
  if (!evaluated.passed) throw new Error(`Certification policy failed: ${evaluated.checks.filter((check) => !check.passed).map((check) => check.message).join("; ")}`);
  process.stdout.write(`${JSON.stringify({ evidence }, null, 2)}\n`);
} finally {
  await sql.end();
}
