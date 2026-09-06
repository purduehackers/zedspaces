DROP INDEX sessions_open_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX sessions_open_idx ON sessions (workspace_id, holder_tab_id) WHERE ended_at IS NULL;
