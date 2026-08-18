const test = require("node:test");
const assert = require("node:assert/strict");
const {
  enforceResultLimit,
  parseCsvSet,
  readConfig,
  readPolicy,
  safeToolDefinition
} = require("../garden_mcp_client");

test("Garden MCP policy requires write tools to be an allowed subset", () => {
  const policy = readPolicy({
    GARDEN_MCP_ALLOWED_TOOLS: "list_notifications, reply_thread",
    GARDEN_MCP_WRITE_TOOLS: "reply_thread"
  });
  assert.deepEqual([...policy.allowed].sort(), ["list_notifications", "reply_thread"]);
  assert.deepEqual([...policy.writes], ["reply_thread"]);
  assert.throws(() => readPolicy({
    GARDEN_MCP_ALLOWED_TOOLS: "list_notifications",
    GARDEN_MCP_WRITE_TOOLS: "reply_thread"
  }), /non-allowed tool/);
});

test("Garden MCP config requires a token and HTTPS for non-local endpoints", () => {
  assert.throws(() => readConfig({ GARDEN_MCP_URL: "https://galatea.abysslumina.com/mcp" }), /GARDEN_MACHINE_TOKEN/);
  assert.throws(() => readConfig({
    GARDEN_MACHINE_TOKEN: "secret",
    GARDEN_MCP_URL: "http://example.com/mcp"
  }), /HTTPS/);
  const config = readConfig({
    GARDEN_MACHINE_TOKEN: "secret",
    GARDEN_MCP_URL: "https://galatea.abysslumina.com/mcp",
    GARDEN_MCP_ALLOWED_TOOLS: "list_notifications"
  });
  assert.equal(config.url.protocol, "https:");
  assert.equal(config.policy.allowed.has("list_notifications"), true);
});

test("tool definitions expose only schema metadata plus explicit write classification", () => {
  assert.deepEqual(safeToolDefinition({
    name: "reply_thread",
    description: "reply",
    inputSchema: { type: "object", properties: { content: { type: "string" } } },
    extra: "not forwarded"
  }, true), {
    name: "reply_thread",
    description: "reply",
    inputSchema: { type: "object", properties: { content: { type: "string" } } },
    write: true
  });
});

test("tool results fail closed when larger than the configured limit", () => {
  assert.deepEqual(parseCsvSet(" a, b ,,a "), new Set(["a", "b"]));
  assert.deepEqual(enforceResultLimit({ ok: true }, 4096), { ok: true });
  assert.throws(() => enforceResultLimit({ text: "x".repeat(5000) }, 4096), /size limit/);
});
