import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  compileReviewedTransaction,
  validateReviewedCallConfig,
} from "../src/lib/reviewed-call-config";
import { validateEligibilityArtifact } from "../src/lib/eligibility-artifacts";

const walletAddress = "0x00000000000000000000000000000000000000A1";
const contractAddress = "0x00000000000000000000000000000000000000B1";
const base = {
  contractAddress,
  chainId: 1,
  mintMethod: "mint(address,uint256)",
  mintAbi: JSON.stringify([
    "function mint(address recipient,uint256 quantity) payable",
    "function allowlistMint(address recipient,uint256 quantity,bytes32[] proof) payable",
  ]),
  paymentToken: null,
};

function publicConfig() {
  return {
    schemaVersion: 1,
    engine: "custom-reviewed-v1",
    phases: [{
      id: "public",
      name: "Public",
      kind: "public",
      opening: { mode: "time", startsAt: "2026-09-01T12:00:00.000Z", endsAt: "2026-09-02T12:00:00.000Z" },
      unitPriceWei: "50000000000000000",
      maxPerWallet: 3,
      eligibility: { strategy: "public" },
      call: {
        target: { source: "collection" },
        function: "mint(address,uint256)",
        args: [{ source: "wallet" }, { source: "quantity" }],
        value: { source: "unit-price-times-quantity" },
      },
    }],
  };
}

test("reviewed-call compiler binds wallet, quantity, target, selector, and value exactly", () => {
  const config = validateReviewedCallConfig({ ...base, adapterConfig: JSON.stringify(publicConfig()) });
  const request = compileReviewedTransaction({ collection: base, phase: config.phases[0], wallet: walletAddress, quantity: 2 });
  assert.equal(request.to, contractAddress);
  assert.equal(request.chainId, 1);
  assert.equal(request.value, 100000000000000000n);
  const iface = new ethers.Interface(JSON.parse(base.mintAbi));
  assert.equal(String(request.data).slice(0, 10), iface.getFunction("mint(address,uint256)")!.selector);
  const decoded = iface.decodeFunctionData("mint(address,uint256)", String(request.data));
  assert.equal(decoded[0], ethers.getAddress(walletAddress));
  assert.equal(decoded[1], 2n);
});

test("reviewed-call registration rejects a wallet binding in a non-address ABI slot", () => {
  const value = publicConfig();
  value.phases[0].call.args = [{ source: "quantity" }, { source: "wallet" }] as never;
  assert.throws(() => validateReviewedCallConfig({ ...base, adapterConfig: JSON.stringify(value) }), /quantity binding 0 must target an integer/);
});

test("Merkle eligibility proves the exact wallet leaf and calldata artifact key", () => {
  const leaf = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [walletAddress]));
  const config = {
    ...publicConfig(),
    phases: [{
      ...publicConfig().phases[0],
      id: "allowlist",
      name: "Allowlist",
      kind: "allowlist",
      eligibility: {
        strategy: "merkle-proof-v1",
        root: leaf,
        proofKey: "proof",
        leaf: { encoding: "abi", types: ["address"], values: [{ source: "wallet" }], doubleHash: false },
      },
      call: {
        target: { source: "collection" },
        function: "allowlistMint(address,uint256,bytes32[])",
        args: [{ source: "wallet" }, { source: "quantity" }, { source: "artifact", key: "proof", abiType: "bytes32[]" }],
        value: { source: "unit-price-times-quantity" },
      },
    }],
  };
  const reviewed = validateReviewedCallConfig({ ...base, mintMethod: "allowlistMint(address,uint256,bytes32[])", adapterConfig: JSON.stringify(config) });
  const payload = validateEligibilityArtifact({ phase: reviewed.phases[0], walletAddress, payload: { proof: [] } });
  assert.deepEqual(payload, { proof: [] });
  assert.throws(() => validateEligibilityArtifact({ phase: reviewed.phases[0], walletAddress: ethers.ZeroAddress, payload: { proof: [] } }), /does not match/);
});

test("server signature artifacts must recover the reviewed signer and bind the wallet", async () => {
  const signer = ethers.Wallet.createRandom();
  const allowance = 2n;
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [walletAddress, allowance]));
  const signature = signer.signingKey.sign(digest).serialized;
  const config = {
    ...publicConfig(),
    phases: [{
      ...publicConfig().phases[0],
      id: "signed",
      name: "Signed",
      kind: "signed",
      eligibility: {
        strategy: "server-signature-v1",
        signatureKey: "signature",
        expectedSigner: signer.address,
        message: {
          encoding: "abi",
          types: ["address", "uint256"],
          values: [{ source: "wallet" }, { source: "artifact", key: "allowance", abiType: "uint256" }],
          signing: "digest",
        },
      },
      call: {
        target: { source: "collection" },
        function: "allowlistMint(address,uint256,bytes32[])",
        args: [
          { source: "wallet" },
          { source: "quantity" },
          { source: "artifact", key: "signature", abiType: "bytes32[]" },
        ],
        value: { source: "unit-price-times-quantity" },
      },
    }],
  };
  // The intentionally incompatible bytes32[] slot proves schema validation
  // fails before a signature can be accepted for the wrong calldata type.
  assert.throws(() => validateReviewedCallConfig({ ...base, mintMethod: "allowlistMint(address,uint256,bytes32[])", adapterConfig: JSON.stringify(config) }), /signature|artifact/i);

  const signatureAbi = JSON.stringify(["function signedMint(address recipient,uint256 quantity,bytes signature) payable"]);
  config.phases[0].call.function = "signedMint(address,uint256,bytes)";
  config.phases[0].call.args[2] = { source: "artifact", key: "signature", abiType: "bytes" };
  const reviewed = validateReviewedCallConfig({ ...base, mintMethod: "signedMint(address,uint256,bytes)", mintAbi: signatureAbi, adapterConfig: JSON.stringify(config) });
  assert.doesNotThrow(() => validateEligibilityArtifact({ phase: reviewed.phases[0], walletAddress, payload: { allowance: allowance.toString(), signature } }));
  assert.throws(() => validateEligibilityArtifact({ phase: reviewed.phases[0], walletAddress: ethers.ZeroAddress, payload: { allowance: allowance.toString(), signature } }), /reviewed signer/);
});
