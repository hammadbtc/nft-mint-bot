import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { encodeSeaDropPublicMint } from "../src/lib/adapters/opensea-seadrop-v1";

test("SeaDrop public mint calldata matches the reviewed OpenSea transaction shape", () => {
  const nft = "0x29CBeF6f555C017172275C5B09b066A892bc4E2c";
  const recipient = "0x0000a26b00c1F0DF003000390027140000fAa719";
  const minter = "0x1111111111111111111111111111111111111111";
  const data = encodeSeaDropPublicMint(nft, recipient, minter, 2);
  const iface = new ethers.Interface(["function mintPublic(address,address,address,uint256) payable"]);
  const decoded = iface.decodeFunctionData("mintPublic", data);
  assert.equal(decoded[0], nft);
  assert.equal(decoded[1], recipient);
  assert.equal(decoded[2], minter);
  assert.equal(decoded[3], 2n);
});
