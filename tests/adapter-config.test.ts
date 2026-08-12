import test from "node:test";
import assert from "node:assert/strict";
import { evmContractV1 } from "../src/lib/adapters/evm-contract-v1";

const collection = {
  id:"11111111-1111-4111-8111-111111111111", name:"Test Mint", contractAddress:"0x0000000000000000000000000000000000000001",
  chainId:1, mintMethod:"mint", mintAbi:"[]", mintPrice:"100", maxPerWallet:2, maxSupply:1000, active:true,
  defaultGasLimit:null, defaultMaxFeePerGas:null, defaultMaxPriorityFeePerGas:null, defaultUseFlashbots:false,
  fcfsEnabled:false, fcfsMintOpenSignature:null, paymentToken:null, safetyCheck:true, createdAt:new Date().toISOString(),
  slug:"test", adapterKey:"evm-contract-v1", domains:'["mint.example.com"]', siteUrl:"https://mint.example.com",
  imageUrl:null, adapterConfig:JSON.stringify({phases:[{name:"Public",startsAt:"2020-01-01T00:00:00.000Z",endsAt:"2030-01-01T00:00:00.000Z"}]}), verified:true,
};

test("reviewed EVM adapter resolves configured mint data", async () => {
  const resolved = await evmContractV1.resolve(collection, "url");
  assert.equal(resolved.supported, true);
  assert.equal(resolved.collectionId, collection.id);
  assert.equal(resolved.phases[0].name, "Public");
  assert.equal(resolved.phases[0].priceWei, "100");
});

test("adapter rejects malformed reviewed configuration", async () => {
  await assert.rejects(() => evmContractV1.resolve({ ...collection, adapterConfig:"{" }, "url"), /invalid reviewed configuration/);
});
