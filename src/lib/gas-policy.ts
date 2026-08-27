import { ethers } from "ethers";

const ETHEREUM_CHAIN_ID = 1;
const ETHEREUM_SEADROP_BASE_GAS = 500_000n;
const ETHEREUM_SEADROP_PER_EXTRA_ITEM_GAS = 200_000n;
const ETHEREUM_MIN_MAX_FEE = ethers.parseUnits("30", "gwei");
const ETHEREUM_MIN_PRIORITY_FEE = ethers.parseUnits("2", "gwei");

export function ethereumSeaDropGasLimit(quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new Error("SeaDrop gas quantity must be between 1 and 100");
  }
  return ETHEREUM_SEADROP_BASE_GAS + BigInt(quantity - 1) * ETHEREUM_SEADROP_PER_EXTRA_ITEM_GAS;
}

export function reviewedFallbackGasLimit(
  chainId: number,
  adapterKey: string,
  quantity: number,
  adapterFallback?: bigint,
): bigint | undefined {
  if (chainId === ETHEREUM_CHAIN_ID && ["opensea-seadrop-v1", "opensea-signed-seadrop-v1"].includes(adapterKey)) {
    return ethereumSeaDropGasLimit(quantity);
  }
  return adapterFallback;
}

export function competitiveFeeFields(
  chainId: number,
  fees: ethers.FeeData,
): Pick<ethers.TransactionRequest, "maxFeePerGas" | "maxPriorityFeePerGas" | "gasPrice"> {
  if (chainId !== ETHEREUM_CHAIN_ID) {
    if (fees.maxFeePerGas != null) return {
      maxFeePerGas: fees.maxFeePerGas * 3n,
      ...(fees.maxPriorityFeePerGas != null ? { maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : {}),
    };
    return fees.gasPrice != null ? { gasPrice: fees.gasPrice } : {};
  }

  if (fees.maxFeePerGas != null) return {
    maxFeePerGas: fees.maxFeePerGas * 3n > ETHEREUM_MIN_MAX_FEE
      ? fees.maxFeePerGas * 3n
      : ETHEREUM_MIN_MAX_FEE,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas != null && fees.maxPriorityFeePerGas > ETHEREUM_MIN_PRIORITY_FEE
      ? fees.maxPriorityFeePerGas
      : ETHEREUM_MIN_PRIORITY_FEE,
  };
  return fees.gasPrice != null ? { gasPrice: fees.gasPrice * 3n } : {};
}
