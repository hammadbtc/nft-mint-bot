import postgres from "postgres";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("DATABASE_URL is required to update the wallet index");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });
try {
  // Idempotent and data-preserving: this removes only the old constraint that
  // limited each chain to one main wallet. Address uniqueness remains intact.
  await sql.unsafe('drop index if exists "wallets_one_main_per_chain"');
  console.log("Multiple main wallets per chain enabled");
} finally {
  await sql.end();
}
