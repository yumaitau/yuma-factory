-- One-off repair for the Yuma deployment: a repository refresh on 2026-09-27
-- (updated_at 1790509096) archived every project missing from a narrowed App
-- listing. Reactivate them, except the archived private yuma-factory repository.
-- Matches no rows in any other deployment.
UPDATE `projects` SET `status` = 'active'
WHERE `status` = 'archived' AND `updated_at` = 1790509096 AND `repo_id` <> 1368122441;
