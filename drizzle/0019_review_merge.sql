-- Accept, merge and deploy are separate actions (#16).
-- review_acceptances: a person accepted one PR head. A new head supersedes it; history keeps it.
-- merge_events: every merge attempt with its head SHA, by a person or by Factory's low-risk policy.
-- The partial unique index admits one pending or merged row per PR, so concurrent merges become one.
CREATE TABLE `review_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`pull_request_url` text NOT NULL,
	`head_sha` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_acceptances_active_uidx` ON `review_acceptances` (`pull_request_url`) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX `review_acceptances_ticket_idx` ON `review_acceptances` (`ticket_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `merge_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`pull_request_url` text NOT NULL,
	`head_sha` text NOT NULL,
	`actor` text NOT NULL,
	`user_id` text,
	`acceptance_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`merge_sha` text,
	`message` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_events_open_uidx` ON `merge_events` (`pull_request_url`) WHERE status in ('pending', 'merged');
--> statement-breakpoint
CREATE INDEX `merge_events_ticket_idx` ON `merge_events` (`ticket_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `projects` ADD `deployment_target` text;
