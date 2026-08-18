const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AutonomousWriteUncertainError,
  parseToolArguments,
  runGardenAgent,
  toOpenAiTools
} = require("../garden_agent");

function modelMessage(message) {
  return { choices: [{ message }] };
}

test("keeps Garden tools disabled by default", async () => {
  let listed = false;
  const result = await runGardenAgent({
    messages: [{ role: "system", content: "x" }],
    env: {},
    listTools: async () => { listed = true; return []; },
    callModel: async (_messages, tools) => {
      assert.deepEqual(tools, []);
      return modelMessage({ content: "没有动作" });
    }
  });
  assert.equal(listed, false);
  assert.equal(result.rawText, "没有动作");
});

test("executes a bounded read-tool loop and returns the final model text", async () => {
  let modelRound = 0;
  let callCount = 0;
  const result = await runGardenAgent({
    messages: [{ role: "system", content: "x" }],
    env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
    listTools: async () => [{
      name: "list_notifications",
      description: "read notifications",
      inputSchema: { type: "object", properties: {} },
      write: false
    }],
    callTool: async (name, args) => {
      callCount += 1;
      assert.equal(name, "list_notifications");
      assert.deepEqual(args, { limit: 5 });
      return { content: [{ type: "text", text: "one notification" }] };
    },
    callModel: async messages => {
      modelRound += 1;
      if (modelRound === 1) {
        return modelMessage({
          content: null,
          tool_calls: [{
            id: "read_1",
            type: "function",
            function: { name: "list_notifications", arguments: '{"limit":5}' }
          }]
        });
      }
      const toolMessage = messages.find(message => message.role === "tool");
      assert.ok(toolMessage.content.includes("one notification"));
      return modelMessage({ content: "花园有回复\n我已经看过通知了。" });
    }
  });
  assert.equal(callCount, 1);
  assert.equal(result.toolCallsExecuted, 1);
  assert.equal(result.writeCallsExecuted, 0);
});

test("journals a successful autonomous write before and after the tool call", async () => {
  const marks = [];
  let modelRound = 0;
  const result = await runGardenAgent({
    messages: [],
    env: { GARDEN_AGENT_TOOLS_ENABLED: "true", GARDEN_AGENT_MAX_WRITE_CALLS: "1" },
    listTools: async () => [{
      name: "reply_thread",
      description: "reply",
      inputSchema: { type: "object" },
      write: true
    }],
    reserveWriteAction: (name, args) => {
      assert.equal(name, "reply_thread");
      assert.deepEqual(args, { thread_id: 12, content: "hi" });
      return { execute: true, key: "write-key", status: "pending" };
    },
    markWriteAction: (key, status) => marks.push([key, status]),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    callModel: async () => {
      modelRound += 1;
      return modelRound === 1
        ? modelMessage({
            content: null,
            tool_calls: [{
              id: "write_1",
              type: "function",
              function: { name: "reply_thread", arguments: '{"thread_id":12,"content":"hi"}' }
            }]
          })
        : modelMessage({ content: "回复完成\n我已经回过了。" });
    }
  });
  assert.deepEqual(marks, [["write-key", "succeeded"]]);
  assert.equal(result.writeCallsExecuted, 1);
});

test("stops instead of retrying when an autonomous write outcome is uncertain", async () => {
  const marks = [];
  await assert.rejects(
    runGardenAgent({
      messages: [],
      env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
      listTools: async () => [{ name: "reply_thread", inputSchema: { type: "object" }, write: true }],
      reserveWriteAction: () => ({ execute: true, key: "write-key", status: "pending" }),
      markWriteAction: (key, status) => marks.push([key, status]),
      callTool: async () => { throw new Error("socket closed"); },
      callModel: async () => modelMessage({
        content: null,
        tool_calls: [{
          id: "write_1",
          type: "function",
          function: { name: "reply_thread", arguments: '{"thread_id":12,"content":"hi"}' }
        }]
      })
    }),
    error => error instanceof AutonomousWriteUncertainError && error.code === "GARDEN_WRITE_UNCERTAIN"
  );
  assert.deepEqual(marks, [["write-key", "uncertain"]]);
});

test("deduplicates a write already marked successful without calling the tool again", async () => {
  let modelRound = 0;
  let called = false;
  const result = await runGardenAgent({
    messages: [],
    env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
    listTools: async () => [{ name: "reply_thread", inputSchema: { type: "object" }, write: true }],
    reserveWriteAction: () => ({ execute: false, key: "write-key", status: "succeeded" }),
    callTool: async () => { called = true; return {}; },
    callModel: async messages => {
      modelRound += 1;
      if (modelRound === 1) {
        return modelMessage({
          content: null,
          tool_calls: [{
            id: "write_1",
            type: "function",
            function: { name: "reply_thread", arguments: '{"thread_id":12,"content":"hi"}' }
          }]
        });
      }
      assert.ok(messages.some(message => message.role === "tool" && message.content.includes("deduplicated")));
      return modelMessage({ content: "已处理\n没有重复发送。" });
    }
  });
  assert.equal(called, false);
  assert.equal(result.writeCallsExecuted, 0);
});

test("tool argument parser accepts only JSON objects", () => {
  assert.deepEqual(parseToolArguments('{"x":1}'), { x: 1 });
  assert.throws(() => parseToolArguments("[]"), /JSON object/);
  assert.deepEqual(toOpenAiTools([{ name: "x", description: "d", inputSchema: { type: "object" } }]), [{
    type: "function",
    function: { name: "x", description: "d", parameters: { type: "object" } }
  }]);
});
