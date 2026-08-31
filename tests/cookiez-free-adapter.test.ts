import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { cookiezFreeV1, cookiezSimulationRetryAt, encodeCookiezFreeClaim } from "../src/lib/adapters/cookiez-free-v1";
import { executionEngineFor, executionManifestFor } from "../src/lib/engines";
import { simulateMintForAdapter } from "../src/lib/engine/mint";

const contractAddress = "0x4ba87e60e52c19c1da7dab74414deac4e237c23a";
const signer = "0x1111111111111111111111111111111111111111";
const collection = {
  id: "c00c1e20-7ba1-4663-9000-000000000005", name: "COOKIEZ — Free BAKER Claim", contractAddress,
  chainId: 4663, mintMethod: "claimFree", mintAbi: '["function claimFree()"]',
  mintPrice: "0", maxPerWallet: 5, maxSupply: 10000, active: true, verified: true,
  defaultGasLimit: null, defaultMaxFeePerGas: null, defaultMaxPriorityFeePerGas: null,
  defaultUseFlashbots: false, fcfsEnabled: false, fcfsMintOpenSignature: null,
  paymentToken: null, safetyCheck: true, slug: "cookiez-free-baker", adapterKey: "cookiez-free-v1",
  domains: '["cookiez.fun","www.cookiez.fun"]', siteUrl: "https://www.cookiez.fun/#mint", imageUrl: null,
  adapterConfig: JSON.stringify({
    engine: "sequential-confirmed-v1", onePerTransaction: true, maxPreparedTransactions: 5,
    expectedMaxSupply: 10000, expectedFreePerWallet: 5, expectedMintIntervalSecs: 10, expectedValueWei: "0",
  }),
  createdAt: new Date().toISOString(),
};

function fakeProvider(overrides: { mintOpen?: boolean; totalMinted?: bigint; mintEndedAt?: bigint; balance?: bigint } = {}) {
  const values: Record<string, unknown> = {
    totalMinted: overrides.totalMinted ?? 100n,
    mintOpenedAt: 1n,
    mintEndedAt: overrides.mintEndedAt ?? 0n,
    mintOpen: overrides.mintOpen ?? true,
    balanceOf: overrides.balance ?? 0n,
  };
  const iface = new ethers.Interface([
    "function totalMinted() view returns (uint256)", "function mintOpenedAt() view returns (uint256)",
    "function mintEndedAt() view returns (uint256)", "function mintOpen() view returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  return {
    getBlock: async () => ({ number: 100 }),
    call: async (tx: { data: string }) => {
      const parsed = iface.parseTransaction({ data: tx.data })!;
      return iface.encodeFunctionResult(parsed.name, [values[parsed.name]]);
    },
  } as unknown as ethers.Provider;
}

test("COOKIEZ uses exact zero-value claimFree calldata", async () => {
  const request = await cookiezFreeV1.buildTransaction!(collection, signer, 1, fakeProvider(), { phaseId: "free" });
  assert.equal(request.to, contractAddress);
  assert.equal(request.data, "0xf366afc9");
  assert.equal(request.data, encodeCookiezFreeClaim());
  assert.equal(request.value, 0n);
  assert.equal(request.chainId, 4663);
});

test("COOKIEZ capacity stops conservatively at five held BAKERS and sold out", async () => {
  assert.equal(await cookiezFreeV1.remainingTransactions!(collection, "free", signer, fakeProvider({ balance: 2n })), 3);
  assert.equal(await cookiezFreeV1.remainingTransactions!(collection, "free", signer, fakeProvider({ balance: 5n })), 0);
  assert.equal(await cookiezFreeV1.remainingTransactions!(collection, "free", signer, fakeProvider({ totalMinted: 9999n })), 1);
  assert.equal(await cookiezFreeV1.remainingTransactions!(collection, "free", signer, fakeProvider({ mintOpen: false })), 0);
});

test("COOKIEZ selects confirmed sequential execution rather than a nonce ladder", () => {
  const manifest = executionManifestFor(collection);
  const engine = executionEngineFor(collection);
  assert.equal(manifest.onePerTransaction, true);
  assert.equal(manifest.maxPreparedTransactions, 5);
  assert.equal(engine.key, "sequential-confirmed-v1");
  assert.equal(engine.supportsNonceLadder, false);
  assert.equal(engine.supportsSequentialTransactions, true);
  assert.equal(engine.requiresDedicatedWalletForLadder, false);
});

test("COOKIEZ fails closed when mint is shut or conservative wallet room is exhausted", async () => {
  await assert.rejects(() => cookiezFreeV1.buildTransaction!(collection, signer, 1, fakeProvider({ mintOpen: false }), { phaseId: "free" }), /not open/);
  await assert.rejects(() => cookiezFreeV1.buildTransaction!(collection, signer, 1, fakeProvider({ balance: 5n }), { phaseId: "free" }), /capacity/);
  await assert.rejects(() => cookiezFreeV1.buildTransaction!(collection, signer, 2, fakeProvider(), { phaseId: "free" }), /Unsupported/);
});

test("COOKIEZ retries only the exact TooSoon throttle error and suppresses its failure webhook", () => {
  const now = Date.parse("2026-08-30T23:46:00.000Z");
  assert.equal(cookiezSimulationRetryAt({ data: "0x6fed7d85" }, now), "2026-08-30T23:46:01.000Z");
  assert.equal(cookiezSimulationRetryAt({ info: { error: { data: "0x6FED7D85" } } }, now), "2026-08-30T23:46:01.000Z");
  assert.equal(cookiezSimulationRetryAt(new Error('execution reverted (data="0x6fed7d85")'), now), "2026-08-30T23:46:01.000Z");
  assert.equal(cookiezSimulationRetryAt({ message: "missing revert data", transaction: { data: "0xf366afc9" } }, now), "2026-08-30T23:46:01.000Z");
  assert.equal(cookiezSimulationRetryAt({ message: "missing revert data", transaction: { data: "0x12345678" } }, now), null);
  assert.equal(cookiezSimulationRetryAt({ data: "0x951b974f" }, now), null);
  assert.equal(cookiezFreeV1.suppressFailureAlerts, true);
});

test("the shared sequential simulation path converts COOKIEZ TooSoon into a scheduler wait", async () => {
  const provider = {
    call: async () => { throw Object.assign(new Error("execution reverted"), { data: "0x6fed7d85" }); },
  } as unknown as ethers.Provider;
  await assert.rejects(
    () => simulateMintForAdapter(cookiezFreeV1, { to: contractAddress, data: "0xf366afc9", value: 0n }, provider, signer),
    /Mint is scheduled for/,
  );
});
