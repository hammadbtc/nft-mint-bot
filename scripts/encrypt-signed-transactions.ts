import postgres from "postgres";
import { sealSignedTransaction, signedTransactionIsSealed } from "../src/lib/signed-transaction-vault";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to encrypt signed transactions");
if (!process.env.VAULT_PASSPHRASE) throw new Error("VAULT_PASSPHRASE is required to encrypt signed transactions");
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
try {
  const counts = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('mintbot:migration:encrypt-signed-transactions'))`;
    const attempts = await tx`select id, raw_tx from mint_attempts where raw_tx is not null`;
    const transfers = await tx`select id, raw_tx from disperse_transfers where raw_tx is not null`;
    let attemptCount = 0;
    let transferCount = 0;
    for (const row of attempts) {
      if (signedTransactionIsSealed(row.raw_tx)) continue;
      await tx`update mint_attempts set raw_tx = ${sealSignedTransaction(row.raw_tx)} where id = ${row.id} and raw_tx = ${row.raw_tx}`;
      attemptCount += 1;
    }
    for (const row of transfers) {
      if (signedTransactionIsSealed(row.raw_tx)) continue;
      await tx`update disperse_transfers set raw_tx = ${sealSignedTransaction(row.raw_tx)} where id = ${row.id} and raw_tx = ${row.raw_tx}`;
      transferCount += 1;
    }
    return { attemptCount, transferCount };
  });
  console.log(`Signed transaction vault ready; encrypted ${counts.attemptCount} mint attempt(s) and ${counts.transferCount} Disperse transfer(s)`);
} finally { await sql.end(); }
