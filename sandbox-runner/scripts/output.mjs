/** Render public execution events, never raw protocol payloads or reasoning. */
export function executionOutput(event) {
  const item = event?.item;
  if (event?.type === "turn.started") return "Codex started working.";
  if (event?.type === "turn.failed") return `Codex error: ${event.error?.message ?? "Turn failed"}`;
  if (event?.type === "error") return `Codex error: ${event.message ?? "Execution error"}`;
  if (!item || !["item.started", "item.completed"].includes(event.type)) return null;
  const done = event.type === "item.completed";
  switch (item.type) {
    case "command_execution":
      return done
        ? `${item.aggregated_output ?? ""}\nCommand ${item.status ?? "completed"}${item.exit_code == null ? "" : ` (exit ${item.exit_code})`}`
        : `$ ${item.command}`;
    case "agent_message": return done ? item.text : null;
    case "file_change": return done ? (item.changes ?? []).map((c) => `${c.kind}: ${c.path}`).join("\n") : null;
    case "mcp_tool_call": return `${done ? "Finished" : "Calling"} ${item.server}/${item.tool}`;
    case "web_search": return done ? `Search: ${item.query ?? "completed"}` : null;
    case "error": return item.message;
    default: return null;
  }
}

/** Tool results can be a string or a list of content blocks; keep only text. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

/** Claude Code stream-json counterpart of executionOutput; thinking is never shown. */
export function claudeOutput(event) {
  if (event?.type === "system" && event.subtype === "init") return "Claude started working.";
  if (event?.type === "result")
    return event.is_error ? `Claude error: ${typeof event.result === "string" && event.result ? event.result : event.subtype ?? "Execution error"}` : null;
  const content = event?.message?.content;
  if (!Array.isArray(content) || !["assistant", "user"].includes(event.type)) return null;
  const lines = [];
  for (const block of content) {
    if (block?.type === "text" && event.type === "assistant") lines.push(block.text);
    else if (block?.type === "tool_use") {
      const input = block.input ?? {};
      if (block.name === "Bash") lines.push(`$ ${input.command ?? ""}`);
      else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name)) lines.push(`${block.name.toLowerCase()}: ${input.file_path ?? input.notebook_path ?? ""}`);
      else if (String(block.name).startsWith("mcp__")) lines.push(`Calling ${String(block.name).slice(5).replace("__", "/")}`);
      else if (block.name === "WebSearch") lines.push(`Search: ${input.query ?? ""}`);
      else lines.push(`${block.name}`);
    } else if (block?.type === "tool_result") {
      const text = resultText(block.content);
      lines.push(`${text.slice(-4000)}${block.is_error ? "\nTool failed" : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n") || null;
}

/** Map a Claude rate_limit_event to the pool's primary/secondary usage windows. */
export function claudeLimits(info) {
  const windows = info?.unifiedWindows;
  const window = (value, mins) => value && typeof value.utilization === "number"
    ? { usedPercent: Math.round(value.utilization * 100), resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : null, windowDurationMins: mins }
    : null;
  const limits = { primary: window(windows?.five_hour, 300), secondary: window(windows?.seven_day, 10080) };
  // A rejected request is exhausted even when utilization is not reported.
  if (info?.status === "rejected") {
    const key = info.rateLimitType === "seven_day" ? "secondary" : "primary";
    limits[key] = { ...(limits[key] ?? {}), usedPercent: 100, resetsAt: limits[key]?.resetsAt ?? info.resetsAt ?? null };
  }
  return limits.primary || limits.secondary ? limits : null;
}

/** JSONL can split anywhere, including inside a UTF-8 character. */
export function jsonLines(onEvent, maxLine = 1_000_000) {
  let pending = "", skipping = false;
  const line = (text) => { try { onEvent(JSON.parse(text)); } catch { /* Ignore malformed protocol lines. */ } };
  return {
    push(chunk) {
      for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const complete = part.endsWith("\n");
        if (!skipping) pending += part;
        if (pending.length > maxLine) { pending = ""; skipping = true; }
        if (complete) {
          if (!skipping) line(pending);
          pending = ""; skipping = false;
        }
      }
    },
    end() { if (pending && !skipping) line(pending); pending = ""; },
  };
}

export function redactOutput(value, sensitive = []) {
  let text = String(value);
  for (const token of sensitive) if (token) text = text.split(token).join("[redacted]");
  return text
    .replace(/(?:sk-|gh[psuor]_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}

// Session activities mirror lib/run-session.ts ACTIVITY_LIMITS; the app clips again on ingest.
const clip = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
// Command output matters most at its end.
const tail = (value, max) => {
  const text = String(value ?? "").trimEnd();
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
};
const thought = (text) => (text?.trim() ? { type: "thought", body: clip(text, 8000) } : null);
const action = (verb, parameter, result, ephemeral = false) => ({
  type: "action", action: verb, parameter: parameter ? clip(parameter, 500) : null,
  result: result ? tail(result, 2000) : null, ...(ephemeral ? { ephemeral: true } : {}),
});

/**
 * Codex exec --json event -> session activity, or null. Reasoning stays private as in
 * executionOutput. Started items are ephemeral and superseded by their completion.
 */
export function codexActivity(event) {
  const item = event?.item;
  if (event?.type === "turn.failed") return { type: "error", body: clip(event.error?.message ?? "Turn failed", 8000) };
  // Top-level stream errors are usually retried reconnects, not the end of the turn.
  if (event?.type === "error") return thought(`Codex: ${event.message ?? "execution error"}`);
  if (!item || !["item.started", "item.completed"].includes(event.type)) return null;
  const done = event.type === "item.completed";
  switch (item.type) {
    case "command_execution":
      return done
        ? action("Ran", item.command, `${item.exit_code == null ? item.status ?? "completed" : `exit ${item.exit_code}`}\n${tail(item.aggregated_output ?? "", 1900)}`)
        : action("Running", item.command, null, true);
    case "agent_message": return done ? thought(item.text) : null;
    case "file_change": return done ? action("Edited", (item.changes ?? []).map((c) => c.path).join(", "), (item.changes ?? []).map((c) => `${c.kind}: ${c.path}`).join("\n")) : null;
    case "mcp_tool_call": return done
      ? action("Called", `${item.server}/${item.tool}`, item.error?.message ?? item.status ?? "completed")
      : action("Calling", `${item.server}/${item.tool}`, null, true);
    case "web_search": return done ? action("Searched", item.query) : null;
    case "error": return thought(`Codex: ${item.message ?? "error"}`);
    default: return null;
  }
}

// Claude tool -> [in-progress verb, done verb, short parameter].
const CLAUDE_TOOLS = {
  Bash: ["Running", "Ran", (i) => i.command],
  Edit: ["Editing", "Edited", (i) => i.file_path],
  MultiEdit: ["Editing", "Edited", (i) => i.file_path],
  Write: ["Writing", "Wrote", (i) => i.file_path],
  NotebookEdit: ["Editing", "Edited", (i) => i.notebook_path],
  Read: ["Reading", "Read", (i) => i.file_path],
  Grep: ["Searching", "Searched", (i) => i.pattern],
  Glob: ["Searching", "Searched", (i) => i.pattern],
  WebSearch: ["Searching the web", "Searched the web", (i) => i.query],
  WebFetch: ["Fetching", "Fetched", (i) => i.url],
};

/**
 * Claude stream-json event -> session activities. `tools` remembers each tool_use until its
 * tool_result arrives. Thinking is never shown; TodoWrite is reported as the plan instead.
 */
export function claudeActivities(event, tools = new Map()) {
  if (event?.type === "result")
    return event.is_error ? [{ type: "error", body: clip(typeof event.result === "string" && event.result ? event.result : event.subtype ?? "Execution error", 8000) }] : [];
  const content = event?.message?.content;
  if (!Array.isArray(content) || !["assistant", "user"].includes(event.type)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type === "text" && event.type === "assistant") {
      const item = thought(block.text);
      if (item) out.push(item);
    } else if (block?.type === "tool_use" && block.name !== "TodoWrite") {
      const name = String(block.name);
      const known = CLAUDE_TOOLS[name];
      const mcp = name.startsWith("mcp__") ? name.slice(5).replace("__", "/") : null;
      const verbs = known ?? (mcp ? ["Calling", "Called"] : ["Using", "Used"]);
      const parameter = known ? known[2](block.input ?? {}) : mcp ?? name;
      tools.set(block.id, { done: verbs[1], parameter });
      out.push(action(verbs[0], parameter, null, true));
    } else if (block?.type === "tool_result" && tools.has(block.tool_use_id)) {
      const call = tools.get(block.tool_use_id);
      tools.delete(block.tool_use_id);
      out.push(action(call.done, call.parameter, `${block.is_error ? "failed\n" : ""}${resultText(block.content)}` || "completed"));
    }
  }
  return out;
}

/** The agent's own todo list, from either CLI, as plan steps; null when the event has none. */
export function agentPlan(event) {
  const item = event?.item;
  if (item?.type === "todo_list" && Array.isArray(item.items))
    return item.items.slice(0, 50).map((step) => ({ content: clip(step?.text, 500), status: step?.completed ? "completed" : "pending" }));
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) return null;
  const todo = event.message.content.findLast((block) => block?.type === "tool_use" && block.name === "TodoWrite");
  if (!Array.isArray(todo?.input?.todos)) return null;
  const status = { pending: "pending", in_progress: "inProgress", completed: "completed" };
  return todo.input.todos.slice(0, 50).map((step) => ({ content: clip(step?.content, 500), status: status[step?.status] ?? "pending" }));
}

/** Processes in `ps -o stat=` output that can still run: anything but a zombie (Z) waiting to be reaped. */
export function liveProcesses(psStat) {
  return psStat.split("\n").filter((stat) => stat.trim() && !stat.trim().startsWith("Z")).length;
}
