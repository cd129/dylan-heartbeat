const DEFAULT_MCP_URL = "https://galatea.abysslumina.com/mcp";
const DEFAULT_RESULT_LIMIT_BYTES = 128 * 1024;
const MAX_TOOL_PAGES = 20;

function parseCsvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function readPolicy(env = process.env) {
  const allowed = parseCsvSet(env.GARDEN_MCP_ALLOWED_TOOLS);
  const writes = parseCsvSet(env.GARDEN_MCP_WRITE_TOOLS);
  for (const name of writes) {
    if (!allowed.has(name)) {
      throw new Error(`GARDEN_MCP_WRITE_TOOLS contains non-allowed tool: ${name}`);
    }
  }
  return { allowed, writes };
}

function readConfig(env = process.env) {
  const token = String(env.GARDEN_MACHINE_TOKEN || "").trim();
  if (!token) throw new Error("GARDEN_MACHINE_TOKEN is required for Garden MCP");

  const url = new URL(String(env.GARDEN_MCP_URL || DEFAULT_MCP_URL));
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("GARDEN_MCP_URL must use HTTPS");
  }

  const resultLimit = Number(env.GARDEN_MCP_RESULT_LIMIT_BYTES);
  return {
    token,
    url,
    resultLimitBytes:
      Number.isFinite(resultLimit) && resultLimit >= 4096
        ? Math.floor(resultLimit)
        : DEFAULT_RESULT_LIMIT_BYTES,
    policy: readPolicy(env)
  };
}

function ensurePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeInputSchema(value) {
  const schema = ensurePlainObject(value);
  return Object.keys(schema).length > 0
    ? schema
    : { type: "object", properties: {}, additionalProperties: false };
}

function safeToolDefinition(tool, write) {
  return {
    name: String(tool?.name || ""),
    description: typeof tool?.description === "string" ? tool.description : "",
    inputSchema: safeInputSchema(tool?.inputSchema),
    write: Boolean(write)
  };
}

function enforceResultLimit(value, limitBytes) {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > limitBytes) {
    throw new Error("Garden MCP tool result exceeded the configured size limit");
  }
  return value;
}

class GardenMcpClient {
  constructor(config = readConfig()) {
    this.config = config;
    this.client = null;
    this.transport = null;
    this.operationTail = Promise.resolve();
  }

  async connect() {
    if (this.client) return this.client;

    let sdk;
    try {
      sdk = require("@modelcontextprotocol/client");
    } catch (error) {
      throw new Error(`failed to load @modelcontextprotocol/client: ${error?.message || error}`);
    }

    const { Client, StreamableHTTPClientTransport } = sdk;
    const client = new Client({ name: "dylan-garden-sidecar", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(this.config.url, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.config.token}`
        }
      }
    });

    try {
      await client.connect(transport);
    } catch (error) {
      try { await client.close(); } catch {}
      throw error;
    }

    this.client = client;
    this.transport = transport;
    return client;
  }

  async runExclusive(fn) {
    const run = this.operationTail.then(fn, fn);
    this.operationTail = run.catch(() => undefined);
    return run;
  }

  async listAllTools() {
    return this.runExclusive(async () => {
      const client = await this.connect();
      try {
        const tools = [];
        let cursor;
        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
          const result = await client.listTools(cursor ? { cursor } : undefined);
          if (Array.isArray(result?.tools)) tools.push(...result.tools);
          cursor = result?.nextCursor;
          if (!cursor) return tools;
        }
        throw new Error("Garden MCP returned too many tool pages");
      } catch (error) {
        await this.invalidate();
        throw error;
      }
    });
  }

  async listAllowedTools() {
    const tools = await this.listAllTools();
    const { allowed, writes } = this.config.policy;
    return tools
      .filter(tool => allowed.has(String(tool?.name || "")))
      .map(tool => safeToolDefinition(tool, writes.has(tool.name)));
  }

  async discoverToolNames() {
    const tools = await this.listAllTools();
    return tools.map(tool => String(tool?.name || "")).filter(Boolean).sort();
  }

  async callTool(name, args) {
    const toolName = String(name || "").trim();
    if (!toolName) throw new Error("Garden MCP tool name is required");
    if (!this.config.policy.allowed.has(toolName)) {
      const error = new Error("Garden MCP tool is not allowed by background policy");
      error.code = "TOOL_FORBIDDEN";
      throw error;
    }

    const toolArgs = ensurePlainObject(args);
    return this.runExclusive(async () => {
      const client = await this.connect();
      try {
        const result = await client.callTool({ name: toolName, arguments: toolArgs });
        return enforceResultLimit(result, this.config.resultLimitBytes);
      } catch (error) {
        await this.invalidate();
        throw error;
      }
    });
  }

  async invalidate() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try { await client.close(); } catch {}
    }
  }

  async close() {
    await this.invalidate();
  }
}

module.exports = {
  DEFAULT_MCP_URL,
  GardenMcpClient,
  enforceResultLimit,
  parseCsvSet,
  readConfig,
  readPolicy,
  safeInputSchema,
  safeToolDefinition
};
