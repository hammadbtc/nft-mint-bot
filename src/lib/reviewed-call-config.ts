import { ethers } from "ethers";
import { z } from "zod";
import type { MintPhase, SupportedCollection } from "@/lib/adapters/types";

const addressSchema = z.string().refine(ethers.isAddress, "Invalid EVM address");
const decimalSchema = z.string().regex(/^\d+$/, "Expected an unsigned integer string");
const dateSchema = z.iso.datetime();

export const reviewedArgumentBindingSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("wallet") }).strict(),
  z.object({ source: z.literal("quantity") }).strict(),
  z.object({ source: z.literal("constant"), value: z.unknown() }).strict(),
  z.object({ source: z.literal("artifact"), key: z.string().trim().min(1).max(100), abiType: z.string().trim().min(1).max(200) }).strict(),
]);

export type ReviewedArgumentBinding = z.infer<typeof reviewedArgumentBindingSchema>;

const callSchema = z.object({
  target: z.discriminatedUnion("source", [
    z.object({ source: z.literal("collection") }).strict(),
    z.object({ source: z.literal("reviewed"), address: addressSchema }).strict(),
  ]),
  function: z.string().trim().min(1).max(300),
  args: z.array(reviewedArgumentBindingSchema).max(30),
  value: z.discriminatedUnion("source", [
    z.object({ source: z.literal("zero") }).strict(),
    z.object({ source: z.literal("static"), wei: decimalSchema }).strict(),
    z.object({ source: z.literal("unit-price-times-quantity") }).strict(),
  ]),
}).strict();

const leafSchema = z.object({
  encoding: z.enum(["abi", "packed"]),
  types: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  values: z.array(reviewedArgumentBindingSchema).min(1).max(20),
  doubleHash: z.boolean().default(false),
}).strict();

export const reviewedEligibilitySchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("public") }).strict(),
  z.object({
    strategy: z.literal("merkle-proof-v1"),
    root: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    proofKey: z.string().trim().min(1).max(100),
    leaf: leafSchema,
  }).strict(),
  z.object({
    strategy: z.literal("server-signature-v1"),
    signatureKey: z.string().trim().min(1).max(100),
    expectedSigner: addressSchema,
    message: z.object({
      encoding: z.enum(["abi", "packed"]),
      types: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
      values: z.array(reviewedArgumentBindingSchema).min(1).max(20),
      signing: z.enum(["digest", "eip191"]),
    }).strict(),
  }).strict(),
  z.object({
    strategy: z.literal("token-balance-v1"),
    token: addressSchema,
    minimum: decimalSchema,
  }).strict(),
  z.object({
    strategy: z.literal("onchain-bool-v1"),
    target: addressSchema,
    function: z.string().trim().min(1).max(300),
    args: z.array(reviewedArgumentBindingSchema).max(20),
  }).strict(),
]);

const openingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("time"), startsAt: dateSchema.optional(), endsAt: dateSchema.optional() }).strict(),
  z.object({
    mode: z.literal("manual"),
    target: addressSchema,
    function: z.string().trim().min(1).max(300),
    args: z.array(reviewedArgumentBindingSchema).max(20),
  }).strict(),
]);

export const reviewedCallPhaseSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["public", "allowlist", "signed", "token-gated", "holder"]),
  opening: openingSchema,
  unitPriceWei: decimalSchema,
  maxPerWallet: z.number().int().positive().max(100_000),
  eligibility: reviewedEligibilitySchema,
  call: callSchema,
}).strict();

export const reviewedCallConfigSchema = z.object({
  schemaVersion: z.literal(1),
  engine: z.literal("custom-reviewed-v1"),
  onePerTransaction: z.boolean().optional(),
  maxPreparedTransactions: z.number().int().positive().max(100).optional(),
  phases: z.array(reviewedCallPhaseSchema).min(1).max(30),
  urlMatchers: z.array(z.object({ domain: z.string().trim().min(1), path: z.string().trim().min(1) }).strict()).max(20).optional(),
  contractAliases: z.array(addressSchema).max(20).optional(),
}).strict();

