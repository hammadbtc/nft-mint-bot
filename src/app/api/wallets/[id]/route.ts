import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { deleteWallet } from "@/lib/vault";
import { eq } from "drizzle-orm";

export async function DELETE(_req:NextRequest,{params}:{params:Promise<{id:string}>}){try{const {id}=await params;const children=await db.select({id:schema.wallets.id}).from(schema.wallets).where(eq(schema.wallets.parentWalletId,id)).limit(1);if(children.length)throw new Error("Remove this main wallet's workers first");await deleteWallet(id);return NextResponse.json({success:true})}catch(error:unknown){return NextResponse.json({error:error instanceof Error?error.message:"Could not remove wallet"},{status:400})}}

export async function PATCH(req:NextRequest,{params}:{params:Promise<{id:string}>}){try{const {id}=await params;const input=z.object({label:z.string().trim().min(1).max(80).optional(),active:z.boolean().optional()}).refine(value=>Object.keys(value).length>0,"No valid fields to update").parse(await req.json());await db.update(schema.wallets).set({...input,updatedAt:new Date().toISOString()}).where(eq(schema.wallets.id,id));const [wallet]=await db.select({id:schema.wallets.id,label:schema.wallets.label,address:schema.wallets.address,chainId:schema.wallets.chainId,keyFormat:schema.wallets.keyFormat,active:schema.wallets.active,role:schema.wallets.role,parentWalletId:schema.wallets.parentWalletId,createdAt:schema.wallets.createdAt}).from(schema.wallets).where(eq(schema.wallets.id,id)).limit(1);return NextResponse.json(wallet)}catch(error:unknown){const message=error instanceof z.ZodError?error.issues[0]?.message:error instanceof Error?error.message:"Could not update wallet";return NextResponse.json({error:message},{status:400})}}
