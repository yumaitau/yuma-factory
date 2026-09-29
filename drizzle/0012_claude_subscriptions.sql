-- Subscriptions can drive Codex (ChatGPT) or Claude Code (Claude). Agents may
-- pin a provider; null lets them use any available subscription.
ALTER TABLE `codex_accounts` ADD `provider` text DEFAULT 'codex' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD `provider` text;
