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
