const test = require("node:test");
const assert = require("node:assert/strict");
const { parseChatCompletionResponse } = require("../upstream_response");

test("parses official non-stream JSON response", () => {
  const parsed = parseChatCompletionResponse(JSON.stringify({ choices: [{ message: { content: "回来看看你" } }] }), "application/json");
  assert.equal(parsed.choices[0].message.content, "回来看看你");
});

test("joins SSE deltas when a compatible endpoint ignores stream=false", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"回来"}}]}',
    'data: {"choices":[{"delta":{"content":"看看你"}}]}',
    "data: [DONE]"
  ].join("\n\n");
  const parsed = parseChatCompletionResponse(raw, "text/event-stream");
  assert.equal(parsed.choices[0].message.content, "回来看看你");
});

test("preserves streamed tool-call deltas", () => {
  const raw = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"notifications","arguments":"{\\\"limit\\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"10}"}}]}}]}',
    "data: [DONE]"
  ].join("\n\n");
  const parsed = parseChatCompletionResponse(raw, "text/event-stream");
  assert.deepEqual(parsed.choices[0].message.tool_calls, [{
    id: "call_1",
    type: "function",
    function: { name: "list_notifications", arguments: '{"limit":10}' }
  }]);
});
