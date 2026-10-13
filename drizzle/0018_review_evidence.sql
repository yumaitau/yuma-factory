-- Review evidence (#15): checks and other records pinned to the commit they ran against.
-- runs.pull_request_head_sha is the PR head Factory last saw; evidence on any other commit is stale.
CREATE TABLE `run_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`source_sha` text NOT NULL,
	`environment` text,
	`started_at` integer,
	`finished_at` integer,
	`result` text DEFAULT 'unknown' NOT NULL,
	`url` text,
	`log_key` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_evidence_uidx` ON `run_evidence` (`run_id`,`source_sha`,`kind`,`name`);
--> statement-breakpoint
CREATE INDEX `run_evidence_ticket_idx` ON `run_evidence` (`ticket_id`);
--> statement-breakpoint
ALTER TABLE `runs` ADD `pull_request_head_sha` text;
