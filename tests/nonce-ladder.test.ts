import assert from "node:assert/strict";
import test from "node:test";
import { sequentialNonces } from "../src/lib/transactions.ts";

test("nonce ladders are contiguous and preserve transaction order", () => {
  assert.deepEqual(sequentialNonces(20, 5), [20, 21, 22, 23, 24]);
});

test("nonce ladders reject empty, excessive, and unsafe reservations", () => {
  assert.throws(() => sequentialNonces(0, 0));
  assert.throws(() => sequentialNonces(0, 101));
  assert.throws(() => sequentialNonces(Number.MAX_SAFE_INTEGER, 2));
});
