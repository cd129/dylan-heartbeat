const { safeSecretEqual } = require("./garden_auth");
const { GardenMcpClient } = require("./garden_mcp_client");

const MAX_REQUEST_BODY_BYTES = 128 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error("request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed;
}

function createGardenSidecarApi({ executor = new GardenMcpClient(), env = process.env } = {}) {
  const expectedSecret = String(env.GARDEN_WAKE_SHARED_SECRET || "").trim();

  async function handle(req, res) {
    const requestUrl = new URL(req.url || "/", "http://garden-sidecar.local");
    const path = requestUrl.pathname;
    if (path !== "/internal/mcp/tools" && path !== "/internal/mcp/call") return false;

    if (req.method !== "POST") {
      sendJson(res, 405, { success: false, error: "method not allowed" });
      return true;
    }

    const suppliedSecret = String(req.headers["x-garden-wake-secret"] || "");
    if (!expectedSecret || !safeSecretEqual(expectedSecret, suppliedSecret)) {
      sendJson(res, 401, { success: false, error: "unauthorized" });
      return true;
    }

    try {
      if (path === "/internal/mcp/tools") {
        const tools = await executor.listAllowedTools();
        sendJson(res, 200, { success: true, tools });
        return true;
      }

      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const args = body.arguments;
      if (!name || !args || typeof args !== "object" || Array.isArray(args)) {
        sendJson(res, 400, { success: false, error: "invalid tool call payload" });
        return true;
      }

      const result = await executor.callTool(name, args);
      sendJson(res, 200, { success: true, result });
      return true;
    } catch (error) {
      const forbidden = error?.code === "TOOL_FORBIDDEN";
      const bodyTooLarge = error?.code === "BODY_TOO_LARGE";
      console.error("Garden MCP sidecar request failed", {
        path,
        name: error?.name || "Error",
        code: error?.code || null,
        message: forbidden ? "forbidden tool" : bodyTooLarge ? "request too large" : String(error?.message || error).slice(0, 200)
      });
      sendJson(res, forbidden ? 403 : bodyTooLarge ? 413 : 502, {
        success: false,
        error: forbidden
          ? "tool forbidden by background policy"
          : bodyTooLarge
            ? "request body too large"
            : "Garden MCP request failed"
      });
      return true;
    }
  }

  return { handle, executor };
}

module.exports = {
  MAX_REQUEST_BODY_BYTES,
  createGardenSidecarApi,
  readJsonBody,
  sendJson
};
