import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { encodeSquiggleWuiggleMint, squiggleWuiggleV1 } from "../src/lib/adapters/squiggle-wuiggle-v1";

const collectionAddress = "0x65E0B476Ce5c9849E6c26fb06042479e552E309C";
const mintContract = "0x2897e59840e6e3Deb1dBf56dD7F32d20C26a69eB";
const startTime = 1_786_638_600n;
const collection = {
  id: "ed083dbf-57ab-4467-802c-8436986f8ee6", name: "Squiggle Wuiggle", contractAddress: collectionAddress,
  chainId: 4663, mintMethod: "mint", mintAbi: '["function mint(uint256 quantity) payable"]', mintPrice: "1600000000000000",
  maxPerWallet: 2, maxSupply: 7500, active: true, defaultGasLimit: null, defaultMaxFeePerGas: null,
  defaultMaxPriorityFeePerGas: null, defaultUseFlashbots: false, fcfsEnabled: false, fcfsMintOpenSignature: null,
  paymentToken: null, safetyCheck: true, slug: "squiggle-wuiggle", adapterKey: "squiggle-wuiggle-v1",
  domains: '["opensea.io"]', siteUrl: "https://opensea.io/collection/squiggle-wuiggle", imageUrl: null,
  adapterConfig: JSON.stringify({
    mintContract,
    transferPolicy: "0x28b60Fbc4F730328e9AF28C49e400653AE31AB7c",
    tokenContract: "0xE26DFaD41E606F0608C366Df21eE7E7809f459C1",
    expectedPriceWei: "1600000000000000",
    expectedMaxPerTransaction: 2,
    expectedInventory: 7500,
  }),
  verified: true, createdAt: new Date().toISOString(),
};

const minterInterface = new ethers.Interface([
  "function MINT_PRICE() view returns (uint256)", "function MAX_PER_TX() view returns (uint256)",
  "function collection() view returns (address)", "function saleStartTime() view returns (uint256)",
  "function remaining() view returns (uint256)", "function distributed() view returns (uint256)",
  "function inventorySize() view returns (uint256)", "function inventoryReady() view returns (bool)",
  "function transferPolicyAllowsSale(address) view returns (bool)",
]);
const collectionInterface = new ethers.Interface([
  "function totalSupply() view returns (uint256)", "function MAX_SUPPLY() view returns (uint256)",
]);

function fakeProvider(chainTimestamp: bigint): ethers.Provider {
  const answers = new Map<string, string>([
    [minterInterface.getFunction("MINT_PRICE")!.selector, minterInterface.encodeFunctionResult("MINT_PRICE", [1_600_000_000_000_000n])],
    [minterInterface.getFunction("MAX_PER_TX")!.selector, minterInterface.encodeFunctionResult("MAX_PER_TX", [2n])],
    [minterInterface.getFunction("collection")!.selector, minterInterface.encodeFunctionResult("collection", [collectionAddress])],
    [minterInterface.getFunction("saleStartTime")!.selector, minterInterface.encodeFunctionResult("saleStartTime", [startTime])],
    [minterInterface.getFunction("remaining")!.selector, minterInterface.encodeFunctionResult("remaining", [7500n])],
    [minterInterface.getFunction("distributed")!.selector, minterInterface.encodeFunctionResult("distributed", [0n])],
    [minterInterface.getFunction("inventorySize")!.selector, minterInterface.encodeFunctionResult("inventorySize", [7500n])],
    [minterInterface.getFunction("inventoryReady")!.selector, minterInterface.encodeFunctionResult("inventoryReady", [true])],
    [minterInterface.getFunction("transferPolicyAllowsSale")!.selector, minterInterface.encodeFunctionResult("transferPolicyAllowsSale", [true])],
    [collectionInterface.getFunction("totalSupply")!.selector, collectionInterface.encodeFunctionResult("totalSupply", [10_000n])],
    [collectionInterface.getFunction("MAX_SUPPLY")!.selector, collectionInterface.encodeFunctionResult("MAX_SUPPLY", [10_000n])],
  ]);
  return {
    call: async (request: ethers.TransactionRequest) => {
      const answer = answers.get(String(request.data).slice(0, 10));
      if (!answer) throw new Error(`Unexpected test call ${request.data}`);
      return answer;
    },
    getBlock: async () => ({ timestamp: Number(chainTimestamp) }),
  } as unknown as ethers.Provider;
}

test("Squiggle Wuiggle calldata and exact payment match the verified minter", async () => {
  const signer = "0x1111111111111111111111111111111111111111";
  const request = await squiggleWuiggleV1.buildTransaction!(collection, signer, 2, fakeProvider(startTime - 1n), { allowBeforeStart: true });
  assert.equal(request.to, mintContract);
  assert.equal(request.value, 3_200_000_000_000_000n);
  assert.equal(request.data, encodeSquiggleWuiggleMint(2));
  const decoded = new ethers.Interface(["function mint(uint256 quantity) payable"]).decodeFunctionData("mint", String(request.data));
  assert.equal(decoded.quantity, 2n);
});

test("Squiggle Wuiggle refuses pre-open normal execution and quantities above two", async () => {
  const signer = "0x1111111111111111111111111111111111111111";
  await assert.rejects(() => squiggleWuiggleV1.buildTransaction!(collection, signer, 1, fakeProvider(startTime - 1n)), /has not started/);
  await assert.rejects(() => squiggleWuiggleV1.buildTransaction!(collection, signer, 3, fakeProvider(startTime + 1n)), /at most 2/);
});
