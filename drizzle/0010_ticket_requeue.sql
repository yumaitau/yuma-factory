-- A human move back to intake or assigned requeues the ticket: runs created
-- before this moment no longer hold it in Needs attention or block pickup.
ALTER TABLE `tickets` ADD `requeued_at` integer;
