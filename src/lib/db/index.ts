import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Use DATABASE_URL from Railway or fall back to local
const connectionString = process.env.DATABASE_URL || "postgres://localhost:5432/mintbot";

const client = postgres(connectionString, {
  max: 10, // connection pool size
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });
export { schema };
