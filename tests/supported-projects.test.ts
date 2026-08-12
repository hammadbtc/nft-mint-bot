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
  };
};

const seeds = JSON.parse(readFileSync(new URL("../config/supported-projects.json", import.meta.url), "utf8")) as Seed[];

test("reviewed project seeds have unique identities and exact URL matchers", () => {
  assert.equal(new Set(seeds.map((seed) => seed.id)).size, seeds.length);
  assert.equal(new Set(seeds.map((seed) => seed.contractAddress.toLowerCase())).size, seeds.length);
  for (const seed of seeds) {
    assert.equal(ethers.isAddress(seed.contractAddress), true);
    assert.equal(seed.adapterKey, "opensea-seadrop-v1");
    assert.equal(typeof seed.adapterConfig.seaDropAddress === "string" && ethers.isAddress(seed.adapterConfig.seaDropAddress), true);
    assert.equal(typeof seed.adapterConfig.feeRecipient === "string" && ethers.isAddress(seed.adapterConfig.feeRecipient), true);
    assert.ok(seed.adapterConfig.urlMatchers?.length);
    for (const matcher of seed.adapterConfig.urlMatchers || []) {
      assert.equal(exactUrlPathMatches(`${matcher.path}-lookalike`, matcher.path), false);
      assert.equal(exactUrlPathMatches(`${matcher.path}/claim`, matcher.path), false);
    }
  }
});

test("CHIMPS and WEASELS public phases are explicitly named and bound to supplied paths", () => {
  const chimps = seeds.find((seed) => seed.slug === "chimps-hood");
  const weasels = seeds.find((seed) => seed.slug === "weaselsinstock");
  assert.equal(chimps?.adapterConfig.publicPhaseName, "Public stage");
  assert.equal(weasels?.adapterConfig.publicPhaseName, "FCFS");
  assert.ok(chimps?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/chimps-hood/overview"));
  assert.ok(weasels?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/weaselsinstock/overview"));
});
