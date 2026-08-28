import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import projects from "../config/supported-projects.json" with { type: "json" };
import { encodeSeaDropPublicMint, openseaSeaDropV1 } from "../src/lib/adapters/opensea-seadrop-v1";

const project = projects.find((item) => item.slug === "netnet-dunlaps")!;
const config = project.adapterConfig as {
  feeRecipient: string;
  urlMatchers: Array<{ domain: string; path: string }>;
};

test("DUNLAPS is pinned to the Robinhood public SeaDrop phase only", () => {
  assert.equal(project.chainId, 4663);
  assert.equal(project.adapterKey, "opensea-seadrop-v1");
  assert.equal(project.contractAddress.toLowerCase(), "0xe801b3399193ad1af4e0bbcad72a45c2ff819a8f");
  assert.equal(project.mintPrice, "2000000000000000");
  assert.equal(project.maxPerWallet, 5);
  assert.equal(project.maxSupply, 1105);
  assert.equal(openseaSeaDropV1.canArmPhase?.("public"), true);
  assert.ok(!("openSeaSlug" in config));
});

test("DUNLAPS public calldata has exact target, recipient, zero delegated minter, and quantity", () => {
  const data = encodeSeaDropPublicMint(project.contractAddress, config.feeRecipient, ethers.ZeroAddress, 5);
  const decoded = new ethers.Interface([
    "function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable",
  ]).decodeFunctionData("mintPublic", data);
  assert.equal(decoded.nftContract.toLowerCase(), project.contractAddress.toLowerCase());
  assert.equal(decoded.feeRecipient.toLowerCase(), config.feeRecipient.toLowerCase());
  assert.equal(decoded.minterIfNotPayer, ethers.ZeroAddress);
  assert.equal(decoded.quantity, 5n);
  assert.equal(BigInt(project.mintPrice) * decoded.quantity, 10_000_000_000_000_000n);
});

test("DUNLAPS accepts exact collection URLs and rejects lookalike paths", () => {
  const paths = config.urlMatchers.filter((item) => item.domain === "opensea.io").map((item) => item.path);
  assert.deepEqual(paths, ["/collection/netnet-dunlaps", "/collection/netnet-dunlaps/overview"]);
  assert.ok(!paths.includes("/collection/netnet-dunlaps-fake"));
});
