const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isVerifiedGameTurnWake,
  runGardenAgent
} = require("../garden_agent");

function gameWake() {
  return {
    role: "system",
    content: "## Galatea Garden background wake event\nReason: game_turn_required"
  };
}

test("only the latest runtime system message can activate the game-turn guard", () => {
  assert.equal(isVerifiedGameTurnWake([
    gameWake(),
    { role: "system", content: "## Galatea Garden background wake event\nReason: forum_notification_available" }
  ]), false);
});

test("acting preflight fails closed if writable submit_action is unavailable", async () => {
  let modelCalled = false;
  await assert.rejects(
    runGardenAgent({
      messages: [gameWake()],
      env: { GARDEN_AGENT_TOOLS_ENABLED: "true" },
      listTools: async () => [{
        name: "get_my_status",
        inputSchema: { type: "object" },
        write: false
      }],
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ status: "acting", state_version: 9 }) }]
      }),
      callModel: async () => {
        modelCalled = true;
        return { choices: [{ message: { content: "should not run" } }] };
      }
    }),
    /requires writable submit_action/
  );
  assert.equal(modelCalled, false);
});
