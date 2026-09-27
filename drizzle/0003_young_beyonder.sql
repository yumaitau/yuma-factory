CREATE TABLE `automation` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`label` text DEFAULT 'factory:ready' NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	`last_started_at` integer,
	`last_finished_at` integer,
	`last_scheduled_at` integer,
	`summary` text DEFAULT 'Waiting for first check.' NOT NULL,
	`error` text,
	`repos_synced` integer DEFAULT 0 NOT NULL,
	`issues_synced` integer DEFAULT 0 NOT NULL,
	`runs_started` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `issues_synced_at` integer;