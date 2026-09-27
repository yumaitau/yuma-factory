CREATE TABLE `codex_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`label` text NOT NULL,
	`email` text,
	`account_key` text,
	`plan` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`limits_json` text,
	`error` text,
	`active_run_id` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codex_accounts_account_key_unique` ON `codex_accounts` (`account_key`);--> statement-breakpoint
DROP TABLE `model_pool`;--> statement-breakpoint
ALTER TABLE `runs` ADD `codex_account_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `requested_by_user_id` text;