export type ReviewedCallConfig = z.infer<typeof reviewedCallConfigSchema>;
export type ReviewedCallPhase = z.infer<typeof reviewedCallPhaseSchema>;
export type ReviewedEligibility = z.infer<typeof reviewedEligibilitySchema>;
export type EligibilityArtifactPayload = Record<string, unknown>;

function parseAbi(collection: Pick<SupportedCollection, "mintAbi">): ethers.Interface {
  let abi: unknown;
  try { abi = JSON.parse(collection.mintAbi); }
  catch { throw new Error("Reviewed-call ABI is invalid JSON"); }
  if (!Array.isArray(abi) || !abi.length) throw new Error("Reviewed-call ABI must contain at least one function");
  return new ethers.Interface(abi as ethers.InterfaceAbi);
}

export function parseReviewedCallConfig(collection: Pick<SupportedCollection, "adapterConfig">): ReviewedCallConfig {
  let value: unknown;
  try { value = JSON.parse(collection.adapterConfig || "{}"); }
  catch { throw new Error("Reviewed-call configuration is invalid JSON"); }
  return reviewedCallConfigSchema.parse(value);
}

function paramType(input: ethers.ParamType): string {
  return input.format("sighash");
}

function validateBindings(bindings: ReviewedArgumentBinding[], inputs: readonly ethers.ParamType[], label: string): void {
  if (bindings.length !== inputs.length) throw new Error(`${label} has ${bindings.length} bindings for ${inputs.length} ABI inputs`);
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const input = inputs[index];
    const type = paramType(input);
    if (binding.source === "wallet" && type !== "address") throw new Error(`${label} wallet binding ${index} must target address`);
    if (binding.source === "quantity" && !/^u?int\d*$/.test(type)) throw new Error(`${label} quantity binding ${index} must target an integer`);
    if (binding.source === "artifact" && ethers.ParamType.from(binding.abiType).format("sighash") !== type) {
      throw new Error(`${label} artifact ${binding.key} declares ${binding.abiType} for ABI input ${type}`);
    }
    if (binding.source === "constant") {
      try { ethers.AbiCoder.defaultAbiCoder().encode([input], [binding.value]); }
      catch { throw new Error(`${label} constant binding ${index} cannot be encoded as ${type}`); }
    }
  }
}

function validateReadCall(iface: ethers.Interface, signature: string, bindings: ReviewedArgumentBinding[], label: string): void {
  const fragment = iface.getFunction(signature);
  if (!fragment) throw new Error(`${label} function ${signature} is absent from the reviewed ABI`);
  if (fragment.format("sighash") !== signature) throw new Error(`${label} must use the exact canonical function signature ${fragment.format("sighash")}`);
  validateBindings(bindings, fragment.inputs, label);
  if (fragment.outputs.length !== 1 || fragment.outputs[0].type !== "bool") throw new Error(`${label} must return exactly one bool`);
  if (bindings.some((binding) => binding.source === "artifact")) throw new Error(`${label} cannot depend on a mutable artifact`);
}

