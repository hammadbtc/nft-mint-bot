import test from "node:test";
import assert from "node:assert/strict";
import { phaseHasEligibleWallet, phaseIsRunnable } from "../src/lib/phase-selection";

test("phase selection depends only on wallet eligibility", () => {
  assert.equal(phaseHasEligibleWallet([{ status: "eligible" }]), true);
  assert.equal(phaseHasEligibleWallet([{ status: "ineligible" }]), false);
  assert.equal(phaseHasEligibleWallet([{ status: "unknown" }]), false);
  assert.equal(phaseHasEligibleWallet([{ status: "unsupported" }]), false);
});

test("runtime phase status is a separate scheduling decision", () => {
  assert.equal(phaseIsRunnable("live"), true);
  assert.equal(phaseIsRunnable("upcoming"), true);
  assert.equal(phaseIsRunnable("ended"), false);
  assert.equal(phaseIsRunnable("unknown"), false);
});
