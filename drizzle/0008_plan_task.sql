ALTER TABLE `tickets` ADD `plan_task` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_plan_task_uidx` ON `tickets` (`plan_task`);
