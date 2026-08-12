import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { supportedAdapterKeys } from "@/lib/adapters";
import { eq } from "drizzle-orm";
import { safeErrorMessage, safeSecretEqual } from "@/lib/safety";

const reviewedMint = z.object({
  id:z.string().uuid().optional(), name:z.string().trim().min(1).max(120), slug:z.string().trim().min(1).max(100),
  contractAddress:z.string().regex(/^0x[a-fA-F0-9]{40}$/), chainId:z.coerce.number().int().positive(),
  mintMethod:z.string().trim().min(1), mintAbi:z.union([z.string(),z.array(z.unknown())]), mintPrice:z.string().regex(/^\d+$/).optional(),
  maxPerWallet:z.number().int().positive().optional(), maxSupply:z.number().int().positive().optional(), paymentToken:z.string().optional(),
  adapterKey:z.string().default("evm-contract-v1"), domains:z.array(z.string().trim().min(1)).min(1), siteUrl:z.string().url(),
  imageUrl:z.string().url().optional(), adapterConfig:z.record(z.string(),z.unknown()).default({}), verified:z.literal(true),
});

export async function GET(req:NextRequest){const chainId=req.nextUrl.searchParams.get("chainId");const rows=await db.select().from(schema.collections).where(chainId?eq(schema.collections.chainId,Number(chainId)):undefined).orderBy(schema.collections.createdAt);return NextResponse.json(rows,{headers:{"Cache-Control":"no-store"}});}

export async function POST(req:NextRequest){try{const adminToken=process.env.SUPPORT_ADMIN_TOKEN;const supplied=req.headers.get("x-support-admin-token")||"";if(!adminToken||!safeSecretEqual(supplied,adminToken))return NextResponse.json({error:"Mint support authorization required"},{status:401,headers:{"Cache-Control":"no-store"}});const input=reviewedMint.parse(await req.json());if(!supportedAdapterKeys().includes(input.adapterKey))throw new Error("Unknown adapter key");const mintAbi=typeof input.mintAbi==="string"?input.mintAbi:JSON.stringify(input.mintAbi);JSON.parse(mintAbi);const id=input.id||crypto.randomUUID();await db.insert(schema.collections).values({id,name:input.name,slug:input.slug,contractAddress:input.contractAddress,chainId:input.chainId,mintMethod:input.mintMethod,mintAbi,mintPrice:input.mintPrice||null,maxPerWallet:input.maxPerWallet||null,maxSupply:input.maxSupply||null,paymentToken:input.paymentToken||null,adapterKey:input.adapterKey,domains:JSON.stringify(input.domains),siteUrl:input.siteUrl,imageUrl:input.imageUrl||null,adapterConfig:JSON.stringify(input.adapterConfig),verified:true}).onConflictDoUpdate({target:schema.collections.id,set:{name:input.name,slug:input.slug,contractAddress:input.contractAddress,chainId:input.chainId,mintMethod:input.mintMethod,mintAbi,mintPrice:input.mintPrice||null,maxPerWallet:input.maxPerWallet||null,maxSupply:input.maxSupply||null,paymentToken:input.paymentToken||null,adapterKey:input.adapterKey,domains:JSON.stringify(input.domains),siteUrl:input.siteUrl,imageUrl:input.imageUrl||null,adapterConfig:JSON.stringify(input.adapterConfig),verified:true}});const [created]=await db.select().from(schema.collections).where(eq(schema.collections.id,id)).limit(1);return NextResponse.json(created,{status:201,headers:{"Cache-Control":"no-store"}})}catch(error:unknown){const message=error instanceof z.ZodError?error.issues[0]?.message:safeErrorMessage(error,"Could not register mint");return NextResponse.json({error:message},{status:400,headers:{"Cache-Control":"no-store"}})}}
