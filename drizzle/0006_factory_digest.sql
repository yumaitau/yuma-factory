CREATE TABLE `digest_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`sydney_date` text NOT NULL,
	`sent_at` integer NOT NULL,
	`message_id` text,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_sends_sydney_date_uidx` ON `digest_sends` (`sydney_date`);
