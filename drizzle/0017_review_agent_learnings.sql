-- Agent learnings wait for review unless a project opts in. auto_learn defaulted to true, so it cannot tell
-- a deliberate opt-in from the default; every existing project starts opted out. auto_learn is left in place,
-- unread, so the worker still running during a deploy keeps working. Existing memories keep their status.
ALTER TABLE `projects` ADD `activate_learnings` integer DEFAULT false NOT NULL;
