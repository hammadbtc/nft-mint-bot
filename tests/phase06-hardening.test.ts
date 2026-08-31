import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { compareMintIntents, cutoverReadiness } from "../src/lib/mint-cutover";
import { buildIncidentReplayBundle } from "../src/lib/incident-replay";
import { summarizeReadiness } from "../src/lib/mint-readiness";
import { stableHash } from "../src/lib/safety";
import {
  assertExactCertificationIntent,
  canonicalCertificationIntent,
  certificationPhaseIds,
} from "../src/lib/adapter-certification";

const baseIntent = { chainId: 8453, to: "0x0000000000000000000000000000000000000011", data: "0x12345678", value: 10n };

test("shadow parity compares exact chain, target, calldata, and value", () => {
  const match = compareMintIntents(baseIntent, { ...baseIntent });
  assert.equal(match.status, "match");
  assert.equal(match.legacyIntentHash, match.candidateIntentHash);
  const mismatch = compareMintIntents(baseIntent, { ...baseIntent, data: "0x1234567800" });
  assert.equal(mismatch.status, "mismatch");
  assert.deepEqual(mismatch.diff.changedFields, ["data"]);
  assert.equal("data" in mismatch.diff, false, "replay diff must not retain calldata");
});

test("cutover cannot become ready with one mismatch, one error, or too few samples", () => {
  assert.equal(cutoverReadiness({ requiredSamples: 20, matchedCount: 20, mismatchedCount: 0, errorCount: 0 }).ready, true);
  assert.equal(cutoverReadiness({ requiredSamples: 20, matchedCount: 100, mismatchedCount: 1, errorCount: 0 }).ready, false);
  assert.equal(cutoverReadiness({ requiredSamples: 20, matchedCount: 100, mismatchedCount: 0, errorCount: 1 }).ready, false);
  assert.equal(cutoverReadiness({ requiredSamples: 20, matchedCount: 19, mismatchedCount: 0, errorCount: 0 }).ready, false);
});

test("incident replay is deterministic and strips signing/provider secrets", () => {
  const input = {
    trigger: "failed",
    job: { id: "job", definitionSnapshot: "secret-config" },
    attempts: [{ rawTx: "0xsigned", txHash: "0xpublic", error: "https://host/v2/super-secret-provider-token" }],
    broadcasts: [], stages: [], controls: [], cutover: null,
    shadowComparisons: [{ diffJson: "{}", encryptedPayload: "proof" }],
  };
  const left = buildIncidentReplayBundle(input);
  const right = buildIncidentReplayBundle(input);
  assert.equal(stableHash(left), stableHash(right));
  const encoded = JSON.stringify(left);
  assert.doesNotMatch(encoded, /0xsigned|secret-config|super-secret-provider-token|proof/);
  assert.match(encoded, /\[REDACTED\]/);
});

test("per-wallet readiness fails closed but distinguishes non-blocking warnings", () => {
  assert.equal(summarizeReadiness([{ key: "job", status: "warn", detail: "not scheduled" }]).status, "warning");
  assert.equal(summarizeReadiness([{ key: "rpc", status: "fail", detail: "down" }]).status, "blocked");
  assert.equal(summarizeReadiness([{ key: "rpc", status: "pass", detail: "up" }]).status, "ready");
});

test("Phase 6 database constraints make duplicate worker comparisons idempotent", async () => {
  const migration = await readFile(new URL("../drizzle/0011_phase06_cutover_hardening.sql", import.meta.url), "utf8");
  assert.match(migration, /mint_shadow_comparison_job_candidate_phase_cycle_unique/);
  assert.match(migration, /"audit_cycle"/);
  assert.match(migration, /CHECK \("status" IN \('match', 'mismatch', 'error'\)\)/);
  assert.match(migration, /mint_incident_bundles_hash_unique/);
  assert.match(migration, /mint_cutover_candidate_immutable_trigger/);
});

