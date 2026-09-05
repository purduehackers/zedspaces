CREATE TABLE `ai_key_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`repo_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`provider`) REFERENCES `ai_keys`(`user_id`,`provider`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_key_exports_key_repo_idx` ON `ai_key_exports` (`user_id`,`provider`,`repo_id`);--> statement-breakpoint
CREATE INDEX `ai_key_exports_repo_idx` ON `ai_key_exports` (`repo_id`);--> statement-breakpoint
CREATE TABLE `ai_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`upstream` text,
	`ciphertext` text NOT NULL,
	`key_version` integer NOT NULL,
	`export_env` integer DEFAULT false NOT NULL,
	`route_agents` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_user_provider_idx` ON `ai_keys` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text,
	`workspace_id` text,
	`provider` text NOT NULL,
	`model` text,
	`streamed` integer NOT NULL,
	`status` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`request_bytes` integer NOT NULL,
	`response_bytes` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`upstream_request_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_user_created_idx` ON `ai_usage` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`metadata` text,
	`ip` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_log` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forwards` (
	`workspace_id` text NOT NULL,
	`port` integer NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`label` text,
	`url` text,
	`slot` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`workspace_id`, `port`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forwards_slot_idx` ON `forwards` (`workspace_id`,`slot`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text NOT NULL,
	`owner_user_id` text,
	`org_id` text,
	`suspended_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gh_inst_owner_idx` ON `github_installations` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `gh_inst_org_idx` ON `github_installations` (`org_id`);--> statement-breakpoint
CREATE TABLE `image_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`config_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`revision` text NOT NULL,
	`branch` text,
	`trigger` text NOT NULL,
	`requested_by_user_id` text,
	`server_build` text NOT NULL,
	`layer_version` integer NOT NULL,
	`devcontainer_path` text NOT NULL,
	`config` text NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`dockerfile_sha256` text,
	`context_digest` text,
	`base_digests` text DEFAULT '{}' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`image_repository` text NOT NULL,
	`image_tag` text NOT NULL,
	`image_ref` text,
	`image_digest` text,
	`image_size_bytes` integer,
	`sandbox_name` text,
	`sandbox_token_hash` text,
	`sandbox_token_generation` integer DEFAULT 0 NOT NULL,
	`builder_cmd_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text,
	`error` text,
	`log_blob_pathname` text,
	`workflow_run_id` text,
	`then_prebuild_branch` text,
	`notes` text DEFAULT '[]' NOT NULL,
	`pushed_manifest` text,
	`lockfile` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`ready_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `image_builds_repo_created_idx` ON `image_builds` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `image_builds_repo_hash_active_idx` ON `image_builds` (`repo_id`,`config_hash`,`attempt`) WHERE status IN ('queued','building','pushing','preparing','ready');--> statement-breakpoint
CREATE INDEX `image_builds_repo_branch_active_idx` ON `image_builds` (`repo_id`,`branch`) WHERE status IN ('queued','building','pushing','preparing');--> statement-breakpoint
CREATE UNIQUE INDEX `image_builds_sandbox_name_idx` ON `image_builds` (`sandbox_name`);--> statement-breakpoint
CREATE INDEX `image_builds_run_idx` ON `image_builds` (`workflow_run_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`period` text NOT NULL,
	`stripe_invoice_id` text,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_subject_period_idx` ON `invoices` (`subject_type`,`subject_id`,`period`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `kv_expiry_idx` ON `kv` (`expires_at`);--> statement-breakpoint
CREATE TABLE `kv_zset` (
	`key` text NOT NULL,
	`member` text NOT NULL,
	`score` integer NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`key`, `member`)
);
--> statement-breakpoint
CREATE INDEX `kv_zset_score_idx` ON `kv_zset` (`key`,`score`);--> statement-breakpoint
CREATE INDEX `kv_zset_expiry_idx` ON `kv_zset` (`expires_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`ai_token_cap_month` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'team' NOT NULL,
	`allowed_installation_ids` text,
	`network_allowlist` text,
	`spend_cap_cents` integer,
	`ai_token_cap_month` integer,
	`stripe_customer_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_slug_idx` ON `orgs` (`slug`);--> statement-breakpoint
CREATE TABLE `prebuilds` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`commit` text NOT NULL,
	`region` text NOT NULL,
	`image_ref` text NOT NULL,
	`image_build_id` text,
	`sandbox_name` text,
	`sandbox_token_hash` text,
	`sandbox_token_generation` integer DEFAULT 0 NOT NULL,
	`snapshot_id` text,
	`size_bytes` integer,
	`subject_type` text,
	`subject_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`workflow_run_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`ready_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_build_id`) REFERENCES `image_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `prebuilds_repo_branch_idx` ON `prebuilds` (`repo_id`,`branch`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `prebuilds_sandbox_name_idx` ON `prebuilds` (`sandbox_name`);--> statement-breakpoint
CREATE TABLE `repo_access` (
	`user_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`github_repo_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`permission` text NOT NULL,
	`checked_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `github_repo_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `repo_access_user_inst_idx` ON `repo_access` (`user_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `repo_access_repo_idx` ON `repo_access` (`github_repo_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` integer NOT NULL,
	`github_repo_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`private` integer DEFAULT true NOT NULL,
	`devcontainer_hash` text,
	`devcontainer_remote_env` text,
	`image_ref` text,
	`image_status` text DEFAULT 'none' NOT NULL,
	`prebuild_branches` text DEFAULT '[]' NOT NULL,
	`prebuild_warm_command` text,
	`default_machine` text DEFAULT 'vcpu2' NOT NULL,
	`idle_minutes` integer,
	`devcontainer_path` text,
	`devcontainer_config` text,
	`devcontainer_warnings` text DEFAULT '[]' NOT NULL,
	`devcontainer_error` text,
	`devcontainer_checked_revision` text,
	`allowed_extensions` text DEFAULT '[]' NOT NULL,
	`image_build` text,
	`image_digest` text,
	`image_config_hash` text,
	`image_built_at` integer,
	`image_error` text,
	`image_build_run_id` text,
	`allow_base_fallback` integer DEFAULT true NOT NULL,
	`stale_build_cooldown_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`installation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_github_id_idx` ON `repos` (`github_repo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name_idx` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`key_version` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_scope_name_idx` ON `secrets` (`scope`,`scope_id`,`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sandbox_generation` integer NOT NULL,
	`sandbox_session_id` text,
	`holder_tab_id` text NOT NULL,
	`ws_host` text NOT NULL,
	`client_build` text,
	`server_build` text,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`tokens_minted` integer DEFAULT 0 NOT NULL,
	`last_connect_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_ws_started_idx` ON `sessions` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_open_idx` ON `sessions` (`workspace_id`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE TABLE `settings_docs` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`period` text NOT NULL,
	`workspace_id` text,
	`sandbox_session_id` text,
	`source` text NOT NULL,
	`vcpu_seconds` text DEFAULT '0' NOT NULL,
	`provisioned_gb_hours` text DEFAULT '0' NOT NULL,
	`egress_bytes` integer DEFAULT 0 NOT NULL,
	`snapshot_gb_days` text DEFAULT '0' NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`stripe_pushed_at` integer,
	`recorded_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_idem_idx` ON `usage_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `usage_subject_period_idx` ON `usage_ledger` (`subject_type`,`subject_id`,`period`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer,
	`github_login` text,
	`email` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`idle_minutes_default` integer DEFAULT 30 NOT NULL,
	`spend_cap_cents` integer,
	`ai_token_cap_month` integer,
	`stripe_customer_id` text,
	`flagged_at` integer,
	`flag_reason` text,
	`auth_epoch` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_idx` ON `users` (`github_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`provider` text NOT NULL,
	`delivery_id` text NOT NULL,
	`received_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	PRIMARY KEY(`provider`, `delivery_id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`org_id` text,
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`branch` text,
	`revision` text,
	`git_ref` text,
	`pull_request` integer,
	`machine` text NOT NULL,
	`region` text NOT NULL,
	`sandbox_name` text NOT NULL,
	`previous_sandbox_name` text,
	`sandbox_generation` integer DEFAULT 1 NOT NULL,
	`image_ref` text NOT NULL,
	`server_build` text NOT NULL,
	`client_build` text NOT NULL,
	`prebuild_id` text,
	`image_build_id` text,
	`restore_kind` text DEFAULT 'fresh' NOT NULL,
	`restore_blob_pathname` text,
	`state` text DEFAULT 'creating' NOT NULL,
	`state_reason` text,
	`audience` text NOT NULL,
	`sandbox_token_hash` text,
	`sandbox_token_generation` integer DEFAULT 0 NOT NULL,
	`supervisor_cmd_id` text,
	`current_ws_host` text,
	`current_slot_hosts` text,
	`current_health_host` text,
	`current_sandbox_session_id` text,
	`session_started_at` integer,
	`sandbox_expires_at` integer,
	`snapshot_size_bytes` integer,
	`workflow_run_id` text,
	`workflow_run_started_at` integer,
	`last_active_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`idle_minutes` integer DEFAULT 30 NOT NULL,
	`installed_extensions` text DEFAULT '[]' NOT NULL,
	`retention_until` integer,
	`retention_warned_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`last_stopped_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_build_id`) REFERENCES `image_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_sandbox_name_idx` ON `workspaces` (`sandbox_name`);--> statement-breakpoint
CREATE INDEX `workspaces_owner_state_idx` ON `workspaces` (`owner_user_id`,`state`);--> statement-breakpoint
CREATE INDEX `workspaces_state_active_idx` ON `workspaces` (`state`,`last_active_at`);--> statement-breakpoint
CREATE INDEX `workspaces_retention_idx` ON `workspaces` (`retention_until`);--> statement-breakpoint
CREATE INDEX `workspaces_run_idx` ON `workspaces` (`workflow_run_id`);