const http = require("http");
const { GardenMcpClient, readConfig } = require("./garden_mcp_client");

const OFFICIAL_GARDEN_MCP = "https://galatea.abysslumina.com/mcp";
const MAX_COMMAND_FUTURE_MS = 10 * 60 * 1000;
const ALLOWED_TOOLS = new Set([
  "list_games",
  "join_game",
  "get_my_status",
  "start_game",
  "submit_action",
  "get_tool_schema"
]);
const WRITE_TOOLS = new Set(["join_game", "start_game", "submit_action"]);

function parseCommandArgs(raw) {
  if (!raw || !String(raw).trim()) return {};
  let value;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new Error("SHIXIE_GARDEN_ARGS_JSON must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SHIXIE_GARDEN_ARGS_JSON must decode to a JSON object");
  }
  return value;
}

function readManualConfig(env = process.env) {
  const base = readConfig(env);
  const canonical = new URL(OFFICIAL_GARDEN_MCP);
  if (
    base.url.protocol !== canonical.protocol ||
    base.url.hostname !== canonical.hostname ||
    base.url.port !== canonical.port ||
    base.url.pathname.replace(/\/+$/, "") !== canonical.pathname ||
    base.url.search ||
    base.url.hash ||
    base.url.username ||
    base.url.password
  ) {
    throw new Error("Shixie executor refuses to send the machine token anywhere except the official Garden MCP endpoint");
  }

  return {
    ...base,
    policy: {
      allowed: new Set(ALLOWED_TOOLS),
      writes: new Set(WRITE_TOOLS)
    }
  };
}

function validateCommand(name, args) {
  const toolName = String(name || "").trim();
  if (!toolName) return null;
  if (!ALLOWED_TOOLS.has(toolName)) {
    const error = new Error(`Shixie executor tool is not allowed: ${toolName}`);
    error.code = "SHIXIE_TOOL_FORBIDDEN";
    throw error;
  }

  if (toolName === "submit_action") {
    if (!args.request_id || typeof args.request_id !== "string") {
      throw new Error("submit_action requires a non-empty request_id");
    }
    if (!Number.isInteger(args.expected_state_version) || args.expected_state_version < 0) {
      throw new Error("submit_action requires expected_state_version from the latest status");
    }
    if (!args.action || typeof args.action !== "object" || Array.isArray(args.action)) {
      throw new Error("submit_action requires an action object");
    }
  }

  return toolName;
}

function validateCommandWindow(rawExpiry, nowMs = Date.now()) {
  const expiryMs = Number(String(rawExpiry || "").trim());
  if (!Number.isFinite(expiryMs) || !Number.isInteger(expiryMs)) {
    throw new Error("SHIXIE_GARDEN_COMMAND_EXPIRES_AT must be an epoch-millisecond integer");
  }
  if (expiryMs <= nowMs) {
    const error = new Error("Shixie Garden command expired before execution");
    error.code = "SHIXIE_COMMAND_EXPIRED";
    throw error;
  }
  if (expiryMs - nowMs > MAX_COMMAND_FUTURE_MS) {
    throw new Error("Shixie Garden command expiry is too far in the future");
  }
  return expiryMs;
}

function safeError(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || null,
    message: String(error?.message || error).slice(0, 500)
  };
}

async function executeConfiguredCommand({ env = process.env, clientFactory, nowMs = Date.now() } = {}) {
  const args = parseCommandArgs(env.SHIXIE_GARDEN_ARGS_JSON);
  const toolName = validateCommand(env.SHIXIE_GARDEN_COMMAND, args);
  if (!toolName) return { skipped: true, reason: "no command configured" };

  const nonce = String(env.SHIXIE_GARDEN_REQUEST_NONCE || "").trim();
  if (!nonce) throw new Error("SHIXIE_GARDEN_REQUEST_NONCE is required when a command is configured");
  validateCommandWindow(env.SHIXIE_GARDEN_COMMAND_EXPIRES_AT, nowMs);

  const config = readManualConfig(env);
  const client = clientFactory ? clientFactory(config) : new GardenMcpClient(config);

  try {
    const result = await client.callTool(toolName, args);
    return {
      skipped: false,
      nonce,
      tool: toolName,
      result
    };
  } finally {
    try { await client.close(); } catch {}
  }
}

function startShixieManualExecutor() {
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, role: "shixie-manual" }));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log("Shixie manual Garden executor ready", { port, no_llm: true, public_api: false });
    executeConfiguredCommand()
      .then(output => {
        console.log("SHIXIE_GARDEN_RESULT", JSON.stringify(output));
      })
      .catch(error => {
        console.error("SHIXIE_GARDEN_RESULT", JSON.stringify({ success: false, error: safeError(error) }));
      });
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

module.exports = {
  ALLOWED_TOOLS,
  MAX_COMMAND_FUTURE_MS,
  OFFICIAL_GARDEN_MCP,
  WRITE_TOOLS,
  executeConfiguredCommand,
  parseCommandArgs,
  readManualConfig,
  startShixieManualExecutor,
  validateCommand,
  validateCommandWindow
};