export function validateReviewedCallConfig(collection: Pick<SupportedCollection, "adapterConfig" | "mintAbi" | "contractAddress" | "mintMethod" | "paymentToken">): ReviewedCallConfig {
  const config = parseReviewedCallConfig(collection);
  const iface = parseAbi(collection);
  const ids = config.phases.map((phase) => phase.id);
  if (new Set(ids).size !== ids.length) throw new Error("Reviewed-call phase identifiers must be unique");
  if (config.onePerTransaction && !config.maxPreparedTransactions) throw new Error("Nonce-ladder mode requires maxPreparedTransactions");

  for (const phase of config.phases) {
    const fragment = iface.getFunction(phase.call.function);
    if (!fragment) throw new Error(`${phase.id} mint function ${phase.call.function} is absent from the reviewed ABI`);
    if (fragment.format("sighash") !== phase.call.function) throw new Error(`${phase.id} must use the exact canonical function signature ${fragment.format("sighash")}`);
    validateBindings(phase.call.args, fragment.inputs, `${phase.id} mint call`);
    const artifactKeys = new Set(phase.call.args.filter((binding) => binding.source === "artifact").map((binding) => binding.key));
    if (phase.eligibility.strategy === "public" && artifactKeys.size) throw new Error(`${phase.id} public phase cannot require wallet artifacts`);
    if (phase.eligibility.strategy !== "public" && phase.eligibility.strategy !== "token-balance-v1" && phase.eligibility.strategy !== "onchain-bool-v1" && !artifactKeys.size) {
      throw new Error(`${phase.id} gated phase does not bind its verified artifact into calldata`);
    }
    if (phase.kind === "public" && phase.eligibility.strategy !== "public") throw new Error(`${phase.id} public phase has a gated eligibility strategy`);
    if (phase.kind !== "public" && phase.eligibility.strategy === "public") throw new Error(`${phase.id} gated phase is configured as public eligibility`);
    if (phase.call.value.source === "unit-price-times-quantity" && collection.paymentToken) {
      throw new Error(`${phase.id} cannot send native value for an ERC-20 payment mint`);
    }
    if (phase.opening.mode === "time" && phase.opening.startsAt && phase.opening.endsAt && Date.parse(phase.opening.startsAt) >= Date.parse(phase.opening.endsAt)) {
      throw new Error(`${phase.id} phase window is invalid`);
    }
    if (phase.opening.mode === "manual") {
      validateReadCall(iface, phase.opening.function, phase.opening.args, `${phase.id} opening call`);
      if (phase.opening.args.some((binding) => binding.source !== "constant")) throw new Error(`${phase.id} opening call may use only reviewed constants`);
    }
    if (phase.eligibility.strategy === "onchain-bool-v1") validateReadCall(iface, phase.eligibility.function, phase.eligibility.args, `${phase.id} eligibility call`);
    if (phase.eligibility.strategy === "merkle-proof-v1") {
      const proofKey = phase.eligibility.proofKey;
      if (!artifactKeys.has(proofKey)) throw new Error(`${phase.id} Merkle proof is not bound into calldata`);
      const proofBinding = phase.call.args.find((binding) => binding.source === "artifact" && binding.key === proofKey);
      if (proofBinding?.source !== "artifact" || ethers.ParamType.from(proofBinding.abiType).format("sighash") !== "bytes32[]") {
        throw new Error(`${phase.id} Merkle proof must bind a bytes32[] calldata input`);
      }
      if (phase.eligibility.leaf.types.length !== phase.eligibility.leaf.values.length) throw new Error(`${phase.id} Merkle leaf type/value counts differ`);
      for (const binding of phase.eligibility.leaf.values) {
        if (binding.source === "quantity") throw new Error(`${phase.id} Merkle leaves must bind an artifact allowance, not the requested quantity`);
      }
    }
    if (phase.eligibility.strategy === "server-signature-v1" && !artifactKeys.has(phase.eligibility.signatureKey)) {
      throw new Error(`${phase.id} server signature is not bound into calldata`);
    }
    if (phase.eligibility.strategy === "server-signature-v1") {
      const signatureKey = phase.eligibility.signatureKey;
      const signatureBinding = phase.call.args.find((binding) => binding.source === "artifact" && binding.key === signatureKey);
      if (signatureBinding?.source !== "artifact" || ethers.ParamType.from(signatureBinding.abiType).format("sighash") !== "bytes") {
        throw new Error(`${phase.id} server signature must bind a bytes calldata input`);
      }
      if (phase.eligibility.message.types.length !== phase.eligibility.message.values.length) throw new Error(`${phase.id} signed message type/value counts differ`);
      if (!phase.eligibility.message.values.some((binding) => binding.source === "wallet")) throw new Error(`${phase.id} signed message is not wallet-bound`);
      if (phase.eligibility.message.values.some((binding) => binding.source === "quantity")) throw new Error(`${phase.id} signature must bind a reviewed allowance artifact, not requested quantity`);
    }
  }
  if (!config.phases.some((phase) => phase.call.function === collection.mintMethod)) {
    throw new Error("Primary mintMethod is not used by any reviewed phase");
  }
  return config;
}