test("certification enumerates every executable phase and compares exact adapter bytes", () => {
  const collection = {
    id: "collection", name: "Test", contractAddress: baseIntent.to, chainId: 8453,
    mintMethod: "mint", mintAbi: "[]", mintPrice: "0", maxPerWallet: 1,
    maxSupply: null, active: false, defaultGasLimit: null, defaultMaxFeePerGas: null,
    defaultMaxPriorityFeePerGas: null, defaultUseFlashbots: false, fcfsEnabled: false,
    fcfsMintOpenSignature: null, paymentToken: null, safetyCheck: true, slug: "test",
    adapterKey: "evm-contract-v1", domains: "[]", siteUrl: null, imageUrl: null,
    adapterConfig: JSON.stringify({ phases: [{ id: "allowlist" }, { id: "public" }] }),
    verified: false, broadcastPaused: true, createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(certificationPhaseIds(collection), ["allowlist", "public"]);
  const expected = canonicalCertificationIntent(baseIntent);
  assert.doesNotThrow(() => assertExactCertificationIntent(expected, canonicalCertificationIntent({ ...baseIntent })));
  assert.throws(
    () => assertExactCertificationIntent(expected, canonicalCertificationIntent({ ...baseIntent, data: "0x1234567800" })),
    /data differs/,
  );
});

test("security migration makes activation, cutover, and broadcast release fail closed", async () => {
  const phase2 = await readFile(new URL("../drizzle/0007_phase02_certification.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0012_security_audit_hardening.sql", import.meta.url), "utf8");
  const verifier = await readFile(new URL("../scripts/verify-mint-foundation.mjs", import.meta.url), "utf8");
  assert.match(phase2, /runner_version = 'mint-certifier-v1'/);
  assert.match(phase2, /replacement mint definition requires a ready exact-parity cutover/);
  assert.match(migration, /runner_version = 'mint-certifier-v1'/);
  assert.doesNotMatch(migration, /seed-certifier-v1/);
  assert.match(migration, /Machine certification required after security hardening/);
  assert.match(migration, /replacement mint definition requires a ready exact-parity cutover/);
  assert.match(migration, /mint_cutover_status_transition_valid_trigger/);
  assert.match(migration, /mint_broadcast_release_valid_trigger/);
  assert.match(migration, /broadcast release requires completed exact-parity cutover/);
  assert.match(migration, /Active definition required after security hardening/);
  assert.match(verifier, /c\.broadcast_paused = false/);
  assert.match(verifier, /released_collections_without_active_definition/);
});

test("deploy-time project seeding stages immutable drafts and cannot certify or activate", async () => {
  const seed = await readFile(new URL("../scripts/seed-supported-projects.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(seed, /mint_certifications/);
  assert.doesNotMatch(seed, /set\s+status\s*=\s*'active'/);
  assert.match(seed, /status: "draft"/);
  assert.match(seed, /never mutate live execution fields, certify, or/);
});

test("runtime execution rejects retired definition jobs and requires exact phase-priced ERC-20 approvals", async () => {
  const definitions = await readFile(new URL("../src/lib/mint-definitions.ts", import.meta.url), "utf8");
  const engine = await readFile(new URL("../src/lib/engine/mint.ts", import.meta.url), "utf8");
  assert.match(definitions, /version\.status !== "active"/);
  assert.match(definitions, /runnerVersion, "mint-certifier-v1"/);
  assert.match(engine, /BigInt\(phase\.priceWei\) \* BigInt\(job\.quantity\)/);
  assert.doesNotMatch(engine, /BigInt\(collection\.mintPrice[^\n]*job\.quantity/);
});

test("rollback starts a new isolated parity cycle instead of reusing stale samples", async () => {
  const route = await readFile(new URL("../src/app/api/collections/[id]/cutover/route.ts", import.meta.url), "utf8");
  assert.match(route, /auditCycle: state\.auditCycle \+ 1/);
  assert.match(route, /mintShadowComparisons\.auditCycle, state\.auditCycle/);
  assert.match(route, /Cutover rollback:/);
});
