const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createGardenSidecarApi } = require("../garden_sidecar_api");

async function withServer(executor, fn) {
  const api = createGardenSidecarApi({ executor, env: { GARDEN_WAKE_SHARED_SECRET: "shared-secret" } });
  const server = http.createServer((req, res) => {
    Promise.resolve(api.handle(req, res)).then(handled => {
      if (!handled && !res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
    }).catch(error => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("sidecar rejects missing shared secret before touching MCP", async () => {
  let touched = false;
  await withServer({
    listAllowedTools: async () => { touched = true; return []; },
    callTool: async () => { touched = true; return {}; }
  }, async base => {
    const response = await fetch(`${base}/internal/mcp/tools`, { method: "POST" });
    assert.equal(response.status, 401);
  });
  assert.equal(touched, false);
});

test("sidecar returns only policy-filtered tool definitions from its executor", async () => {
  await withServer({
    listAllowedTools: async () => [{
      name: "list_notifications",
      description: "read",
      inputSchema: { type: "object" },
      write: false
    }]
  }, async base => {
    const response = await fetch(`${base}/internal/mcp/tools`, {
      method: "POST",
      headers: { "x-garden-wake-secret": "shared-secret" }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.tools.map(tool => tool.name), ["list_notifications"]);
  });
});

test("sidecar forwards a valid allowed tool call without exposing credentials", async () => {
  let seen;
  await withServer({
    callTool: async (name, args) => {
      seen = { name, args };
      return { content: [{ type: "text", text: "ok" }] };
    }
  }, async base => {
    const response = await fetch(`${base}/internal/mcp/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-garden-wake-secret": "shared-secret"
      },
      body: JSON.stringify({ name: "list_notifications", arguments: { limit: 2 } })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
  });
  assert.deepEqual(seen, { name: "list_notifications", args: { limit: 2 } });
});
