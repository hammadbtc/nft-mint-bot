import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { encodeTerminalAssistantsMint, terminalAssistantsV1 } from "../src/lib/adapters/terminal-assistants-v1";

const contractAddress = "0xD27039734219816FEF06244D5745fE73aBef832d";
const signer = "0x1111111111111111111111111111111111111111";
const collection = {
  id: "4bf17470-3066-4d78-9c27-254ca324b51e", name: "Terminal Assistants", contractAddress,
  chainId: 4663, mintMethod: "mint", mintAbi: '["function mint() payable returns (uint256 id)"]',
  mintPrice: "1300000000000000", maxPerWallet: 1, maxSupply: 6666, active: true, verified: true,
  defaultGasLimit: null, defaultMaxFeePerGas: null, defaultMaxPriorityFeePerGas: null,
  defaultUseFlashbots: false, fcfsEnabled: false, fcfsMintOpenSignature: null,
  paymentToken: null, safetyCheck: true, slug: "terminal-assistants", adapterKey: "terminal-assistants-v1",
  domains: '["terminalrh.xyz"]', siteUrl: "https://terminalrh.xyz/", imageUrl: null,
  adapterConfig: JSON.stringify({ expectedMaxSupply: 6666, expectedMintPriceWei: "1300000000000000", expectedMaxPerWallet: 5 }),
  createdAt: new Date().toISOString(),
};

function fakeProvider(overrides: { mintOpen?: boolean; mintedBy?: bigint; totalMinted?: bigint; supply?: bigint } = {}) {
  let block = 100;
  const values: Record<string, unknown> = {
    MAX_SUPPLY: 6666n,
    MINT_PRICE: 1_300_000_000_000_000n,
    MAX_PER_WALLET: 5n,
    mintOpen: overrides.mintOpen ?? true,
    mintedBy: overrides.mintedBy ?? 0n,
    totalMinted: overrides.totalMinted ?? 1n,
    supply: overrides.supply ?? 6666n,
  };
  const iface = new ethers.Interface([
    "function MAX_SUPPLY() view returns (uint256)", "function MINT_PRICE() view returns (uint256)",
    "function MAX_PER_WALLET() view returns (uint256)", "function mintOpen() view returns (bool)",
    "function mintedBy(address) view returns (uint256)", "function totalMinted() view returns (uint256)",
    "function supply() view returns (uint256)",
  ]);
  return {
    getBlock: async () => ({ number: block++ }),
    call: async (tx: { data: string }) => {
      const parsed = iface.parseTransaction({ data: tx.data });
      const name = parsed!.name;
      return iface.encodeFunctionResult(name, [values[name]]);
    },
  } as unknown as ethers.Provider;
}

test("Terminal Assistants mint uses exact no-argument calldata and 0.0013 ETH", async () => {
  const request = await terminalAssistantsV1.buildTransaction!(collection, signer, 1, fakeProvider(), { phaseId: "open" });
  assert.equal(request.to, contractAddress);
  assert.equal(request.data, encodeTerminalAssistantsMint());
  assert.equal(request.value, 1_300_000_000_000_000n);
  assert.equal(request.chainId, 4663);
});

test("Terminal Assistants waits for the owner switch and never prepares early", async () => {
  const provider = fakeProvider({ mintOpen: false });
  assert.equal(await terminalAssistantsV1.pollPhaseReady!(collection, "open", provider), false);
  await assert.rejects(() => terminalAssistantsV1.buildTransaction!(collection, signer, 1, provider, { phaseId: "open" }), /not been opened/);
});

test("Terminal Assistants rejects bad quantity, sold out state, and capped wallets", async () => {
  await assert.rejects(() => terminalAssistantsV1.buildTransaction!(collection, signer, 2, fakeProvider(), { phaseId: "open" }), /exactly one/);
  await assert.rejects(() => terminalAssistantsV1.buildTransaction!(collection, signer, 1, fakeProvider({ totalMinted: 6666n }), { phaseId: "open" }), /sold out/);
  await assert.rejects(() => terminalAssistantsV1.buildTransaction!(collection, signer, 1, fakeProvider({ mintedBy: 5n }), { phaseId: "open" }), /five-mint/);
});

test("Terminal Assistants eligibility stays positive before the stealth switch", async () => {
  const [result] = await terminalAssistantsV1.checkEligibility!(collection, signer, 1, fakeProvider({ mintOpen: false }), []);
  assert.equal(result.status, "eligible");
  assert.equal(result.phaseId, "open");
});
