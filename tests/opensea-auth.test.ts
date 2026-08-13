import assert from "node:assert/strict";
import test from "node:test";
import {
  isOpenSeaScopedTokenLimitError,
  selectStaleOpenSeaSdkToken,
} from "../src/lib/opensea-auth";

test("OpenSea scoped-token cap errors are recognized narrowly", () => {
  assert.equal(isOpenSeaScopedTokenLimitError(new Error(
    'Scoped token creation failed (400): {"error":{"message":"You can create up to 5 scoped tokens per account."}}',
  )), true);
  assert.equal(isOpenSeaScopedTokenLimitError(new Error("Scoped token creation failed (429): rate limited")), false);
  assert.equal(isOpenSeaScopedTokenLimitError(new Error("Wallet is not eligible")), false);
});

test("only the oldest SDK-created OpenSea token is selected for recovery", () => {
  const selected = selectStaleOpenSeaSdkToken([
    { id: "9", label: "manual-trading-token", scopes: ["read:eligibility"], createdAt: "2026-01-01T00:00:00Z" },
    { id: "6", label: "opensea-sdk-50", scopes: ["write:orders"], createdAt: "2026-01-01T00:00:00Z" },
    { id: "8", label: "opensea-sdk-200", scopes: ["read:eligibility"], createdAt: "2026-08-13T11:00:00Z" },
    { id: "7", label: "opensea-sdk-100", scopes: ["read:eligibility"], createdAt: "2026-08-13T10:00:00Z" },
  ]);
  assert.equal(selected?.id, "7");
  assert.equal(selectStaleOpenSeaSdkToken([{ id: "9", label: "manual-trading-token", scopes: ["read:eligibility"] }]), undefined);
  assert.throws(() => selectStaleOpenSeaSdkToken({ tokens: [] }), /invalid scoped-token list/);
});
