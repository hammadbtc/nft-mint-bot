import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { ethers } from "ethers";
import { db, schema } from "@/lib/db";
import { getFailoverProvider } from "@/lib/chains";
import { getSigner } from "@/lib/vault";

type DisperseInput = { type:"fund"|"sweep"; mainWalletId:string; workerWalletIds:string[]; amountPerWallet?:string };
export type DispersePreview = { type:"fund"|"sweep"; chainId:number; transfers:Array<{fromWalletId:string;toWalletId:string;amountWei:string}>; estimatedGasWei:string; totalRequiredWei:string };

export async function previewDisperse(input: DisperseInput): Promise<DispersePreview> {
  const [main] = await db.select().from(schema.wallets).where(eq(schema.wallets.id,input.mainWalletId)).limit(1);
  if (!main || main.role!=="main" || !main.active) throw new Error("Main wallet is unavailable");
  const ids=[...new Set(input.workerWalletIds)];
  const workers=ids.length?await db.select().from(schema.wallets).where(inArray(schema.wallets.id,ids)):[];
  if (workers.length!==ids.length) throw new Error("One or more worker wallets were not found");
  if (workers.some(w=>w.role!=="worker"||w.parentWalletId!==main.id||w.chainId!==main.chainId||!w.active)) throw new Error("Workers must be active children of the selected main wallet on the same network");
  const provider=getFailoverProvider(main.chainId); const fee=await provider.getFeeData(); const gasPrice=fee.maxFeePerGas||fee.gasPrice||0n; const gasPerTransfer=21_000n;
  const transfers:DispersePreview["transfers"]=[];
  if(input.type==="fund"){
    if(!input.amountPerWallet)throw new Error("Amount per worker is required"); const amount=ethers.parseEther(input.amountPerWallet); if(amount<=0n)throw new Error("Amount must be positive");
    for(const worker of workers)transfers.push({fromWalletId:main.id,toWalletId:worker.id,amountWei:amount.toString()});
    const estimatedGas=gasPerTransfer*gasPrice*BigInt(workers.length); const total=amount*BigInt(workers.length)+estimatedGas;
    const balance=await provider.getBalance(main.address); if(balance<total)throw new Error(`Main wallet needs about ${ethers.formatEther(total)} native tokens`);
    return {type:input.type,chainId:main.chainId,transfers,estimatedGasWei:estimatedGas.toString(),totalRequiredWei:total.toString()};
  }
  let gasTotal=0n,total=0n;
  for(const worker of workers){const balance=await provider.getBalance(worker.address);const reserve=gasPerTransfer*gasPrice;const amount=balance>reserve?balance-reserve:0n;if(amount>0n){transfers.push({fromWalletId:worker.id,toWalletId:main.id,amountWei:amount.toString()});total+=amount;gasTotal+=reserve;}}
  return {type:input.type,chainId:main.chainId,transfers,estimatedGasWei:gasTotal.toString(),totalRequiredWei:total.toString()};
}

export async function executeDisperse(input:DisperseInput,expected:DispersePreview){
  if(process.env.ENABLE_LIVE_TRANSACTIONS!=="true")throw new Error("Live transactions are disabled until testnet verification is complete");
  const preview=await previewDisperse(input); if(JSON.stringify(preview)!==JSON.stringify(expected))throw new Error("Balances or fees changed; review the updated preview");
  const operationId=randomUUID();await db.insert(schema.disperseOperations).values({id:operationId,type:input.type,mainWalletId:input.mainWalletId,chainId:preview.chainId,status:"running",amountPerWallet:input.amountPerWallet?ethers.parseEther(input.amountPerWallet).toString():null});
  const provider=getFailoverProvider(preview.chainId);
  for(const transfer of preview.transfers){const id=randomUUID();await db.insert(schema.disperseTransfers).values({id,operationId,fromWalletId:transfer.fromWalletId,toWalletId:transfer.toWalletId,amount:transfer.amountWei,status:"pending"});try{const [target]=await db.select({address:schema.wallets.address}).from(schema.wallets).where(eq(schema.wallets.id,transfer.toWalletId)).limit(1);const signer=await getSigner(transfer.fromWalletId,provider);const response=await signer.sendTransaction({to:target.address,value:BigInt(transfer.amountWei)});await db.update(schema.disperseTransfers).set({status:"submitted",txHash:response.hash}).where(eq(schema.disperseTransfers.id,id));const receipt=await response.wait(1);await db.update(schema.disperseTransfers).set({status:receipt?.status===1?"confirmed":"failed"}).where(eq(schema.disperseTransfers.id,id));}catch(error:unknown){await db.update(schema.disperseTransfers).set({status:"failed",error:error instanceof Error?error.message:"Transfer failed"}).where(eq(schema.disperseTransfers.id,id));}}
  await db.update(schema.disperseOperations).set({status:"completed",completedAt:new Date().toISOString()}).where(eq(schema.disperseOperations.id,operationId));return {operationId};
}
