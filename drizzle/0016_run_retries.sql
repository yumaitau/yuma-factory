-- Automatic retries: attempt counts a ticket's consecutive automatic tries since
-- its last human requeue; failure_kind records whether a failed run may be retried.
ALTER TABLE `runs` ADD `attempt` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `failure_kind` text;
