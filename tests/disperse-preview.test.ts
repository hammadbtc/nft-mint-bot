import test from "node:test";
import assert from "node:assert/strict";
import { validateDisperseRefresh, type DisperseInput, type DispersePreview } from "../src/lib/disperse";
import { stableHash } from "../src/lib/safety";

const main = "11111111-1111-4111-8111-111111111111";
const worker = "22222222-2222-4222-8222-222222222222";
const input: DisperseInput = { type: "fund", mainWalletId: main, workerWalletIds: [worker], chainId: 4663, amountPerWallet: "1" };

function preview(maxFeePerGas: bigint): DispersePreview {
  const transfer = { fromWalletId: main, toWalletId: worker, amountWei: "1000000000000000000", gasLimit: "25200", maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: null };
  const estimatedGasWei = (25200n * maxFeePerGas).toString();
  const core = { version: 2 as const, type: "fund" as const, mainWalletId: main, workerWalletIds: [worker], chainId: 4663, transfers: [transfer], estimatedGasWei, totalRequiredWei: (1_000_000_000_000_000_000n + BigInt(estimatedGasWei)).toString() };
  return { ...core, generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), fingerprint: stableHash(core) };
}

test("Disperse accepts a fresh fee quote within the reviewed ceiling", () => {
  const expected = preview(300n);
  const current = preview(360n); // represents a current base quote of 120
  assert.doesNotThrow(() => validateDisperseRefresh(input, expected, current, BigInt(expected.totalRequiredWei)));
});

test("Disperse rejects fee movement above the reviewed ceiling", () => {
  const expected = preview(300n);
  const current = preview(930n); // represents a current base quote of 310
  assert.throws(() => validateDisperseRefresh(input, expected, current, BigInt(expected.totalRequiredWei)), /fee exceeded/);
});

test("Disperse rejects a modified reviewed preview", () => {
  const expected = preview(125n);
  expected.transfers[0]!.amountWei = "2000000000000000000";
  assert.throws(() => validateDisperseRefresh(input, expected, preview(125n), 3_000_000_000_000_000_000n), /modified/);
});

test("Disperse sweep accepts fee movement when the reviewed sweep remains funded", () => {
  const sweepInput: DisperseInput = { type: "sweep", mainWalletId: main, workerWalletIds: [worker], chainId: 4663 };
  const makeSweep = (amount: bigint, maxFee: bigint): DispersePreview => {
    const transfer = { fromWalletId: worker, toWalletId: main, amountWei: amount.toString(), gasLimit: "25200", maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: null };
    const gas = 25200n * maxFee;
    const core = { version: 2 as const, type: "sweep" as const, mainWalletId: main, workerWalletIds: [worker], chainId: 4663, transfers: [transfer], estimatedGasWei: gas.toString(), totalRequiredWei: amount.toString() };
    return { ...core, generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), fingerprint: stableHash(core) };
  };
  const balance = 10_000_000n;
  const expected = makeSweep(balance - 25200n * 300n, 300n);
  const current = makeSweep(balance - 25200n * 360n, 360n);
  assert.doesNotThrow(() => validateDisperseRefresh(sweepInput, expected, current));
});
