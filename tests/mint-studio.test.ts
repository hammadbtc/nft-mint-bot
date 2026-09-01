import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildStudioDraftPayload,
  certificationCommand,
  emptyStudioDraft,
  studioDomains,
  studioDraftFromResolver,
} from "../src/lib/mint-studio";

const publicConfig = {
  schemaVersion: 1,
  engine: "custom-reviewed-v1",
  phases: [{
    id: "public", name: "Public", kind: "public",
    opening: { mode: "time" }, unitPriceWei: "1", maxPerWallet: 2,
    eligibility: { strategy: "public" },
    call: {
      target: { source: "collection" }, function: "mint(address,uint256)",
      args: [{ source: "wallet" }, { source: "quantity" }],
      value: { source: "unit-price-times-quantity" },
    },
  }],
};

test("Mint Studio compiles exact typed registration payloads and deduplicates domains", () => {
  const payload = buildStudioDraftPayload({
    ...emptyStudioDraft,
    name: "Byte Mint",
    slug: "byte-mint",
    chainId: "8453",
    contractAddress: "0x0000000000000000000000000000000000000001",
    siteUrl: "https://mint.example",
    domains: "mint.example, mint.example\nwww.mint.example",
    mintMethod: "mint(address,uint256)",
    mintAbi: JSON.stringify(["function mint(address,uint256) payable"]),
    mintPrice: "1",
    maxPerWallet: "2",
    adapterConfig: JSON.stringify(publicConfig),
  });
  assert.equal(payload.chainId, 8453);
  assert.deepEqual(payload.domains, ["mint.example", "www.mint.example"]);
  assert.equal(payload.maxPerWallet, 2);
  assert.deepEqual(payload.mintAbi, ["function mint(address,uint256) payable"]);
  assert.deepEqual(payload.adapterConfig, publicConfig);
});

test("Mint Studio rejects ambiguous numeric and JSON draft fields before registration", () => {
  const base = { ...emptyStudioDraft, domains: "mint.example" };
  assert.throws(() => buildStudioDraftPayload({ ...base, chainId: "1.5" }), /Chain ID/);
  assert.throws(() => buildStudioDraftPayload({ ...base, mintAbi: "not-json" }), /Mint ABI must be valid JSON/);
  assert.throws(() => buildStudioDraftPayload({ ...base, mintAbi: "[]" }), /at least one entry/);
  assert.deepEqual(studioDomains("Example.com, example.com\nMINT.EXAMPLE"), ["example.com", "mint.example"]);
});

test("resolver prefill preserves operator-only fields and formats evidence-backed config", () => {
  const result = studioDraftFromResolver({
    name: "Resolved", chainId: 1,
    contractAddress: "0x0000000000000000000000000000000000000001",
    mintMethod: "mint(address,uint256)",
    mintAbi: ["function mint(address,uint256) payable"],
    domains: ["mint.example"],
    adapterConfig: publicConfig,
  }, { ...emptyStudioDraft, id: "existing-id", imageUrl: "https://image.example/a.png" });
  assert.equal(result.id, "existing-id");
  assert.equal(result.imageUrl, "https://image.example/a.png");
  assert.match(result.mintAbi, /function mint/);
  assert.match(result.adapterConfig, /custom-reviewed-v1/);
});

test("Mint Studio surfaces the controlled certifier and explicit safety confirmations", async () => {
  assert.match(certificationCommand("version-id"), /support:certify-definition -- version-id/);
  const page = await readFile(new URL("../src/app/studio/page.tsx", import.meta.url), "utf8");
  assert.match(page, /RELEASE BROADCAST/);
  assert.match(page, /SCHEDULE LIVE/);
  assert.match(page, /const \[dryRun, setDryRun\] = useState\(true\)/);
  assert.match(page, /x-support-admin-token/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(page, /eligibility-artifacts/);
  assert.match(page, /\/cutover/);
  assert.match(page, /\/readiness/);
});
