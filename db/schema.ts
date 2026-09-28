import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/* -------------------------------------------------------------------------- */
/* Better Auth tables (plural names, used by lib/auth.ts).                    */
/* -------------------------------------------------------------------------- */

export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).default(
    false,
  ),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("accounts_user_provider_idx").on(table.userId, table.providerId),
  ],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/* -------------------------------------------------------------------------- */
/* Factory domain                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A GitHub App installation connected by a Factory user. Installation access
 * tokens are short-lived and minted on demand from the app private key, so we
 * only persist the installation id + account metadata here, never a token.
 */
export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    installationId: integer("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(), // 'Organization' | 'User'
    connectedByUserId: text("connected_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("github_installations_account_idx").on(table.accountLogin)],
);

/** A connected repository, rendered as a project card on the dashboard. */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(), // owner/name
    repoId: integer("repo_id").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    description: text("description"),
    private: integer("private", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull().default("active"), // 'active' | 'archived'
    issuesSyncedAt: integer("issues_synced_at", { mode: "timestamp" }),
    // Characters of memory injected into each run prompt.
    memoryBudget: integer("memory_budget").notNull().default(6000),
    // Agents record learnings as active, low-weight memories.
    autoLearn: integer("auto_learn", { mode: "boolean" }).notNull().default(true),
    // Planner breakdowns create subtasks without waiting for approval.
    autoApprovePlans: integer("auto_approve_plans", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("projects_repo_uidx").on(table.repoId)],
);

/**
 * A registered agent, owned by a Factory user. Ownership drives the
 * "my agents vs my co-founder's agents" attribution on the boards.
 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Display accent so each owner's agents are visually distinct on a board.
    color: text("color").notNull().default("#6366f1"),
    // Optional Codex model; null uses the subscription default.
    modelId: text("model_id"),
    systemPrompt: text("system_prompt"),
    status: text("status").notNull().default("idle"), // 'idle' | 'working' | 'disabled'
    automationSlot: integer("automation_slot").unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("agents_owner_idx").on(table.ownerUserId)],
);

/** A GitHub issue pulled into the factory and moved through the workflow. */
export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    githubIssueNumber: integer("github_issue_number").notNull(),
    githubIssueId: integer("github_issue_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    labels: text("labels"), // JSON array of label names
    githubState: text("github_state").notNull().default("open"), // 'open' | 'closed'
    // Factory workflow stage.
    stage: text("stage").notNull().default("intake"),
    // Assigned agent (nullable until an agent picks it up).
    assignedAgentId: text("assigned_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    htmlUrl: text("html_url").notNull(),
    // Epic this subtask was carved from; its goal and thread flow into the prompt.
    parentTicketId: text("parent_ticket_id"),
    // `<planId>:<taskKey>` for subtasks created from a plan; survives issue renames.
    planTask: text("plan_task"),
    // Set when a human moves the ticket back; earlier runs stop blocking pickup.
    requeuedAt: integer("requeued_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("tickets_parent_idx").on(table.parentTicketId),
    uniqueIndex("tickets_plan_task_uidx").on(table.planTask),
    uniqueIndex("tickets_project_issue_uidx").on(
      table.projectId,
      table.githubIssueNumber,
    ),
    index("tickets_stage_idx").on(table.stage),
    index("tickets_agent_idx").on(table.assignedAgentId),
  ],
);

/** A single attempt by an agent to work a ticket in a sandbox. */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"), // queued|running|succeeded|failed|cancelled
    sandboxId: text("sandbox_id"),
    codexAccountId: text("codex_account_id"),
    requestedByUserId: text("requested_by_user_id"),
    modelId: text("model_id").notNull(),
    mode: text("mode").notNull().default("implement"), // implement|plan
    // Rolling log stored inline for small runs; large logs go to R2 (logKeyR2).
    log: text("log").notNull().default(""),
    logKeyR2: text("log_key_r2"),
    pullRequestUrl: text("pull_request_url"),
    // Usage reported by the Codex run.
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("runs_ticket_idx").on(table.ticketId),
    index("runs_agent_idx").on(table.agentId),
    index("runs_status_idx").on(table.status),
  ],
);

