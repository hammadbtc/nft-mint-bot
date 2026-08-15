import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { encodeSeaDropPublicMint, publicEligibilityForStats } from "../src/lib/adapters/opensea-seadrop-v1";

test("SeaDrop public mint calldata matches the reviewed OpenSea transaction shape", () => {
  const nft = "0x5b05C950993705416C9069d43Ee70b564a875e40";
  const recipient = "0x0000a26b00c1F0DF003000390027140000fAa719";
  const minter = "0x1111111111111111111111111111111111111111";
  const data = encodeSeaDropPublicMint(nft, recipient, minter, 2);
  const iface = new ethers.Interface(["function mintPublic(address,address,address,uint256) payable"]);
  const decoded = iface.decodeFunctionData("mintPublic", data);
  assert.equal(decoded[0], nft);
  assert.equal(decoded[1], recipient);
  assert.equal(decoded[2], ethers.ZeroAddress);
  assert.equal(decoded[3], 2n);
});

test("upcoming public stages are schedulable when wallet room and supply remain", () => {
  assert.deepEqual(publicEligibilityForStats(0n, 500n, 888n, 1, 1), {
    phaseId: "public",
    status: "eligible",
  });
});

test("sold-out public stages explain supply instead of looking timing-ineligible", () => {
  assert.deepEqual(publicEligibilityForStats(0n, 888n, 888n, 1, 1), {
    phaseId: "public",
    status: "ineligible",
    reason: "Public mint is sold out (888/888)",
  });
});
