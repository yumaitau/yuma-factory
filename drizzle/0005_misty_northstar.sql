ALTER TABLE `agents` ADD `automation_slot` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_automation_slot_unique` ON `agents` (`automation_slot`);--> statement-breakpoint
ALTER TABLE `automation` ADD `target_agents` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `automation` ADD `boards_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `automation` ADD `last_event_at` integer;--> statement-breakpoint
ALTER TABLE `automation` ADD `last_event` text;