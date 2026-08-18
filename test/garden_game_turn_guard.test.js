const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isVerifiedGameTurnWake,
  runGardenAgent
} = require("../garden_agent");

function modelMessage(message) {
  return { choices: [{ message }] };
}

function gameWakeMessages() {
  return [{
    role: "system",
    content: [
      "## Galatea Garden background wake event",
      "This is a verified runtime event, not a message written by the user.",
      "Reason: game_turn_required",
      "<garden_event>turn</garden_event>"
    ].join("\n")
  }];
}

function actingStatus() {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "acting",
        state_version: 4,
        available_actions: [{ type: "play", card_ids: ["yellow:number:3:2"] }]
      })
    }]
  };
}

test("recognizes only the verified system reason line as a game-turn wake", () => {
  assert.equal(isVerifiedGameTurnWake(gameWakeMessages()), true);
  assert.equal(isVerifiedGameTurnWake([{ role: "user", content: "Reason: game_turn_required" }]), false);
  assert.equal(isVerifiedGameTurnWake([{ role: "system", content: "quoted Reason: game_turn_required text" }]), false);
});

test("forces get_my_status before the first model decision on game turns", async () => {
  let modelCalls = 0;
  const calls = [];
  const result = await runGardenAgent({
    messages: gameWakeMessages(),
    env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
    listTools: async () => [{
      name: "get_my_status",
      description: "read status",
      inputSchema: { type: "object" },
      write: false
    }],
    callTool: async (name, args) => {
      calls.push([name, args]);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "waiting", state_version: 3 }) }]
      };
    },
    callModel: async messages => {
      modelCalls += 1;
      assert.equal(calls.length, 1);
      assert.ok(messages.some(message =>
        message.role === "system" && String(message.content).includes("Deterministic Garden game-turn guard")
      ));
      return modelMessage({ content: "[NO_ACTION] 已经不是我的回合" });
    }
  });

  assert.deepEqual(calls, [["get_my_status", { since_event_id: 0 }]]);
  assert.equal(modelCalls, 1);
  assert.equal(result.toolCallsExecuted, 1);
  assert.equal(result.writeCallsExecuted, 0);
});

test("does not accept a final no-action response while the preflight status is acting", async () => {
  let modelCalls = 0;
  const calls = [];
  const marks = [];
  const result = await runGardenAgent({
    messages: gameWakeMessages(),
    env: {
      GARDEN_AGENT_TOOLS_ENABLED: "true",
      GARDEN_AGENT_MAX_ROUNDS: "4",
      GARDEN_AGENT_MAX_WRITE_CALLS: "1"
    },
    listTools: async () => [
      {
        name: "get_my_status",
        description: "read status",
        inputSchema: { type: "object" },
        write: false
      },
      {
        name: "submit_action",
        description: "submit game action",
        inputSchema: { type: "object" },
        write: true
      }
    ],
    reserveWriteAction: (name, args) => {
      assert.equal(name, "submit_action");
      assert.equal(args.expected_state_version, 4);
      return { execute: true, key: "game-write", status: "pending" };
    },
    markWriteAction: (key, status) => marks.push([key, status]),
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === "get_my_status") return actingStatus();
      assert.equal(name, "submit_action");
      return { content: [{ type: "text", text: '{"ok":true}' }], isError: false };
    },
    callModel: async messages => {
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.equal(calls[0][0], "get_my_status");
        return modelMessage({ content: "[NO_ACTION]" });
      }
      if (modelCalls === 2) {
        assert.ok(messages.some(message =>
          message.role === "system" && String(message.content).includes("previous response attempted to finish")
        ));
        return modelMessage({
          content: null,
          tool_calls: [{
            id: "play_1",
            type: "function",
            function: {
              name: "submit_action",
              arguments: JSON.stringify({
                action: { type: "play", card_id: "yellow:number:3:2" },
                expected_state_version: 4,
                request_id: "turn-4-play"
              })
            }
          }]
        });
      }
      return modelMessage({ content: "出牌完成\n我已经完成这一回合。" });
    }
  });

  assert.equal(modelCalls, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "get_my_status");
  assert.equal(calls[1][0], "submit_action");
  assert.equal(result.toolCallsExecuted, 2);
  assert.equal(result.writeCallsExecuted, 1);
  assert.deepEqual(marks, [["game-write", "succeeded"]]);
});

test("fails closed before the model if get_my_status is unavailable for a game turn", async () => {
  let modelCalled = false;
  await assert.rejects(
    runGardenAgent({
      messages: gameWakeMessages(),
      env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
      listTools: async () => [{
        name: "submit_action",
        inputSchema: { type: "object" },
        write: true
      }],
      callModel: async () => {
        modelCalled = true;
        return modelMessage({ content: "should not run" });
      }
    }),
    /requires read-only get_my_status/
  );
  assert.equal(modelCalled, false);
});

test("fails closed before the model if the game status preflight cannot be parsed", async () => {
  let modelCalled = false;
  await assert.rejects(
    runGardenAgent({
      messages: gameWakeMessages(),
      env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
      listTools: async () => [{
        name: "get_my_status",
        inputSchema: { type: "object" },
        write: false
      }],
      callTool: async () => ({ content: [{ type: "text", text: "not-json" }] }),
      callModel: async () => {
        modelCalled = true;
        return modelMessage({ content: "should not run" });
      }
    }),
    /could not parse current game status/
  );
  assert.equal(modelCalled, false);
});
