const { parseChatCompletionResponse } = require("./upstream_response");
const { markWrite, reserveWrite } = require("./garden_action_journal");

const DEFAULT_EXECUTOR_URL = "http://garden-wake.railway.internal:8080/internal/mcp";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_MAX_WRITE_CALLS = 2;
const MAX_TOOL_RESULT_CHARS = 100_000;

class AutonomousWriteUncertainError extends Error {
  constructor(toolName, cause) {
    super(`autonomous Garden write outcome is uncertain for ${toolName}`);
    this.name = "AutonomousWriteUncertainError";
    this.code = "GARDEN_WRITE_UNCERTAIN";
    this.toolName = toolName;
    this.cause = cause;
  }
}

function readBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function modelContentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(part => typeof part === "string" ? part : String(part?.text || part?.content || ""))
    .join("");
}

function parseToolArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return parsed;
}

function toolResultContent(value) {
  const raw = JSON.stringify(value);
  if (raw.length > MAX_TOOL_RESULT_CHARS) {
    throw new Error("Garden tool result is too large for the model context");
  }
  return raw;
}

function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(tool => tool && typeof tool.name === "string" && tool.name.trim())
    .map(tool => ({
      name: tool.name.trim(),
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
          ? tool.inputSchema
          : { type: "object", properties: {} },
      write: Boolean(tool.write)
    }));
}

function toOpenAiTools(tools) {
  return tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function executorEndpoint(path, env = process.env) {
  const base = String(env.GARDEN_MCP_EXECUTOR_URL || DEFAULT_EXECUTOR_URL).replace(/\/+$/, "");
  return `${base}/${path}`;
}

async function executorRequest(path, payload = {}, env = process.env) {
  const secret = String(env.GARDEN_WAKE_SHARED_SECRET || "").trim();
  if (!secret) throw new Error("GARDEN_WAKE_SHARED_SECRET is required for Garden MCP executor");
  const timeoutMs = positiveNumber(env.GARDEN_MCP_EXECUTOR_TIMEOUT_MS, DEFAULT_EXECUTOR_TIMEOUT_MS, 1000);
  const response = await fetch(executorEndpoint(path, env), {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      "x-garden-wake-secret": secret
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || body?.success !== true) {
    const error = new Error(`Garden MCP executor returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function listGardenTools(env = process.env) {
  const body = await executorRequest("tools", {}, env);
  return normalizeToolDefinitions(body.tools);
}

async function callGardenTool(name, args, env = process.env) {
  const body = await executorRequest("call", { name, arguments: args }, env);
  return body.result;
}

async function callUpstreamModel(messages, tools, env = process.env) {
  if (!env.TARGET_API_URL || !env.TARGET_API_KEY || !env.MODEL_NAME) {
    throw new Error("TARGET_API_URL / TARGET_API_KEY / MODEL_NAME is not fully configured");
  }
  const timeoutMs = positiveNumber(
    env.GARDEN_WAKE_UPSTREAM_TIMEOUT_MS,
    positiveNumber(env.WAKE_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, 1000),
    1000
  );
  const body = {
    model: env.MODEL_NAME,
    messages,
    temperature: 0.8,
    top_p: 0.95,
    stream: false
  };
  if (tools.length > 0) {
    body.tools = toOpenAiTools(tools);
    body.tool_choice = "auto";
  }
  const response = await fetch(env.TARGET_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TARGET_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`upstream model returned HTTP ${response.status}`);
  return parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
}

function toolErrorMessage(toolCallId, name, message) {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    name,
    content: JSON.stringify({ isError: true, error: message })
  };
}

async function runGardenAgent({
  messages,
  env = process.env,
  listTools = listGardenTools,
  callTool = callGardenTool,
  callModel = callUpstreamModel,
  reserveWriteAction = reserveWrite,
  markWriteAction = markWrite
}) {
  const toolsEnabled = readBoolean(env.GARDEN_AGENT_TOOLS_ENABLED, false);
  const tools = toolsEnabled ? await listTools(env) : [];
  const toolMap = new Map(tools.map(tool => [tool.name, tool]));
  const transcript = Array.isArray(messages) ? messages.map(message => ({ ...message })) : [];
  const maxRounds = positiveNumber(env.GARDEN_AGENT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS, 1);
  const maxToolCalls = positiveNumber(env.GARDEN_AGENT_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS, 1);
  const maxWriteCalls = positiveNumber(env.GARDEN_AGENT_MAX_WRITE_CALLS, DEFAULT_MAX_WRITE_CALLS, 0);
  let toolCallsExecuted = 0;
  let writeCallsExecuted = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const data = await callModel(transcript, tools, env);
    const message = data?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length === 0) {
      return {
        rawText: modelContentText(message.content),
        toolCallsExecuted,
        writeCallsExecuted,
        toolsAvailable: tools.map(tool => tool.name)
      };
    }

    transcript.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls
    });

    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index] || {};
      const callId = String(call.id || `garden-tool-${round}-${index}`);
      const name = String(call.function?.name || "").trim();
      const definition = toolMap.get(name);

      if (!definition) {
        transcript.push(toolErrorMessage(callId, name || "unknown", "Tool is not available to the background Garden runtime."));
        continue;
      }
      if (toolCallsExecuted >= maxToolCalls) {
        transcript.push(toolErrorMessage(callId, name, "Background Garden tool-call limit reached."));
        continue;
      }

      let args;
      try {
        args = parseToolArguments(call.function?.arguments);
      } catch {
        transcript.push(toolErrorMessage(callId, name, "Tool arguments were not valid JSON."));
        continue;
      }

      if (definition.write && writeCallsExecuted >= maxWriteCalls) {
        transcript.push(toolErrorMessage(callId, name, "Background Garden write limit reached."));
        continue;
      }

      let reservation = null;
      if (definition.write) {
        reservation = reserveWriteAction(name, args, env);
        if (!reservation.execute) {
          if (reservation.status === "succeeded") {
            transcript.push({
              role: "tool",
              tool_call_id: callId,
              name,
              content: JSON.stringify({
                isError: false,
                deduplicated: true,
                message: "This exact autonomous write already succeeded earlier and was not repeated."
              })
            });
            continue;
          }
          throw new AutonomousWriteUncertainError(name, new Error(`prior write status: ${reservation.status}`));
        }
      }

      try {
        const result = await callTool(name, args, env);
        toolCallsExecuted += 1;
        if (definition.write) {
          if (result?.isError === true) {
            markWriteAction(reservation.key, "uncertain", env);
            throw new AutonomousWriteUncertainError(name, new Error("Garden MCP returned isError for a write"));
          }
          markWriteAction(reservation.key, "succeeded", env);
          writeCallsExecuted += 1;
        }
        transcript.push({
          role: "tool",
          tool_call_id: callId,
          name,
          content: toolResultContent(result)
        });
      } catch (error) {
        if (error instanceof AutonomousWriteUncertainError) throw error;
        if (definition.write && reservation?.key) {
          try { markWriteAction(reservation.key, "uncertain", env); } catch {}
          throw new AutonomousWriteUncertainError(name, error);
        }
        toolCallsExecuted += 1;
        transcript.push(toolErrorMessage(callId, name, "Garden read tool failed; do not assume any result."));
      }
    }
  }

  throw new Error("Garden background agent exceeded its maximum model rounds");
}

module.exports = {
  AutonomousWriteUncertainError,
  callGardenTool,
  callUpstreamModel,
  executorEndpoint,
  listGardenTools,
  modelContentText,
  normalizeToolDefinitions,
  parseToolArguments,
  readBoolean,
  runGardenAgent,
  toolResultContent,
  toOpenAiTools
};
