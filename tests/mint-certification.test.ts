import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMintCertification,
  MINT_CERTIFIER_VERSION,
  REQUIRED_CERTIFICATION_CHECKS,
  signCertificationEvidence,
  type CertificationEvidence,
  type UnsignedCertificationEvidence,
} from "../src/lib/mint-certification";
import {
  hashMintDefinition,
  snapshotCollectionDefinition,
  certificationIntegrityError,
  type MintDefinitionSnapshot,
} from "../src/lib/mint-definitions";
import { stableHash } from "../src/lib/safety";
import { ethers } from "ethers";

const address = "0x0000000000000000000000000000000000000001";
const wallet = "0x1111111111111111111111111111111111111111";
const attestationKey = "certification-test-key-that-is-at-least-32-characters";
const collection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Certification Test",
  contractAddress: address,
  chainId: 1,
  mintMethod: "mint",
  mintAbi: JSON.stringify(["function mint(uint256 quantity) payable"]),
  mintPrice: "1",
  maxPerWallet: 2,
  maxSupply: 100,
  active: false,
  defaultGasLimit: null,
  defaultMaxFeePerGas: null,
  defaultMaxPriorityFeePerGas: null,
  defaultUseFlashbots: false,
  fcfsEnabled: false,
  fcfsMintOpenSignature: null,
  paymentToken: null,
  safetyCheck: true,
  slug: "certification-test",
  adapterKey: "evm-contract-v1",
  domains: '["mint.example.com"]',
  siteUrl: "https://mint.example.com/drop",
  imageUrl: null,
  adapterConfig: JSON.stringify({ engine: "custom-reviewed-v1", phases: [{ id: "public", kind: "public" }] }),
  verified: false,
  broadcastPaused: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function evidenceFor(definition: MintDefinitionSnapshot, overrides: Partial<CertificationEvidence> = {}): CertificationEvidence {
  const definitionHash = hashMintDefinition(definition);
  const dataHash = stableHash("0x12345678");
  const intentHash = stableHash({ chainId: 1, to: address.toLowerCase(), dataHash, value: "1" });
  const transaction = {
    from: wallet,
    to: address,
    recipient: wallet,
    chainId: 1,
    value: "1",
    selector: "0x12345678",
    dataHash,
    intentHash,
    adapterIntentHash: intentHash,
    simulation: "passed" as const,
  };
  const unsigned: UnsignedCertificationEvidence = {
    runnerVersion: MINT_CERTIFIER_VERSION,
    definitionHash,
    sourceCommit: "local",
    mode: "fork",
    observedAt: "2026-08-31T10:00:00.000Z",
    expiresAt: "2026-09-01T10:00:00.000Z",
    chainId: 1,
    blockNumber: 1,
    blockHash: `0x${"ab".repeat(32)}`,
    contracts: [{ role: "collection", address, codeHash: `0x${"cd".repeat(32)}` }],
    transaction,
    phaseTransactions: [{ ...transaction, phaseId: "public", quantity: 1 }],
    checks: REQUIRED_CERTIFICATION_CHECKS.map((id) => ({ id, status: "passed", evidenceHash: stableHash(id) })),
  };
  const evidence = { ...unsigned, attestation: signCertificationEvidence(unsigned, attestationKey), ...overrides };
  return evidence as CertificationEvidence;
}

function reattest(evidence: CertificationEvidence): CertificationEvidence {
  const { attestation, ...unsigned } = evidence;
  assert.match(attestation, /^[a-f0-9]{64}$/);
  return { ...unsigned, attestation: signCertificationEvidence(unsigned, attestationKey) };
}

test("hash-bound fork evidence passes the complete certification policy", () => {
  const definition = snapshotCollectionDefinition(collection);
  const result = evaluateMintCertification({
    definition,
    evidence: evidenceFor(definition),
    expectedSourceCommit: "local",
    attestationKey,
    now: new Date("2026-08-31T12:00:00.000Z"),
  });
  assert.equal(result.passed, true);
  assert.match(result.certificateHash, /^[a-f0-9]{64}$/);
  assert.equal(result.definitionHash, hashMintDefinition(definition));
});

test("certification rejects another definition, commit, chain, or inconsistent intent", () => {
  const definition = snapshotCollectionDefinition(collection);
  const base = evidenceFor(definition);
  for (const { evidence, expectedSourceCommit } of [
    { evidence: reattest({ ...base, definitionHash: "0".repeat(64) }), expectedSourceCommit: "local" },
    { evidence: reattest({ ...base, sourceCommit: "abcdef0" }), expectedSourceCommit: "1234567" },
    { evidence: reattest({ ...base, chainId: 4663 }), expectedSourceCommit: "local" },
    { evidence: reattest({ ...base, transaction: { ...base.transaction, intentHash: "0".repeat(64) } }), expectedSourceCommit: "local" },
  ]) {
    const result = evaluateMintCertification({
      definition,
      evidence,
      expectedSourceCommit,
      attestationKey,
      now: new Date("2026-08-31T12:00:00.000Z"),
    });
    assert.equal(result.passed, false);
  }
});

