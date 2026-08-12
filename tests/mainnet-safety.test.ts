import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { exactUrlPathMatches } from "../src/lib/adapters";
import { recoveredJobStatus, selectExecutionPhase } from "../src/lib/mint-policy";
import { mintWalletEligibilityError } from "../src/lib/mint-wallet-policy";
import { broadcastPreparedTransaction, exactSimulationRequest } from "../src/lib/transactions";
import { liveTransactionsEnabled, safeErrorMessage, safeSecretEqual, stableHash } from "../src/lib/safety";

test("reviewed mint URL paths match exactly, not by dangerous prefix", () => {
  assert.equal(exactUrlPathMatches("/collection/cash-rabbits/overview", "/collection/cash-rabbits/overview"), true);
  assert.equal(exactUrlPathMatches("//collection//cash-rabbits//overview/", "/collection/cash-rabbits/overview"), true);
  assert.equal(exactUrlPathMatches("/collection/cash-rabbits/overview-evil", "/collection/cash-rabbits/overview"), false);
  assert.equal(exactUrlPathMatches("/collection/cash-rabbits/overview/claim", "/collection/cash-rabbits/overview"), false);
});

test("phase policy prefers live then earliest valid upcoming and rejects ended", () => {
  const upcoming = selectExecutionPhase([
    { id: "late", name: "late", status: "upcoming", startsAt: "2030-01-02T00:00:00.000Z" },
    { id: "early", name: "early", status: "upcoming", startsAt: "2030-01-01T00:00:00.000Z" },
  ]);
  assert.equal(upcoming.id, "early");
  assert.equal(selectExecutionPhase([{ id: "live", name: "live", status: "live" }, upcoming]).id, "live");
  assert.throws(() => selectExecutionPhase([{ id: "ended", name: "ended", status: "ended" }]), /ended or has no runnable phase/);
});

test("restart recovery resumes after approval and only completes after mint confirmation", () => {
  assert.equal(recoveredJobStatus("approval", true), "pending");
  assert.equal(recoveredJobStatus("mint", true), "completed");
  assert.equal(recoveredJobStatus("approval", false), "failed");
  assert.equal(recoveredJobStatus("mint", false), "failed");
});

test("exact simulation always includes the signing wallet as from", () => {
  const request = exactSimulationRequest({ to: "0x0000000000000000000000000000000000000001", value: 1n }, "0x0000000000000000000000000000000000000002");
  assert.equal(request.from, "0x0000000000000000000000000000000000000002");
});

test("live broadcasting requires two independent explicit gates", () => {
  const previousEnabled = process.env.ENABLE_LIVE_TRANSACTIONS;
  const previousConfirmed = process.env.LIVE_TRANSACTIONS_CONFIRMED;
  process.env.ENABLE_LIVE_TRANSACTIONS = "true";
  process.env.LIVE_TRANSACTIONS_CONFIRMED = "";
  assert.equal(liveTransactionsEnabled(), false);
  process.env.LIVE_TRANSACTIONS_CONFIRMED = "I_UNDERSTAND";
  assert.equal(liveTransactionsEnabled(), true);
  if (previousEnabled === undefined) delete process.env.ENABLE_LIVE_TRANSACTIONS; else process.env.ENABLE_LIVE_TRANSACTIONS = previousEnabled;
  if (previousConfirmed === undefined) delete process.env.LIVE_TRANSACTIONS_CONFIRMED; else process.env.LIVE_TRANSACTIONS_CONFIRMED = previousConfirmed;
});

test("main wallets can mint while workers still require an active same-chain main", () => {
  const main = { active: true, role: "main", parentWalletId: null, chainId: 4663 };
  const worker = { active: true, role: "worker", parentWalletId: "main-id", chainId: 4663 };
  assert.equal(mintWalletEligibilityError(main, 4663), null);
  assert.equal(mintWalletEligibilityError(worker, 4663, main), null);
  assert.match(mintWalletEligibilityError(worker, 4663) || "", /active main wallet/);
  assert.match(mintWalletEligibilityError({ ...main, active: false }, 4663) || "", /inactive/);
  assert.match(mintWalletEligibilityError(main, 1) || "", /wrong network/);
});

test("operator errors redact wallet keys, provider keys, credentials, and tokens", () => {
  const message = safeErrorMessage(new Error("ghp_abcdefghijklmnopqrstuvwxyz123456 https://user:pass@example.com/v2/abcdefghijklmnopqrstu?api_key=secret 0x" + "ab".repeat(32)));
  assert.equal(message.includes("ghp_"), false);
  assert.equal(message.includes("pass"), false);
  assert.equal(message.includes("abcdefghijklmnopqrstu"), false);
  assert.equal(message.includes("abababab"), false);
});

test("stable request hashes ignore object key order and secret comparison is exact", () => {
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
  assert.equal(safeSecretEqual("same", "same"), true);
  assert.equal(safeSecretEqual("same", "different"), false);
});

test("ambiguous broadcast recovery reconciles the precomputed transaction hash", async () => {
  const wallet = ethers.Wallet.createRandom();
  const raw = await wallet.signTransaction({ chainId: 1, nonce: 0, to: ethers.ZeroAddress, value: 0, gasLimit: 21_000, gasPrice: 1 });
  const hash = ethers.keccak256(raw);
  const existing = { hash } as ethers.TransactionResponse;
  const provider = {
    broadcastTransaction: async () => { throw new Error("timeout after send"); },
    getTransaction: async (requested: string) => requested === hash ? existing : null,
  } as unknown as ethers.Provider;
  assert.equal(await broadcastPreparedTransaction(provider, raw, hash), existing);
});
