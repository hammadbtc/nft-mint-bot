ALTER TABLE "wallet_nonce_state" DROP CONSTRAINT IF EXISTS "wallet_nonce_state_pkey";
ALTER TABLE "wallet_nonce_state" ADD CONSTRAINT "wallet_nonce_state_pkey" PRIMARY KEY ("wallet_id", "chain_id");
DROP INDEX IF EXISTS "wallets_chain_address_unique";
CREATE UNIQUE INDEX "wallets_address_unique" ON "wallets" (lower("address"));
