import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  bullsRunnersLeaf,
  bullsRunnersV1,
  encodeBullsRunnersMint,
  verifyBullsRunnersProof,
} from "../src/lib/adapters/bulls-runners-v1";

const contractAddress = "0x4d908ec6F8B6b63DcD57E68eDe19e595c402d83B";
const expectedRoot = "0xfe59d1969f0924fe220298c4ce82e263f64ba1690f1a196192f06d9e8e227b9d";
const collection = {
  id: "9a30c018-0c3f-47be-8726-22d7a05f6d9b", name: "Bulls Runners", contractAddress,
  chainId: 4663, mintMethod: "mint", mintAbi: '["function mint(bytes32[] proof)"]', mintPrice: "0",
  maxPerWallet: 1, maxSupply: 4200, active: true, defaultGasLimit: null, defaultMaxFeePerGas: null,
  defaultMaxPriorityFeePerGas: null, defaultUseFlashbots: false, fcfsEnabled: false, fcfsMintOpenSignature: null,
  paymentToken: null, safetyCheck: true, slug: "bulls-runners", adapterKey: "bulls-runners-v1",
  domains: '["bullsrunners.com"]', siteUrl: "https://bullsrunners.com/mint", imageUrl: null,
  adapterConfig: JSON.stringify({
    expectedMerkleRoot: expectedRoot,
    expectedMaxSupply: 4200,
    expectedReserveSupply: 420,
    expectedWhitelistCount: 4880,
    whitelistUrl: "https://bullsrunners.com/whitelist.json",
  }),
  verified: true, createdAt: new Date().toISOString(),
};

const readInterface = new ethers.Interface([
  "function MAX_SUPPLY() view returns (uint256)", "function RESERVE_SUPPLY() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)", "function whitelistEnabled() view returns (bool)",
  "function mintClosed() view returns (bool)", "function totalMinted() view returns (uint256)",
  "function hasMinted(address) view returns (bool)",
]);

function fakeProvider({ whitelistEnabled = false, hasMinted = false } = {}): ethers.Provider {
  const answers = new Map<string, string>([
    [readInterface.getFunction("MAX_SUPPLY")!.selector, readInterface.encodeFunctionResult("MAX_SUPPLY", [4200n])],
    [readInterface.getFunction("RESERVE_SUPPLY")!.selector, readInterface.encodeFunctionResult("RESERVE_SUPPLY", [420n])],
    [readInterface.getFunction("merkleRoot")!.selector, readInterface.encodeFunctionResult("merkleRoot", [expectedRoot])],
    [readInterface.getFunction("whitelistEnabled")!.selector, readInterface.encodeFunctionResult("whitelistEnabled", [whitelistEnabled])],
    [readInterface.getFunction("mintClosed")!.selector, readInterface.encodeFunctionResult("mintClosed", [false])],
    [readInterface.getFunction("totalMinted")!.selector, readInterface.encodeFunctionResult("totalMinted", [10n])],
    [readInterface.getFunction("hasMinted")!.selector, readInterface.encodeFunctionResult("hasMinted", [hasMinted])],
  ]);
  return {
    call: async (request: ethers.TransactionRequest) => {
      const answer = answers.get(String(request.data).slice(0, 10));
      if (!answer) throw new Error(`Unexpected test call ${request.data}`);
      return answer;
    },
  } as unknown as ethers.Provider;
}

test("Bulls Runners uses the OpenZeppelin double-hashed address leaf and sorted proof", () => {
  const first = bullsRunnersLeaf("0x1111111111111111111111111111111111111111");
  const second = bullsRunnersLeaf("0x2222222222222222222222222222222222222222");
  const pair = BigInt(first) < BigInt(second) ? [first, second] : [second, first];
  const root = ethers.keccak256(ethers.concat(pair));
  assert.equal(verifyBullsRunnersProof(first, [second], root), true);
  assert.equal(verifyBullsRunnersProof(first, [], root), false);
});

test("Bulls Runners open mint targets the reviewed collection with an empty proof and zero value", async () => {
  const signer = "0x1111111111111111111111111111111111111111";
  const request = await bullsRunnersV1.buildTransaction!(collection, signer, 1, fakeProvider(), { phaseId: "open" });
  assert.equal(request.to, contractAddress);
  assert.equal(request.value, 0n);
  assert.equal(request.data, encodeBullsRunnersMint([]));
  const decoded = new ethers.Interface(["function mint(bytes32[] proof)"]).decodeFunctionData("mint", String(request.data));
  assert.deepEqual([...decoded.proof], []);
});

test("Bulls Runners refuses open mint before the owner switch, repeat wallets, and quantity above one", async () => {
  const signer = "0x1111111111111111111111111111111111111111";
  await assert.rejects(() => bullsRunnersV1.buildTransaction!(collection, signer, 1, fakeProvider({ whitelistEnabled: true }), { phaseId: "open" }), /not been enabled/);
  await assert.rejects(() => bullsRunnersV1.buildTransaction!(collection, signer, 1, fakeProvider({ hasMinted: true }), { phaseId: "open" }), /already minted/);
  await assert.rejects(() => bullsRunnersV1.buildTransaction!(collection, signer, 2, fakeProvider(), { phaseId: "open" }), /exactly one/);
});
