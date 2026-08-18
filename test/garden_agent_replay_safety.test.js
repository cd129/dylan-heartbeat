const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AutonomousPostWriteSafetyStopError,
  boundedTimeout,
  remainingControl,
  runGardenAgent,
  validatedExecutorBase
} = require("../garden_agent");

function modelMessage(message) {
  return { choices: [{ message }] };
}

test("turns a model failure after a completed write into a no-replay safety stop", async () => {
  let round = 0;
  const marks = [];
  await assert.rejects(
    runGardenAgent({
      messages: [],
      env: {
        GARDEN_AGENT_TOOLS_ENABLED: "true",
        GARDEN_AGENT_TOTAL_TIMEOUT_MS: "60000"
      },
      listTools: async () => [{
        name: "reply_thread",
        inputSchema: { type: "object" },
        write: true
      }],
      reserveWriteAction: () => ({ execute: true, key: "write-key", status: "pending" }),
      markWriteAction: (key, status) => marks.push([key, status]),
      callTool: async () => ({ isError: false, content: [{ type: "text", text: "ok" }] }),
      callModel: async () => {
        round += 1;
        if (round === 1) {
          return modelMessage({
            content: null,
            tool_calls: [{
              id: "write_1",
              type: "function",
              function: { name: "reply_thread", arguments: '{"thread_id":1,"content":"hi"}' }
            }]
          });
        }
        throw new Error("model timeout");
      }
    }),
    error => error instanceof AutonomousPostWriteSafetyStopError &&
      error.code === "GARDEN_POST_WRITE_SAFETY_STOP" &&
      error.writeCallsExecuted === 1
  );
  assert.deepEqual(marks, [["write-key", "succeeded"]]);
});

test("tool-call budget counts requested calls, including unavailable tools", async () => {
  await assert.rejects(
    runGardenAgent({
      messages: [],
      env: {
        GARDEN_AGENT_TOOLS_ENABLED: "true",
        GARDEN_AGENT_MAX_TOOL_CALLS: "2",
        GARDEN_AGENT_TOTAL_TIMEOUT_MS: "60000"
      },
      listTools: async () => [],
      callModel: async () => modelMessage({
        content: null,
        tool_calls: [
          { id: "1", type: "function", function: { name: "x", arguments: "{}" } },
          { id: "2", type: "function", function: { name: "y", arguments: "{}" } },
          { id: "3", type: "function", function: { name: "z", arguments: "{}" } }
        ]
      })
    }),
    /tool-call budget/
  );
});

test("remaining total deadline bounds nested request timeouts", () => {
  assert.deepEqual(remainingControl(10_000, 4_000), { timeoutMs: 6_000 });
  assert.equal(boundedTimeout(30_000, { timeoutMs: 6_000 }), 6_000);
  assert.throws(() => remainingControl(4_500, 4_000), /total timeout/);
});

test("executor URL rejects public cleartext and URL decorations", () => {
  assert.equal(
    validatedExecutorBase({ GARDEN_MCP_EXECUTOR_URL: "http://garden-wake.railway.internal:8080/internal/mcp" }),
    "http://garden-wake.railway.internal:8080/internal/mcp"
  );
  assert.throws(
    () => validatedExecutorBase({ GARDEN_MCP_EXECUTOR_URL: "http://example.com/internal/mcp" }),
    /must use HTTPS/
  );
  assert.throws(
    () => validatedExecutorBase({ GARDEN_MCP_EXECUTOR_URL: "https://example.com/internal/mcp?secret=x" }),
    /must not contain/
  );
});
