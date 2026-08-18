const test = require("node:test");
const assert = require("node:assert/strict");

test("official MCP v2 client exposes the CommonJS runtime surface we use", () => {
  const sdk = require("@modelcontextprotocol/client");
  assert.equal(typeof sdk.Client, "function");
  assert.equal(typeof sdk.StreamableHTTPClientTransport, "function");
});