export function reviewedPhaseStatus(phase: ReviewedCallPhase, manualOpen?: boolean): MintPhase["status"] {
  if (phase.opening.mode === "manual") return manualOpen ? "live" : "upcoming";
  const now = Date.now();
  const starts = phase.opening.startsAt ? Date.parse(phase.opening.startsAt) : Number.NaN;
  const ends = phase.opening.endsAt ? Date.parse(phase.opening.endsAt) : Number.NaN;
  if (Number.isFinite(starts) && now < starts) return "upcoming";
  if (Number.isFinite(ends) && now >= ends) return "ended";
  return "live";
}

export function phaseTarget(collection: Pick<SupportedCollection, "contractAddress">, phase: ReviewedCallPhase): string {
  return phase.call.target.source === "collection" ? collection.contractAddress : phase.call.target.address;
}

export function reviewedContractAddresses(
  collection: Pick<SupportedCollection, "adapterConfig" | "mintAbi" | "contractAddress" | "mintMethod" | "paymentToken">,
): string[] {
  const config = validateReviewedCallConfig(collection);
  const addresses = new Set<string>([collection.contractAddress.toLowerCase()]);
  if (collection.paymentToken) addresses.add(collection.paymentToken.toLowerCase());
  for (const phase of config.phases) {
    addresses.add(phaseTarget(collection, phase).toLowerCase());
    if (phase.opening.mode === "manual") addresses.add(phase.opening.target.toLowerCase());
    if (phase.eligibility.strategy === "token-balance-v1") addresses.add(phase.eligibility.token.toLowerCase());
    if (phase.eligibility.strategy === "onchain-bool-v1") addresses.add(phase.eligibility.target.toLowerCase());
  }
  return [...addresses];
}

export function resolveBindingValues(bindings: ReviewedArgumentBinding[], context: {
  wallet: string;
  quantity: number;
  artifact?: EligibilityArtifactPayload;
}): unknown[] {
  return bindings.map((binding) => {
    if (binding.source === "wallet") return ethers.getAddress(context.wallet);
    if (binding.source === "quantity") return context.quantity;
    if (binding.source === "constant") return binding.value;
    if (!context.artifact || !(binding.key in context.artifact)) throw new Error(`Eligibility artifact is missing ${binding.key}`);
    return context.artifact[binding.key];
  });
}

export function compileReviewedTransaction(input: {
  collection: Pick<SupportedCollection, "mintAbi" | "contractAddress" | "chainId">;
  phase: ReviewedCallPhase;
  wallet: string;
  quantity: number;
  artifact?: EligibilityArtifactPayload;
}): ethers.TransactionRequest {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > input.phase.maxPerWallet) throw new Error("Mint quantity exceeds the reviewed phase limit");
  const iface = parseAbi(input.collection);
  const fragment = iface.getFunction(input.phase.call.function);
  if (!fragment) throw new Error("Reviewed mint function is unavailable");
  const args = resolveBindingValues(input.phase.call.args, input);
  const data = iface.encodeFunctionData(fragment, args);
  const decoded = iface.decodeFunctionData(fragment, data);
  if (decoded.length !== args.length) throw new Error("Reviewed calldata failed its encode/decode integrity check");
  const value = input.phase.call.value.source === "zero" ? 0n
    : input.phase.call.value.source === "static" ? BigInt(input.phase.call.value.wei)
    : BigInt(input.phase.unitPriceWei) * BigInt(input.quantity);
  return { to: phaseTarget(input.collection, input.phase), data, value, chainId: input.collection.chainId };
}

export function reviewedArtifactKeys(phase: ReviewedCallPhase): string[] {
  return [...new Set([
    ...phase.call.args.filter((binding) => binding.source === "artifact").map((binding) => binding.key),
    ...(phase.eligibility.strategy === "merkle-proof-v1"
      ? phase.eligibility.leaf.values.filter((binding) => binding.source === "artifact").map((binding) => binding.key)
      : []),
  ])].sort();
}