/** Connected Codex subscriptions. OAuth credentials live only in the runner's encrypted vault. */
export const codexAccounts = sqliteTable("codex_accounts", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  label: text("label").notNull(),
  email: text("email"),
  accountKey: text("account_key").unique(),
  plan: text("plan"),
  status: text("status").notNull().default("disconnected"),
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  limitsJson: text("limits_json"),
  error: text("error"),
  activeRunId: text("active_run_id"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** Singleton scheduler settings and last-cycle health. No credentials stored here. */
export const automation = sqliteTable("automation", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  userId: text("user_id").notNull().references(() => users.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  targetAgents: integer("target_agents").notNull().default(10),
  boardsTotal: integer("boards_total").notNull().default(0),
  lastEventAt: integer("last_event_at", { mode: "timestamp" }),
  lastEvent: text("last_event"),
  label: text("label").notNull().default("factory:ready"),
  leaseId: text("lease_id"),
  leaseUntil: integer("lease_until", { mode: "timestamp" }),
  lastStartedAt: integer("last_started_at", { mode: "timestamp" }),
  lastFinishedAt: integer("last_finished_at", { mode: "timestamp" }),
  lastScheduledAt: integer("last_scheduled_at", { mode: "timestamp" }),
  summary: text("summary").notNull().default("Waiting for first check."),
  error: text("error"),
  reposSynced: integer("repos_synced").notNull().default(0),
  issuesSynced: integer("issues_synced").notNull().default(0),
  runsStarted: integer("runs_started").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/** One row per Sydney calendar day for the morning PaperBoy outstanding digest. */
export const digestSends = sqliteTable("digest_sends", {
  id: text("id").primaryKey(),
  sydneyDate: text("sydney_date").notNull().unique(),
  sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
  messageId: text("message_id"),
  recipientCount: integer("recipient_count").notNull().default(0),
  error: text("error"),
});

/* -------------------------------------------------------------------------- */
/* Memory and collaboration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Team knowledge injected into run prompts. projectId null means every project.
 * Agents only write project-scoped memories; global ones come from people.
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // projectId or 'global'; lets the dedupe index cover global memories.
    scopeKey: text("scope_key").notNull(),
    contentKey: text("content_key").notNull(),
    kind: text("kind").notNull().default("note"), // convention|architecture|gotcha|command|decision|note
    content: text("content").notNull(),
    status: text("status").notNull().default("active"), // active|archived
    source: text("source").notNull(), // human|agent|planner
    sourceRunId: text("source_run_id"),
    sourceTicketId: text("source_ticket_id"),
    createdByUserId: text("created_by_user_id"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    weight: integer("weight").notNull().default(50), // 0-100
    uses: integer("uses").notNull().default(0),
    successes: integer("successes").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("memories_scope_content_uidx").on(table.scopeKey, table.contentKey),
    index("memories_project_idx").on(table.projectId, table.status),
  ],
);

/** Append-only audit trail; `before` holds prior content so edits can be rolled back. */
export const memoryEvents = sqliteTable(
  "memory_events",
  {
    id: text("id").primaryKey(),
    memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(), // user:<id>|run:<id>|api|system
    action: text("action").notNull(),
    before: text("before"),
    after: text("after"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("memory_events_memory_idx").on(table.memoryId, table.createdAt)],
);

/** Memories injected into a run, so its outcome can reinforce or penalise them. */
export const runMemories = sqliteTable(
  "run_memories",
  {
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("run_memories_uidx").on(table.runId, table.memoryId)],
);

/** Subtask blocked until the ticket it depends on is closed. */
export const ticketDependencies = sqliteTable(
  "ticket_dependencies",
  {
    ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    dependsOnTicketId: text("depends_on_ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("ticket_dependencies_uidx").on(table.ticketId, table.dependsOnTicketId),
    index("ticket_dependencies_on_idx").on(table.dependsOnTicketId),
  ],
);

/** A planner's proposed breakdown of an epic into subtasks. */
export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().unique(),
    status: text("status").notNull().default("proposed"), // proposed|applying|applied|rejected|failed
    summary: text("summary").notNull(),
    tasksJson: text("tasks_json").notNull(),
    error: text("error"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("plans_ticket_idx").on(table.ticketId, table.createdAt)],
);

/** Epic thread: planner, agent handoffs and human guidance. Mirrored to the GitHub epic. */
export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    threadTicketId: text("thread_ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    fromTicketId: text("from_ticket_id"),
    runId: text("run_id"),
    agentId: text("agent_id"),
    userId: text("user_id"),
    kind: text("kind").notNull(), // plan|handoff|human
    body: text("body").notNull(),
    githubCommentId: integer("github_comment_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("agent_messages_thread_idx").on(table.threadTicketId, table.createdAt)],
);
