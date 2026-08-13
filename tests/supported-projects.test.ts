import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { exactUrlPathMatches } from "../src/lib/adapters";

type Seed = {
  id: string;
  slug: string;
  contractAddress: string;
  adapterKey: string;
  adapterConfig: {
    seaDropAddress?: string;
    feeRecipient?: string;
    publicPhaseName?: string;
    urlMatchers?: Array<{ domain: string; path: string }>;
    mintContract?: string;
    transferPolicy?: string;
    tokenContract?: string;
    expectedPriceWei?: string;
    expectedMaxPerTransaction?: number;
    expectedInventory?: number;
    contractAliases?: string[];
  };
};

const seeds = JSON.parse(readFileSync(new URL("../config/supported-projects.json", import.meta.url), "utf8")) as Seed[];

test("reviewed project seeds have unique identities and exact URL matchers", () => {
  assert.equal(new Set(seeds.map((seed) => seed.id)).size, seeds.length);
  assert.equal(new Set(seeds.map((seed) => seed.contractAddress.toLowerCase())).size, seeds.length);
  const resolvableContracts = seeds.flatMap((seed) => [seed.contractAddress, ...(seed.adapterConfig.contractAliases || [])]).map((address) => address.toLowerCase());
  assert.equal(new Set(resolvableContracts).size, resolvableContracts.length);
  for (const seed of seeds) {
    assert.equal(ethers.isAddress(seed.contractAddress), true);
    assert.ok(["opensea-seadrop-v1", "squiggle-wuiggle-v1"].includes(seed.adapterKey));
    if (seed.adapterKey === "opensea-seadrop-v1") {
      assert.equal(typeof seed.adapterConfig.seaDropAddress === "string" && ethers.isAddress(seed.adapterConfig.seaDropAddress), true);
      assert.equal(typeof seed.adapterConfig.feeRecipient === "string" && ethers.isAddress(seed.adapterConfig.feeRecipient), true);
    } else {
      assert.equal(ethers.isAddress(seed.adapterConfig.mintContract || ""), true);
      assert.equal(ethers.isAddress(seed.adapterConfig.transferPolicy || ""), true);
      assert.equal(ethers.isAddress(seed.adapterConfig.tokenContract || ""), true);
      assert.equal(seed.adapterConfig.expectedPriceWei, "1600000000000000");
      assert.equal(seed.adapterConfig.expectedMaxPerTransaction, 2);
      assert.equal(seed.adapterConfig.expectedInventory, 7500);
    }
    assert.ok(seed.adapterConfig.urlMatchers?.length);
    for (const matcher of seed.adapterConfig.urlMatchers || []) {
      assert.equal(exactUrlPathMatches(`${matcher.path}-lookalike`, matcher.path), false);
      assert.equal(exactUrlPathMatches(`${matcher.path}/claim`, matcher.path), false);
    }
  }
});

test("Squiggle Wuiggle is bound to exact official, explorer, and collection URLs", () => {
  const squiggle = seeds.find((seed) => seed.slug === "squiggle-wuiggle");
  assert.equal(squiggle?.adapterKey, "squiggle-wuiggle-v1");
  assert.ok(squiggle?.adapterConfig.contractAliases?.some((address) => address.toLowerCase() === "0x2897e59840e6e3deb1dbf56dd7f32d20c26a69eb"));
  assert.ok(squiggle?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/squiggle-wuiggle"));
  assert.ok(squiggle?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/squigglerh/status/2087590681426428010"));
});

test("CHIMPS and WEASELS public phases are explicitly named and bound to supplied paths", () => {
  const chimps = seeds.find((seed) => seed.slug === "chimps-hood");
  const weasels = seeds.find((seed) => seed.slug === "weaselsinstock");
  assert.equal(chimps?.adapterConfig.publicPhaseName, "Public stage");
  assert.equal(weasels?.adapterConfig.publicPhaseName, "FCFS");
  assert.ok(chimps?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/chimps-hood/overview"));
  assert.ok(weasels?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/weaselsinstock/overview"));
});
