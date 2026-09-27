ALTER TABLE `projects` ADD `memory_budget` integer DEFAULT 6000 NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_learn` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_approve_plans` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `parent_ticket_id` text;
--> statement-breakpoint
CREATE INDEX `tickets_parent_idx` ON `tickets` (`parent_ticket_id`);
--> statement-breakpoint
ALTER TABLE `runs` ADD `mode` text DEFAULT 'implement' NOT NULL;
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`scope_key` text NOT NULL,
	`content_key` text NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text NOT NULL,
	`source_run_id` text,
	`source_ticket_id` text,
	`created_by_user_id` text,
	`pinned` integer DEFAULT false NOT NULL,
	`weight` integer DEFAULT 50 NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_scope_content_uidx` ON `memories` (`scope_key`,`content_key`);
--> statement-breakpoint
CREATE INDEX `memories_project_idx` ON `memories` (`project_id`,`status`);
--> statement-breakpoint
CREATE TABLE `memory_events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_events_memory_idx` ON `memory_events` (`memory_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `run_memories` (
	`run_id` text NOT NULL,
	`memory_id` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_memories_uidx` ON `run_memories` (`run_id`,`memory_id`);
--> statement-breakpoint
CREATE TABLE `ticket_dependencies` (
	`ticket_id` text NOT NULL,
	`depends_on_ticket_id` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_dependencies_uidx` ON `ticket_dependencies` (`ticket_id`,`depends_on_ticket_id`);
--> statement-breakpoint
CREATE INDEX `ticket_dependencies_on_idx` ON `ticket_dependencies` (`depends_on_ticket_id`);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`summary` text NOT NULL,
	`tasks_json` text NOT NULL,
	`error` text,
	`decided_by_user_id` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_run_id_unique` ON `plans` (`run_id`);
--> statement-breakpoint
CREATE INDEX `plans_ticket_idx` ON `plans` (`ticket_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_ticket_id` text NOT NULL,
	`from_ticket_id` text,
	`run_id` text,
	`agent_id` text,
	`user_id` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`github_comment_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_messages_thread_idx` ON `agent_messages` (`thread_ticket_id`,`created_at`);
