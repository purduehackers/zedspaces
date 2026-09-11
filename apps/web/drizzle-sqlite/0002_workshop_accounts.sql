-- Add account authentication without rebuilding or deleting workspace tables.
ALTER TABLE users ADD COLUMN name text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN email_verified integer NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN image text;
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_idx ON users(email);
--> statement-breakpoint
CREATE TABLE auth_sessions (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
  updated_at integer NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
  ip_address text,
  user_agent text
);
--> statement-breakpoint
CREATE UNIQUE INDEX auth_sessions_token_unique ON auth_sessions(token);
--> statement-breakpoint
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
--> statement-breakpoint
CREATE TABLE auth_accounts (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at integer,
  refresh_token_expires_at integer,
  scope text,
  password text,
  created_at integer NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
  updated_at integer NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer))
);
--> statement-breakpoint
CREATE UNIQUE INDEX auth_accounts_provider_idx ON auth_accounts(provider_id, account_id);
--> statement-breakpoint
CREATE INDEX auth_accounts_user_idx ON auth_accounts(user_id);
--> statement-breakpoint
CREATE TABLE auth_verifications (
  id text PRIMARY KEY NOT NULL,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
  updated_at integer NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer))
);
--> statement-breakpoint
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN workshop_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX workspaces_workshop_idx ON workspaces(owner_user_id, workshop_key) WHERE deleted_at IS NULL;
