import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  collectionFromJobSnapshot,
  hashMintDefinition,
  serializeMintDefinition,
  snapshotCollectionDefinition,
} from "../src/lib/mint-definitions";
import { deserializeMintPayload, normalizeMintPayload } from "../src/lib/mint-payload-store";
import { MINT_ERROR_CODES, MintSafetyError, mintErrorCode } from "../src/lib/mint-errors";
import { stableHash, stableJson } from "../src/lib/safety";
import { draftMintSchema } from "../src/app/api/collections/route";

const collection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Pinned Mint",
  contractAddress: "0x0000000000000000000000000000000000000001",
  chainId: 1,
  mintMethod: "mint",
  mintAbi: "[]",
  mintPrice: "100",
  maxPerWallet: 2,
  maxSupply: 1000,
  active: true,
  defaultGasLimit: null,
  defaultMaxFeePerGas: null,
  defaultMaxPriorityFeePerGas: null,
  defaultUseFlashbots: false,
  fcfsEnabled: false,
  fcfsMintOpenSignature: null,
  paymentToken: null,
  safetyCheck: true,
  slug: "pinned",
  adapterKey: "evm-contract-v1",
  domains: '["mint.example.com"]',
  siteUrl: "https://mint.example.com",
  imageUrl: null,
  adapterConfig: "{}",
  verified: true,
  broadcastPaused: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("mint definition hashes execution fields but excludes mutable controls", () => {
  const definition = snapshotCollectionDefinition(collection);
  const hash = hashMintDefinition(definition);
  assert.equal(hashMintDefinition(snapshotCollectionDefinition({
    ...collection,
    active: false,
    verified: false,
    broadcastPaused: true,
  })), hash);
  assert.notEqual(hashMintDefinition(snapshotCollectionDefinition({ ...collection, mintPrice: "101" })), hash);
});

test("job snapshot remains byte-pinned after live collection edits", () => {
  const definition = snapshotCollectionDefinition(collection);
  const pinned = collectionFromJobSnapshot({ ...collection, mintPrice: "999" }, {
    definitionVersionId: "22222222-2222-4222-8222-222222222222",
    definitionSnapshot: serializeMintDefinition(definition),
    definitionHash: hashMintDefinition(definition),
  });
  assert.equal(pinned.mintPrice, "100");
  assert.equal(pinned.broadcastPaused, false);
});

test("tampered job snapshots fail closed with a stable error code", () => {
  assert.throws(() => collectionFromJobSnapshot(collection, {
    definitionVersionId: "22222222-2222-4222-8222-222222222222",
    definitionSnapshot: serializeMintDefinition(snapshotCollectionDefinition(collection)),
    definitionHash: "0".repeat(64),
  }), (error: unknown) => {
    assert.equal(mintErrorCode(error), MINT_ERROR_CODES.definitionMismatch);
    return true;
  });
});

test("legacy jobs without a complete definition pin fail closed", () => {
  assert.throws(() => collectionFromJobSnapshot(collection, {
    definitionVersionId: null,
    definitionSnapshot: null,
    definitionHash: null,
  }), (error: unknown) => {
    assert.equal(mintErrorCode(error), MINT_ERROR_CODES.definitionMismatch);
    return true;
  });
});

test("durable payload serialization retains only signed transaction intent", () => {
  const normalized = normalizeMintPayload({
    to: collection.contractAddress,
    data: "0x1234",
    value: 7n,
    chainId: 1,
    gasLimit: 500_000n,
    nonce: 9,
  });
  assert.deepEqual(normalized, {
    to: collection.contractAddress,
    data: "0x1234",
    value: "7",
    chainId: 1,
  });
  const restored = deserializeMintPayload(stableJson(normalized), stableHash(normalized));
  assert.equal(restored.value, 7n);
  assert.equal(restored.gasLimit, undefined);
  assert.throws(() => deserializeMintPayload(stableJson({ ...normalized, value: "8" }), stableHash(normalized)), /integrity/);
});

test("safety errors preserve machine-readable codes", () => {
  const error = new MintSafetyError(MINT_ERROR_CODES.projectPaused, "paused for review");
  assert.equal(mintErrorCode(error), MINT_ERROR_CODES.projectPaused);
  assert.match(error.message, /^\[MINT_PROJECT_PAUSED\]/);
  assert.equal(ethers.isAddress(collection.contractAddress), true);
});

test("mint registration cannot self-assert verification", () => {
  const draft = {
    name: "Draft",
    slug: "draft",
    contractAddress: collection.contractAddress,
    chainId: 1,
    mintMethod: "mint",
    mintAbi: [],
    adapterKey: "evm-contract-v1",
    domains: ["mint.example.com"],
    siteUrl: "https://mint.example.com",
  };
  assert.equal(draftMintSchema.safeParse({ ...draft, verified: true }).success, false);
  assert.equal(draftMintSchema.safeParse(draft).success, true);
});
