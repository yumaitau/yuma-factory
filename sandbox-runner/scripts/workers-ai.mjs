import http from "node:http";
import { randomUUID } from "node:crypto";

// Codex only speaks the streaming Responses API. Workers AI tool calling works over
// chat completions, so this root-owned localhost proxy translates between the two.
// The Cloudflare token lives only in this process; the agent never sees it.

const text = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => part?.text ?? "").filter(Boolean).join("\n") : "";

function messageContent(content) {
  if (!Array.isArray(content)) return text(content);
  if (!content.some((part) => part?.type === "input_image")) return text(content);
  return content.map((part) => part?.type === "input_image"
    ? { type: "image_url", image_url: { url: part.image_url } }
    : { type: "text", text: part?.text ?? "" });
}

const EFFORT = { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" };

/** Responses request (from Codex) to a chat completions request (for Workers AI). */
export function toChat(body, model) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const toolCalls = (call) => {
    const last = messages.at(-1);
    if (last?.role === "assistant" && !last.tool_calls?.some((c) => c.id === call.id)) {
      (last.tool_calls ??= []).push(call);
    } else messages.push({ role: "assistant", content: null, tool_calls: [call] });
  };
  for (const item of body.input ?? []) {
    switch (item?.type ?? (item?.role ? "message" : undefined)) {
      case "message":
        messages.push({ role: ["developer", "system"].includes(item.role) ? "system" : item.role, content: messageContent(item.content) });
        break;
      case "function_call":
        toolCalls({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } });
        break;
      case "custom_tool_call":
        toolCalls({ id: item.call_id, type: "function", function: { name: item.name, arguments: JSON.stringify({ input: item.input ?? "" }) } });
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        messages.push({ role: "tool", tool_call_id: item.call_id, content: text(item.output) || "(no output)" });
        break;
      // Reasoning is not replayable across providers; web search and other hosted tools are unsupported.
      default:
        break;
    }
  }
  const tools = [];
  for (const tool of body.tools ?? []) {
    if (tool?.type === "function") {
      tools.push({ type: "function", function: { name: tool.name, description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} } } });
    } else if (tool?.type === "custom") {
      const grammar = tool.format?.definition ? `\n\nInput grammar (${tool.format.syntax ?? "text"}):\n${tool.format.definition}` : "";
      tools.push({ type: "function", function: { name: tool.name,
        description: `${tool.description ?? ""}\n\nPut the complete raw tool input in the "input" string.${grammar}`,
        parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } } });
    }
  }
  const chat = { model, messages };
  if (tools.length) {
    chat.tools = tools;
    chat.tool_choice = ["auto", "none", "required"].includes(body.tool_choice) ? body.tool_choice : "auto";
    if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (Number.isInteger(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
  const effort = EFFORT[body.reasoning?.effort];
  if (effort) chat.reasoning_effort = effort;
  return chat;
}

/** Arguments for a custom (freeform) tool, tolerating models that skip the JSON wrapper. */
function customInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.input === "string") return parsed.input;
  } catch {}
  return raw;
}

/** One chat completion to the Responses output items Codex replays. */
export function fromChat(completion, customTools) {
  const message = completion?.choices?.[0]?.message ?? {};
  const items = [];
  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === "string" && reasoning.trim())
    items.push({ type: "reasoning", id: `rs_${randomUUID()}`, summary: [{ type: "summary_text", text: reasoning }] });
  const content = text(message.content);
  if (content.trim())
    items.push({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", content: [{ type: "output_text", text: content, annotations: [] }] });
  for (const call of message.tool_calls ?? []) {
    const name = call?.function?.name;
    if (!name) continue;
    const callId = call.id || `call_${randomUUID()}`;
    const args = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {});
    items.push(customTools.has(name)
      ? { type: "custom_tool_call", id: `ctc_${randomUUID()}`, status: "completed", call_id: callId, name, input: customInput(args) }
      : { type: "function_call", id: `fc_${randomUUID()}`, status: "completed", call_id: callId, name, arguments: args });
  }
  const usage = completion?.usage ?? {};
  return {
    items,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: usage.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Workers AI queues and sheds load under pressure; retry transient failures before giving up. */
export async function complete(chat, { token, accountId, fetchImpl = fetch, attempts = 5, backoffMs = 5000 }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(chat),
      signal: AbortSignal.timeout(10 * 60_000),
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
    if (response.ok) return response.json();
    last = `Workers AI HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
    if (response.status && response.status < 500 && response.status !== 429) break;
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  throw new Error(last);
}

const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Serve POST /v1/responses on 127.0.0.1 for the Codex CLI. */
export function startProxy({ token, accountId, model, port = 8788 }) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/responses")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const id = `resp_${randomUUID()}`;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(event("response.created", { response: { id, status: "in_progress" } }));
    // Workers AI responses can take minutes; keep Codex's stream idle timer alive.
    const heartbeat = setInterval(() => res.write(event("response.in_progress", { response: { id } })), 15_000);
    try {
      const body = JSON.parse(raw);
      const customTools = new Set((body.tools ?? []).filter((tool) => tool?.type === "custom").map((tool) => tool.name));
      const { items, usage } = fromChat(await complete(toChat(body, model), { token, accountId }), customTools);
      for (const item of items) res.write(event("response.output_item.done", { item }));
      res.write(event("response.completed", { response: { id, status: "completed", usage } }));
    } catch (error) {
      res.write(event("response.failed", { response: { id, status: "failed",
        error: { code: "server_error", message: error instanceof Error ? error.message : "Workers AI request failed." } } }));
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
