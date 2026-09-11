import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { dbReady } from "./db";
import { controlPlaneUrl, requireEnv } from "./env";
import { authAccounts, authSessions, authVerifications, users } from "./schema";

// Public clones never need a student's GitHub token after identity verification.
const discardedTokens = { accessToken: null, refreshToken: null, idToken: null };

async function createAuth() {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, BETTER_AUTH_SECRET } = requireEnv(
    "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "BETTER_AUTH_SECRET",
  );
  return betterAuth({
    appName: "Zedspaces · Purdue Hackers",
    baseURL: controlPlaneUrl(),
    secret: BETTER_AUTH_SECRET,
    database: drizzleAdapter(await dbReady(), {
      provider: "sqlite",
      schema: { user: users, session: authSessions, account: authAccounts, verification: authVerifications },
      transaction: true,
    }),
    socialProviders: {
      github: {
        clientId: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
      },
    },
    account: { accountLinking: { enabled: false }, storeAccountCookie: false },
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...discardedTokens } }) },
        update: { before: async (account) => ({ data: { ...account, ...discardedTokens } }) },
      },
    },
    session: { expiresIn: 30 * 24 * 3600, updateAge: 24 * 3600 },
    advanced: { cookiePrefix: "zedspaces" },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;
export function login() {
  if (!instance) {
    instance = createAuth();
    instance.catch(() => { instance = undefined; });
  }
  return instance;
}
