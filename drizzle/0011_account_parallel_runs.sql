-- A subscription can run several tickets at once. Each executing run holds a
-- lease; active_run_id keeps only exclusive maintenance locks (reconnect,
-- status refresh, test runs).
CREATE TABLE `account_leases` (
	`holder_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `codex_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_leases_account_idx` ON `account_leases` (`account_id`);
--> statement-breakpoint
ALTER TABLE `codex_accounts` ADD `max_runs` integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
INSERT INTO `account_leases` (`holder_id`, `account_id`, `created_at`)
	SELECT `active_run_id`, `id`, unixepoch() FROM `codex_accounts`
	WHERE `active_run_id` IN (SELECT `id` FROM `runs` WHERE `status` = 'running');
--> statement-breakpoint
UPDATE `codex_accounts` SET `active_run_id` = NULL
	WHERE `active_run_id` IN (SELECT `holder_id` FROM `account_leases`);
