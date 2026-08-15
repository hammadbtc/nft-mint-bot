import assert from "node:assert/strict";
import test from "node:test";
import {
  isOpenSeaScopeEntitlementError,
  isOpenSeaScopedTokenLimitError,
  isOpenSeaRateLimitError,
  isOpenSeaWalletAuthError,
  isUsableStoredWalletCredential,
  openSeaRetryAfterMs,
  selectStaleOpenSeaSdkToken,
} from "../src/lib/opensea-auth";

test("encrypted OpenSea wallet credentials are accepted only with eligibility scope and safe lifetime", () => {
  const now = Date.parse("2026-08-15T20:00:00Z");
  assert.equal(isUsableStoredWalletCredential({ refreshToken: "x".repeat(32), expiresAt: now + 3_600_000, scopes: ["read:eligibility"] }, now), true);
  assert.equal(isUsableStoredWalletCredential({ refreshToken: "x".repeat(32), expiresAt: now + 60_000, scopes: ["read:eligibility"] }, now), false);
  assert.equal(isUsableStoredWalletCredential({ refreshToken: "x".repeat(32), expiresAt: now + 3_600_000, scopes: ["write:orders"] }, now), false);
});

test("only credential failures invalidate a persisted OpenSea wallet token", () => {
  assert.equal(isOpenSeaWalletAuthError(new Error("OpenSea scoped token exchange failed (401): Unauthorized")), true);
  assert.equal(isOpenSeaWalletAuthError(new Error("OpenSea eligibility failed (403): wallet is not eligible")), false);
  assert.equal(isOpenSeaWalletAuthError(new Error("Server Error (429): Too Many Requests")), false);
});

test("OpenSea rate limits are recognized without treating eligibility failures as throttling", () => {
  assert.equal(isOpenSeaRateLimitError(new Error("Server Error (429): Too Many Requests")), true);
  const structured = Object.assign(new Error("429 Too Many Requests"), { statusCode: 429 });
  assert.equal(isOpenSeaRateLimitError(structured), true);
  assert.equal(isOpenSeaRateLimitError(new Error("Wallet is not eligible")), false);
});

test("OpenSea retry-after metadata controls SIWE backoff", () => {
  const error = new Error('Nonce request failed (429): {"meta":{"retry-after":11}}');
  assert.equal(openSeaRetryAfterMs(error, 750), 11_250);
  assert.equal(openSeaRetryAfterMs(new Error("429 Too Many Requests"), 1_500), 1_500);
});

test("OpenSea scoped-token cap errors are recognized narrowly", () => {
  assert.equal(isOpenSeaScopedTokenLimitError(new Error(
    'Scoped token creation failed (400): {"error":{"message":"You can create up to 5 scoped tokens per account."}}',
  )), true);
  assert.equal(isOpenSeaScopedTokenLimitError(new Error("Scoped token creation failed (429): rate limited")), false);
  assert.equal(isOpenSeaScopedTokenLimitError(new Error("Wallet is not eligible")), false);
});

test("OpenSea scoped-token entitlement failures trigger the SIWE-session eligibility fallback", () => {
  assert.equal(isOpenSeaScopeEntitlementError(new Error(
    'Scoped token creation failed (400): {"error":{"message":"Requested scopes exceed account entitlement"}}',
  )), true);
  assert.equal(isOpenSeaScopeEntitlementError(new Error("Server Error: Insufficient balance to mint")), false);
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
