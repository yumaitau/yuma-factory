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
