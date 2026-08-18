const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALLOWED_TOOLS,
  executeConfiguredCommand,
  parseCommandArgs,
  readManualConfig,
  validateCommand
} = require("../shixie_manual_executor");

function baseEnv(overrides = {}) {
  return {
    GARDEN_MACHINE_TOKEN: "test-token-not-a-real-secret",
    GARDEN_MCP_URL: "https://galatea.abysslumina.com/mcp",
    ...overrides
  };
}

test("Shixie executor exposes only the narrow UNO tool set", () => {
  assert.deepEqual([...ALLOWED_TOOLS].sort(), [
    "get_my_status",
    "get_tool_schema",
    "join_game",
    "list_games",
    "start_game",
    "submit_action"
  ]);
  for (const forbidden of [
    "create_reply",
    "create_thread",
    "delete_reply",
    "delete_thread",
    "interact",
    "send_game_chat",
    "send_chat_message",
    "update_profile"
  ]) {
    assert.equal(ALLOWED_TOOLS.has(forbidden), false);
  }
});

test("manual command args must be a JSON object", () => {
  assert.deepEqual(parseCommandArgs(""), {});
  assert.deepEqual(parseCommandArgs('{"since_event_id":0}'), { since_event_id: 0 });
  assert.throws(() => parseCommandArgs("[1,2,3]"), /JSON object/);
  assert.throws(() => parseCommandArgs("not-json"), /valid JSON/);
});

test("Shixie machine token is pinned to the official Garden MCP endpoint", () => {
  const config = readManualConfig(baseEnv());
  assert.equal(config.url.href, "https://galatea.abysslumina.com/mcp");

  for (const url of [
    "https://example.com/mcp",
    "https://galatea.abysslumina.com/other",
    "https://galatea.abysslumina.com/mcp?forward=1",
    "https://user:pass@galatea.abysslumina.com/mcp"
  ]) {
    assert.throws(
      () => readManualConfig(baseEnv({ GARDEN_MCP_URL: url })),
      /refuses to send the machine token/
    );
  }
});

test("submit_action requires idempotency and latest-state protection", () => {
  const valid = {
    request_id: "turn-7-play-red-5",
    expected_state_version: 12,
    action: { type: "play", card_id: "c17" }
  };
  assert.equal(validateCommand("submit_action", valid), "submit_action");
  assert.throws(
    () => validateCommand("submit_action", { ...valid, request_id: "" }),
    /request_id/
  );
  assert.throws(
    () => validateCommand("submit_action", { ...valid, expected_state_version: undefined }),
    /expected_state_version/
  );
  assert.throws(
    () => validateCommand("submit_action", { ...valid, action: null }),
    /action object/
  );
});

test("forbidden Garden tools fail before any MCP client is created", async () => {
  let factoryCalled = false;
  await assert.rejects(
    executeConfiguredCommand({
      env: baseEnv({
        SHIXIE_GARDEN_COMMAND: "create_reply",
        SHIXIE_GARDEN_ARGS_JSON: '{"thread_id":1,"body":"no"}',
        SHIXIE_GARDEN_REQUEST_NONCE: "n1"
      }),
      clientFactory() {
        factoryCalled = true;
        throw new Error("should not run");
      }
    }),
    /not allowed/
  );
  assert.equal(factoryCalled, false);
});

test("executor performs exactly one configured MCP call and closes the client", async () => {
  const calls = [];
  let closed = false;
  const output = await executeConfiguredCommand({
    env: baseEnv({
      SHIXIE_GARDEN_COMMAND: "get_my_status",
      SHIXIE_GARDEN_ARGS_JSON: '{"since_event_id":0}',
      SHIXIE_GARDEN_REQUEST_NONCE: "status-001"
    }),
    clientFactory(config) {
      assert.equal(config.policy.allowed.has("get_my_status"), true);
      return {
        async callTool(name, args) {
          calls.push({ name, args });
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() {
          closed = true;
        }
      };
    }
  });

  assert.deepEqual(calls, [{ name: "get_my_status", args: { since_event_id: 0 } }]);
  assert.equal(closed, true);
  assert.equal(output.tool, "get_my_status");
  assert.equal(output.nonce, "status-001");
});
