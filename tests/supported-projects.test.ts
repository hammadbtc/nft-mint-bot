import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { exactUrlPathMatches } from "../src/lib/adapters";

type Seed = {
  id: string;
  slug: string;
  contractAddress: string;
  mintPrice: string;
  imageUrl?: string;
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
    expectedMintPriceWei?: string;
    expectedMaxPerWallet?: number;
    expectedFreePerWallet?: number;
    expectedMintIntervalSecs?: number;
    expectedValueWei?: string;
    engine?: string;
    expectedMerkleRoot?: string;
    expectedMaxSupply?: number;
    expectedReserveSupply?: number;
    expectedWhitelistCount?: number;
    whitelistUrl?: string;
    contractAliases?: string[];
    openSeaSlug?: string;
    stages?: Array<{
      id: string;
      name: string;
      kind: "signed" | "public";
      stageType: string;
      startsAt: string;
      endsAt: string;
      priceWei: string;
      maxPerWallet: number;
      dropStageIndex?: number;
      maxTokenSupplyForStage?: number;
      feeBps?: number;
      restrictFeeRecipients?: boolean;
    }>;
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
    assert.ok(["opensea-seadrop-v1", "opensea-signed-seadrop-v1", "squiggle-wuiggle-v1", "bulls-runners-v1", "terminal-assistants-v1", "cookiez-free-v1"].includes(seed.adapterKey));
    if (seed.adapterKey.startsWith("opensea-")) {
      assert.equal(typeof seed.adapterConfig.seaDropAddress === "string" && ethers.isAddress(seed.adapterConfig.seaDropAddress), true);
      assert.equal(typeof seed.adapterConfig.feeRecipient === "string" && ethers.isAddress(seed.adapterConfig.feeRecipient), true);
    } else if (seed.adapterKey === "squiggle-wuiggle-v1") {
      assert.equal(ethers.isAddress(seed.adapterConfig.mintContract || ""), true);
      assert.equal(ethers.isAddress(seed.adapterConfig.transferPolicy || ""), true);
      assert.equal(ethers.isAddress(seed.adapterConfig.tokenContract || ""), true);
      assert.equal(seed.adapterConfig.expectedPriceWei, "1600000000000000");
      assert.equal(seed.adapterConfig.expectedMaxPerTransaction, 2);
      assert.equal(seed.adapterConfig.expectedInventory, 7500);
    } else if (seed.adapterKey === "bulls-runners-v1") {
      assert.equal(ethers.isHexString(seed.adapterConfig.expectedMerkleRoot || "", 32), true);
      assert.equal(seed.adapterConfig.expectedMaxSupply, 4200);
      assert.equal(seed.adapterConfig.expectedReserveSupply, 420);
      assert.equal(seed.adapterConfig.expectedWhitelistCount, 4880);
      assert.equal(seed.adapterConfig.whitelistUrl, "https://bullsrunners.com/whitelist.json");
    } else if (seed.adapterKey === "cookiez-free-v1") {
      assert.equal(seed.adapterConfig.expectedMaxSupply, 10000);
      assert.equal(seed.adapterConfig.expectedFreePerWallet, 5);
      assert.equal(seed.adapterConfig.expectedMintIntervalSecs, 10);
      assert.equal(seed.adapterConfig.expectedValueWei, "0");
      assert.equal(seed.adapterConfig.engine, "sequential-confirmed-v1");
    } else {
      assert.equal(seed.adapterConfig.expectedMaxSupply, 6666);
      assert.equal(seed.adapterConfig.expectedMintPriceWei, "1300000000000000");
      assert.equal(seed.adapterConfig.expectedMaxPerWallet, 5);
    }
    assert.ok(seed.adapterConfig.urlMatchers?.length);
    for (const matcher of seed.adapterConfig.urlMatchers || []) {
      assert.equal(exactUrlPathMatches(`${matcher.path}-lookalike`, matcher.path), false);
      assert.equal(exactUrlPathMatches(`${matcher.path}/claim`, matcher.path), false);
    }
  }
});

