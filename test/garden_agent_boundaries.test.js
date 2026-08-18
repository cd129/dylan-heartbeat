const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeModelToolCalls,
  validatedExecutorBase
} = require("../garden_agent");

test("normalizes missing tool-call IDs so assistant and tool messages can stay paired", () => {
  const calls = normalizeModelToolCalls([{ function: { name: "list_notifications", arguments: { limit: 2 } } }], 3);
  assert.equal(calls[0].id, "garden-tool-3-0");
  assert.equal(calls[0].type, "function");
  assert.equal(calls[0].function.arguments, '{"limit":2}');
});

test("executor secret can use HTTP only on localhost or Railway private networking", () => {
  assert.equal(
    validatedExecutorBase({ GARDEN_MCP_EXECUTOR_URL: "http://garden-wake.railway.internal:8080/internal/mcp" }),
    "http://garden-wake.railway.internal:8080/internal/mcp"
  );
  assert.equal(
    validatedExecutorBase({ GARDEN_MCP_EXECUTOR_URL: "http://127.0.0.1:8080/internal/mcp" }),
    "http://127.0.0.1:8080/internal/mcp"
  );
  assert.throws(
    () => validatedExecutorBase({ GARDEN_MCP_EXECUTOR_URL: "http://example.com/internal/mcp" }),
    /must use HTTPS/
  );
});
