import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-sqlite",
  schema: "./lib/schema.ts",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? process.env.ZS_DB_URL ?? "file:./control.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
