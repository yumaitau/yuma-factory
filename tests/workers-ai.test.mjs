import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, fromChat, toChat } from "../sandbox-runner/scripts/workers-ai.mjs";

test("Codex responses input becomes chat messages with grouped tool calls", () => {
  const chat = toChat({
    instructions: "Be careful.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Repo rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix add()" }] },
      { type: "reasoning", summary: [] },
      { type: "function_call", call_id: "a", name: "shell", arguments: "{\"command\":[\"ls\"]}" },
      { type: "custom_tool_call", call_id: "b", name: "apply_patch", input: "*** Begin Patch" },
      { type: "function_call_output", call_id: "a", output: "src" },
      { type: "custom_tool_call_output", call_id: "b", output: [{ type: "input_text", text: "Done" }] },
    ],
    tools: [
      { type: "function", name: "shell", description: "Run", parameters: { type: "object", properties: {} } },
      { type: "custom", name: "apply_patch", description: "Patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } },
      { type: "web_search" },
    ],
    tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "medium" }, stream: true, store: false,
  }, "@cf/zai-org/glm-5.3-flash");
  assert.deepEqual(chat.messages.map((m) => m.role), ["system", "system", "user", "assistant", "tool", "tool"]);
  assert.deepEqual(chat.messages[3].tool_calls.map((c) => [c.id, c.function.arguments]),
    [["a", "{\"command\":[\"ls\"]}"], ["b", "{\"input\":\"*** Begin Patch\"}"]]);
  assert.equal(chat.messages[5].content, "Done");
  assert.deepEqual(chat.tools.map((t) => t.function.name), ["shell", "apply_patch"]);
  assert.match(chat.tools[1].function.description, /start: x/);
  assert.equal(chat.reasoning_effort, "high");
  assert.equal(chat.stream, undefined);
});

test("chat completions become Codex output items, restoring custom tools", () => {
  const { items, usage } = fromChat({
    choices: [{ message: { reasoning_content: "Think", content: "Patching", tool_calls: [
      { id: "1", function: { name: "shell", arguments: "{\"command\":[\"ls\"]}" } },
      { id: "2", function: { name: "apply_patch", arguments: "{\"input\":\"*** Begin Patch\"}" } },
      { id: "3", function: { name: "apply_patch", arguments: "*** Begin Patch raw" } },
    ] } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
  }, new Set(["apply_patch"]));
  assert.deepEqual(items.map((i) => i.type), ["reasoning", "message", "function_call", "custom_tool_call", "custom_tool_call"]);
  assert.equal(items[3].input, "*** Begin Patch");
  assert.equal(items[4].input, "*** Begin Patch raw");
  assert.deepEqual(usage, { input_tokens: 10, input_tokens_details: { cached_tokens: 6 }, output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 });
});

test("transient Workers AI failures retry; request errors do not", async () => {
  const statuses = [503, 429, 200];
  let calls = 0;
  const fetchImpl = async () => {
    const status = statuses[calls++];
    return { ok: status === 200, status, json: async () => ({ choices: [] }), text: async () => "busy" };
  };
  assert.deepEqual(await complete({}, { token: "t", accountId: "a", fetchImpl, backoffMs: 0 }), { choices: [] });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(complete({}, { token: "t", accountId: "a", backoffMs: 0,
    fetchImpl: async () => { calls++; return { ok: false, status: 400, text: async () => "bad" }; } }), /HTTP 400: bad/);
  assert.equal(calls, 1);
});
