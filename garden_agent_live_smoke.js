const {
  listGardenTools,
  runGardenAgent
} = require("./garden_agent");

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

async function main() {
  if (!enabled(process.env.GARDEN_AGENT_LIVE_SMOKE)) {
    console.log("Garden agent live smoke skipped");
    return;
  }

  const env = {
    ...process.env,
    GARDEN_AGENT_TOOLS_ENABLED: "true",
    GARDEN_AGENT_MAX_ROUNDS: "3",
    GARDEN_AGENT_MAX_TOOL_CALLS: "2",
    GARDEN_AGENT_MAX_WRITE_CALLS: "0",
    GARDEN_AGENT_TOTAL_TIMEOUT_MS: "60000"
  };

  const listOnlyNotifications = async (runtimeEnv, control) => {
    const tools = await listGardenTools(runtimeEnv, control);
    const selected = tools.filter(tool => tool.name === "list_notifications" && tool.write !== true);
    if (selected.length !== 1) {
      throw new Error("read-only live smoke requires exactly one non-write list_notifications tool");
    }
    return selected;
  };

  const result = await runGardenAgent({
    env,
    listTools: listOnlyNotifications,
    messages: [{
      role: "system",
      content: [
        "This is a deployment smoke test, not a user conversation.",
        "You have exactly one read-only Garden tool available: list_notifications.",
        "Call list_notifications exactly once to verify the tool path, then output exactly [NO_ACTION].",
        "Do not summarize, quote, or reveal notification content. Do not attempt any other action."
      ].join("\n")
    }]
  });

  if (result.writeCallsExecuted !== 0) {
    throw new Error("Garden live smoke unexpectedly executed a write");
  }
  if (result.toolCallsExecuted !== 1) {
    throw new Error(`Garden live smoke expected exactly one tool call, got ${result.toolCallsExecuted}`);
  }
  if (result.toolsAvailable.length !== 1 || result.toolsAvailable[0] !== "list_notifications") {
    throw new Error("Garden live smoke exposed an unexpected tool set");
  }

  console.log("Garden agent live smoke passed", {
    tool_calls: result.toolCallsExecuted,
    writes: result.writeCallsExecuted,
    tool: "list_notifications"
  });
}

main().catch(error => {
  console.error("Garden agent live smoke failed", {
    name: error?.name || "Error",
    message: String(error?.message || error).slice(0, 240)
  });
  process.exitCode = 1;
});