test("Bulls Runners is bound to the reviewed site, docs, explorer, and one-per-wallet contract", () => {
  const bulls = seeds.find((seed) => seed.slug === "bulls-runners");
  assert.equal(bulls?.adapterKey, "bulls-runners-v1");
  assert.equal(bulls?.contractAddress.toLowerCase(), "0x4d908ec6f8b6b63dcd57e68ede19e595c402d83b");
  assert.equal(bulls?.adapterConfig.urlMatchers?.some((matcher) => matcher.domain === "bullsrunners.com" && matcher.path === "/mint"), true);
  assert.equal(bulls?.adapterConfig.urlMatchers?.some((matcher) => matcher.domain === "bullsrunners.com" && matcher.path === "/docs"), true);
  assert.equal(bulls?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x4d908ec6f8b6b63dcd57e68ede19e595c402d83b"), true);
});

test("Terminal Assistants is bound to the official stealth-mint sources and reviewed contract", () => {
  const terminal = seeds.find((seed) => seed.slug === "terminal-assistants");
  assert.equal(terminal?.adapterKey, "terminal-assistants-v1");
  assert.equal(terminal?.contractAddress.toLowerCase(), "0xd27039734219816fef06244d5745fe73abef832d");
  assert.equal(terminal?.mintPrice, "1300000000000000");
  assert.equal(terminal?.adapterConfig.expectedMaxPerWallet, 5);
  assert.equal(terminal?.adapterConfig.urlMatchers?.some((matcher) => matcher.domain === "terminalrh.xyz" && matcher.path === "/"), true);
  assert.equal(terminal?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/terminalassist/status/2089039200888688652"), true);
  assert.equal(terminal?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/terminalassist/status/2089378288410018080"), true);
});

test("Squiggle Wuiggle is bound to exact official, explorer, and collection URLs", () => {
  const squiggle = seeds.find((seed) => seed.slug === "squiggle-wuiggle");
  assert.equal(squiggle?.adapterKey, "squiggle-wuiggle-v1");
  assert.ok(squiggle?.adapterConfig.contractAliases?.some((address) => address.toLowerCase() === "0x2897e59840e6e3deb1dbf56dd7f32d20c26a69eb"));
  assert.equal(squiggle?.adapterConfig.urlMatchers?.some((matcher) => matcher.domain === "squiggle-wuiggle.xyz" && matcher.path === "/"), true);
  assert.equal(exactUrlPathMatches("/claim", "/"), false);
  assert.ok(squiggle?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/squiggle-wuiggle"));
  assert.ok(squiggle?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/squigglerh/status/2087590681426428010"));
});

test("CHIMPS, WEASELS, and Purr Cat public phases are named and bound to supplied paths", () => {
  const chimps = seeds.find((seed) => seed.slug === "chimps-hood");
  const weasels = seeds.find((seed) => seed.slug === "weaselsinstock");
  const purrCat = seeds.find((seed) => seed.slug === "purr-cats-nft");
  assert.equal(chimps?.adapterConfig.publicPhaseName, "Public stage");
  assert.equal(weasels?.adapterConfig.publicPhaseName, "FCFS");
  assert.equal(purrCat?.adapterKey, "opensea-seadrop-v1");
  assert.equal(purrCat?.adapterConfig.publicPhaseName, "Public Mint");
  assert.ok(chimps?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/chimps-hood/overview"));
  assert.ok(weasels?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/weaselsinstock/overview"));
  assert.ok(purrCat?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/purr-cats-nft/overview"));
  assert.ok(purrCat?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0xce905281c45014b37a4597f9964299f1e9b6df06"));
});

test("XCOPUNKS and Cash Dogs are bound to their reviewed OpenSea public drops", () => {
  const xcopunks = seeds.find((seed) => seed.slug === "xcopunks");
  const cashDogs = seeds.find((seed) => seed.slug === "cash-dogs-");
  assert.equal(xcopunks?.adapterKey, "opensea-seadrop-v1");
  assert.equal(xcopunks?.contractAddress.toLowerCase(), "0xfcba20492b1cd40607b13c9f61b6b6d416a08cf7");
  assert.equal(xcopunks?.adapterConfig.publicPhaseName, "Public Mint");
  assert.ok(xcopunks?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/xcopunks/overview"));
  assert.ok(xcopunks?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0xfcba20492b1cd40607b13c9f61b6b6d416a08cf7"));
  assert.equal(cashDogs?.adapterKey, "opensea-seadrop-v1");
  assert.equal(cashDogs?.contractAddress.toLowerCase(), "0x904a3f7e32d7259d9b520b5c0c158e5c3a60d860");
  assert.equal(cashDogs?.adapterConfig.publicPhaseName, "Public Mint");
  assert.ok(cashDogs?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/cash-dogs-/overview"));
  assert.ok(cashDogs?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x904a3f7e32d7259d9b520b5c0c158e5c3a60d860"));
});

test("NitroCode is bound to its reviewed free OpenSea public drop", () => {
  const nitroCode = seeds.find((seed) => seed.slug === "nitrocode");
  assert.equal(nitroCode?.adapterKey, "opensea-seadrop-v1");
  assert.equal(nitroCode?.contractAddress.toLowerCase(), "0x2c15d479361cc5c07d24717efde841caebee39c0");
  assert.equal(nitroCode?.mintPrice, "0");
  assert.match(nitroCode?.imageUrl || "", /^https:\/\/i2c\.seadn\.io\//);
  assert.equal(nitroCode?.adapterConfig.publicPhaseName, "Public Mint");
  assert.ok(nitroCode?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/nitrocode/overview"));
  assert.ok(nitroCode?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x2c15d479361cc5c07d24717efde841caebee39c0"));
});

test("OMR EVO pins its signed stages and public sale", () => {
  const omr = seeds.find((seed) => seed.slug === "omrevo");
  assert.equal(omr?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(omr?.contractAddress.toLowerCase(), "0x8761d975bc4eccaf48cb650fb0871e066058ea61");
  assert.equal(omr?.adapterConfig.openSeaSlug, "omrevo");
  assert.deepEqual(omr?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["team", "signed", "0", 25],
    ["omr-holder", "signed", "0", 2],
    ["ratlist", "signed", "1500000000000000", 2],
    ["public", "public", "3000000000000000", 7],
  ]);
  assert.deepEqual(omr?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, 3, undefined]);
  assert.deepEqual(omr?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [3333, 1000, true], [3333, 1000, true], [3333, 1000, true],
  ]);
  assert.equal(omr?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/omrevo/overview"), true);
  assert.equal(omr?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x8761d975bc4eccaf48cb650fb0871e066058ea61"), true);
});

test("HoodBirds keeps GTD, FCFS, then public as distinct reviewed phases", () => {
  const hoodBirds = seeds.find((seed) => seed.slug === "hoodbirdss");
  assert.equal(hoodBirds?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(hoodBirds?.contractAddress.toLowerCase(), "0x14a247e9e3accbc941a705c984a49e291468bc29");
  assert.equal(hoodBirds?.adapterConfig.openSeaSlug, "hoodbirdss");
  assert.deepEqual(hoodBirds?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["gtd", "signed", "0", 1],
    ["fcfs", "signed", "0", 1],
    ["public", "public", "1000000000000000", 1],
  ]);
  assert.deepEqual(hoodBirds?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, undefined]);
  assert.deepEqual(hoodBirds?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [4500, 1000, true],
    [4500, 1000, true],
  ]);
  assert.ok(hoodBirds?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/hoodbirdss/overview"));
  assert.ok(hoodBirds?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x14a247e9e3accbc941a705c984a49e291468bc29"));
});

test("Retail Shrooms pins GTD, FCFS, and public to the supplied OpenSea drop", () => {
  const shrooms = seeds.find((seed) => seed.slug === "retail-shrooms-423133943");
  assert.equal(shrooms?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(shrooms?.contractAddress.toLowerCase(), "0xb342f37e2b85238db86dab49d042ecf87e41bfee");
  assert.equal(shrooms?.adapterConfig.openSeaSlug, "retail-shrooms-423133943");
  assert.deepEqual(shrooms?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["gtd", "signed", "0", 1],
    ["fcfs", "signed", "0", 1],
    ["public", "public", "0", 1],
  ]);
  assert.deepEqual(shrooms?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [3, 4, undefined]);
  assert.deepEqual(shrooms?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [888, 1000, true],
    [888, 1000, true],
  ]);
  assert.ok(shrooms?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/retail-shrooms-423133943/overview"));
  assert.ok(shrooms?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0xb342f37e2b85238db86dab49d042ecf87e41bfee"));
});

test("HMM CAT pins team, holder allowlist, and public to the supplied OpenSea drop", () => {
  const hmmCat = seeds.find((seed) => seed.slug === "hmm-cat-39998770");
  assert.equal(hmmCat?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(hmmCat?.contractAddress.toLowerCase(), "0x3360556af8e5255ab0fa7d3bc28c6ba54ca31320");
  assert.equal(hmmCat?.adapterConfig.openSeaSlug, "hmm-cat-39998770");
  assert.deepEqual(hmmCat?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["team", "signed", "0", 77],
    ["wl", "signed", "0", 1],
    ["public", "public", "100000000000000", 10],
  ]);
  assert.deepEqual(hmmCat?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, undefined]);
  assert.deepEqual(hmmCat?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [3333, 1000, true],
    [3333, 1000, true],
  ]);
  assert.ok(hmmCat?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/hmm-cat-39998770/overview"));
  assert.ok(hmmCat?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x3360556af8e5255ab0fa7d3bc28c6ba54ca31320"));
});

test("888 society pins its signed and public Ethereum SeaDrop stages", () => {
  const society = seeds.find((seed) => seed.slug === "888-society-605141138");
  assert.equal(society?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(society?.contractAddress.toLowerCase(), "0x632b4a985c12b990f4ea22ffa479c7c715e973a7");
  assert.equal(society?.adapterConfig.openSeaSlug, "888-society-605141138");
  assert.deepEqual(society?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["team-mods", "signed", "0", 1],
    ["gtd", "signed", "0", 1],
    ["public", "public", "2670000000000000", 1],
  ]);
  assert.deepEqual(society?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, undefined]);
  assert.deepEqual(society?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [10014, 1000, true],
    [10014, 1000, true],
  ]);
  assert.ok(society?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/888-society-605141138/overview"));
  assert.ok(society?.adapterConfig.urlMatchers?.some((matcher) => matcher.domain === "etherscan.io" && matcher.path === "/address/0x632b4a985c12b990f4ea22ffa479c7c715e973a7"));
});

test("Rekt Tradooor pins honoraries, both signed tiers, and the public Robinhood sale", () => {
  const rekt = seeds.find((seed) => seed.slug === "rekt-tradooor");
  assert.equal(rekt?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(rekt?.contractAddress.toLowerCase(), "0x7b3ecfa33657de415ff269dc97dfa82954cee706");
  assert.equal(rekt?.adapterConfig.openSeaSlug, "rekt-tradooor");
  assert.deepEqual(rekt?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["honoraries", "signed", "0", 101],
    ["phase-1", "signed", "20000000000000000", 1],
    ["phase-2", "signed", "20000000000000000", 1],
    ["public", "public", "20000000000000000", 1],
  ]);
  assert.deepEqual(rekt?.adapterConfig.stages?.map((stage) => [stage.startsAt, stage.endsAt]), [
    ["2026-08-21T16:00:00.000Z", "2026-08-21T16:15:00.000Z"],
    ["2026-08-21T16:15:00.000Z", "2026-08-21T17:15:00.000Z"],
    ["2026-08-21T17:15:00.000Z", "2026-08-21T19:15:00.000Z"],
    ["2026-08-21T19:15:00.000Z", "2026-08-22T19:15:00.000Z"],
  ]);
  assert.deepEqual(rekt?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, 3, undefined]);
  assert.deepEqual(rekt?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [10000, 1000, true],
    [10000, 1000, true],
    [10000, 1000, true],
  ]);
  assert.ok(rekt?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/rekt-tradooor"));
  assert.ok(rekt?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/rekt-tradooor/overview"));
  assert.ok(rekt?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x7b3ecfa33657de415ff269dc97dfa82954cee706"));
});

test("BigD pins Team, GTD, and public to the reviewed OpenSea drop", () => {
  const bigD = seeds.find((seed) => seed.slug === "bigd-6969");
  assert.equal(bigD?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(bigD?.contractAddress.toLowerCase(), "0x691bb24e010a7889879c66a311b6e2dbdfaa27a1");
  assert.equal(bigD?.adapterConfig.openSeaSlug, "bigd-6969");
  assert.deepEqual(bigD?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["team", "signed", "0", 69],
    ["gtd", "signed", "690000000000000", 1],
    ["public", "public", "690000000000000", 5],
  ]);
  assert.deepEqual(bigD?.adapterConfig.stages?.map((stage) => [stage.startsAt, stage.endsAt]), [
    ["2026-08-23T16:00:00.000Z", "2026-08-23T16:30:00.000Z"],
    ["2026-08-23T16:30:00.000Z", "2026-08-23T18:30:00.000Z"],
    ["2026-08-23T18:30:00.000Z", "2026-08-24T18:30:00.000Z"],
  ]);
  assert.deepEqual(bigD?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, undefined]);
  assert.deepEqual(bigD?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [6969, 1000, true],
    [6969, 1000, true],
  ]);
  assert.ok(bigD?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/bigd-6969/overview"));
  assert.ok(bigD?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/address/0x691bb24e010a7889879c66a311b6e2dbdfaa27a1"));
});

test("Low Quality Cats pins all signed stages and the Ethereum public sale", () => {
  const cats = seeds.find((seed) => seed.slug === "low-quality-cats");
  assert.equal(cats?.adapterKey, "opensea-signed-seadrop-v1");
  assert.equal(cats?.contractAddress.toLowerCase(), "0x55afd2187d7c312bf7e4ca7393a139df19f1f096");
  assert.equal(cats?.adapterConfig.openSeaSlug, "low-quality-cats");
  assert.deepEqual(cats?.adapterConfig.stages?.map((stage) => [stage.id, stage.kind, stage.priceWei, stage.maxPerWallet]), [
    ["team", "signed", "0", 100],
    ["gtd", "signed", "0", 1],
    ["fcfs", "signed", "3500000000000000", 3],
    ["public", "public", "5000000000000000", 10],
  ]);
  assert.deepEqual(cats?.adapterConfig.stages?.map((stage) => stage.dropStageIndex), [1, 2, 3, undefined]);
  assert.deepEqual(cats?.adapterConfig.stages?.filter((stage) => stage.kind === "signed").map((stage) => [stage.maxTokenSupplyForStage, stage.feeBps, stage.restrictFeeRecipients]), [
    [4269, 1000, true],
    [4269, 1000, true],
    [4269, 1000, true],
  ]);
  assert.ok(cats?.adapterConfig.urlMatchers?.some((matcher) => matcher.path === "/collection/low-quality-cats/overview"));
  assert.ok(cats?.adapterConfig.urlMatchers?.some((matcher) => matcher.domain === "etherscan.io" && matcher.path === "/address/0x55afd2187d7c312bf7e4ca7393a139df19f1f096"));
});