test("signed phases cannot certify without wallet-payload arming capabilities", () => {
  const definition = snapshotCollectionDefinition({
    ...collection,
    adapterConfig: JSON.stringify({ engine: "custom-reviewed-v1", phases: [{ id: "allowlist", kind: "signed" }] }),
  });
  const result = evaluateMintCertification({
    definition,
    evidence: evidenceFor(definition),
    expectedSourceCommit: "local",
    attestationKey,
    now: new Date("2026-08-31T12:00:00.000Z"),
  });
  assert.equal(result.passed, false);
  assert.match(result.checks.find((check) => check.id === "adapter-config")?.message || "", /signed/);
});

test("certification requires exact domains and a complete evidence matrix", () => {
  const invalidDomain = snapshotCollectionDefinition({ ...collection, domains: '["*.example.com"]' });
  assert.equal(evaluateMintCertification({
    definition: invalidDomain,
    evidence: evidenceFor(invalidDomain),
    expectedSourceCommit: "local",
    attestationKey,
    now: new Date("2026-08-31T12:00:00.000Z"),
  }).passed, false);

  const definition = snapshotCollectionDefinition(collection);
  assert.throws(() => evaluateMintCertification({
    definition,
    evidence: { ...evidenceFor(definition), checks: evidenceFor(definition).checks.slice(1) } as CertificationEvidence,
    expectedSourceCommit: "local",
    attestationKey,
  }));
});

test("persisted certificates are content-addressed and tamper evident", () => {
  const definition = snapshotCollectionDefinition(collection);
  const definitionHash = hashMintDefinition(definition);
  const checks = [{ id: "seed", passed: true }];
  const evidence = { mode: "seed-static" };
  const evidenceHash = stableHash(evidence);
  const runnerVersion = "seed-certifier-v1";
  const checksJson = JSON.stringify(checks);
  const certificateHash = stableHash({ runnerVersion, definitionHash, evidenceHash, checksJson });
  const certificate = {
    id: "cert",
    definitionVersionId: "version",
    status: "passed",
    checksJson,
    definitionHash,
    evidenceJson: JSON.stringify(evidence),
    evidenceHash,
    runnerVersion,
    sourceCommit: null,
    certificateHash,
    certifiedAt: "2026-08-31T12:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: "2026-08-31T12:00:00.000Z",
  };
  assert.equal(certificationIntegrityError(certificate, definitionHash), null);
  assert.match(certificationIntegrityError({ ...certificate, evidenceJson: "{}" }, definitionHash) || "", /evidence hash/);
  assert.match(certificationIntegrityError({ ...certificate, runnerVersion: "unknown-runner" }, definitionHash) || "", /not trusted/);
});

test("reviewed-call certification requires fork evidence for every exact phase transaction", () => {
  const reviewedCollection = {
    ...collection,
    mintMethod: "mint(uint256)",
    adapterKey: "reviewed-call-v1",
    adapterConfig: JSON.stringify({
      schemaVersion: 1,
      engine: "custom-reviewed-v1",
      phases: [{
        id: "public",
        name: "Public",
        kind: "public",
        opening: { mode: "time" },
        unitPriceWei: "1",
        maxPerWallet: 2,
        eligibility: { strategy: "public" },
        call: {
          target: { source: "collection" },
          function: "mint(uint256)",
          args: [{ source: "quantity" }],
          value: { source: "unit-price-times-quantity" },
        },
      }],
    }),
  };
  const definition = snapshotCollectionDefinition(reviewedCollection);
  const missing = reattest({ ...evidenceFor(definition), phaseTransactions: undefined });
  assert.equal(evaluateMintCertification({
    definition,
    evidence: missing,
    expectedSourceCommit: "local",
    attestationKey,
    now: new Date("2026-08-31T12:00:00.000Z"),
  }).passed, false);

  const iface = new ethers.Interface(JSON.parse(reviewedCollection.mintAbi));
  const data = iface.encodeFunctionData("mint(uint256)", [2]);
  const dataHash = stableHash(data.toLowerCase());
  const intentHash = stableHash({ chainId: 1, to: address.toLowerCase(), dataHash, value: "2" });
  const transaction = {
    from: wallet,
    to: address,
    recipient: wallet,
    chainId: 1,
    value: "2",
    selector: data.slice(0, 10),
    dataHash,
    intentHash,
    adapterIntentHash: intentHash,
    simulation: "passed" as const,
  };
  const complete = reattest({
    ...missing,
    transaction,
    phaseTransactions: [{ ...transaction, phaseId: "public", quantity: 2 }],
  });
  assert.equal(evaluateMintCertification({
    definition,
    evidence: complete,
    expectedSourceCommit: "local",
    attestationKey,
    now: new Date("2026-08-31T12:00:00.000Z"),
  }).passed, true);
});
