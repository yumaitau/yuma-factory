ALTER TABLE `tickets` ADD `dispatch_checked_at` integer;
CREATE INDEX `tickets_dispatch_checked_idx` ON `tickets` (`dispatch_checked_at`, `created_at`);
