CREATE TABLE `run_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`action` text,
	`parameter` text,
	`result` text,
	`ephemeral` integer DEFAULT false NOT NULL,
	`signal` text,
	`author_user_id` text,
	`source_key` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_activities_seq_uidx` ON `run_activities` (`run_id`,`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_activities_source_uidx` ON `run_activities` (`run_id`,`source_key`);
--> statement-breakpoint
CREATE INDEX `run_activities_ticket_idx` ON `run_activities` (`ticket_id`);
--> statement-breakpoint
ALTER TABLE `runs` ADD `branch_name` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_run_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `plan` text;
