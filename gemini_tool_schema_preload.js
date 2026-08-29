const { sanitizeOpenAiToolSchemas } = require("./gemini_tool_schema");

if (!global.__geminiToolSchemaCompatInstalled && typeof global.fetch === "function") {
  const originalFetch = global.fetch;
  global.__geminiToolSchemaCompatInstalled = true;

  global.fetch = async function geminiSchemaCompatFetch(input, init = {}) {
    try {
      const target = String(process.env.TARGET_API_URL || "");
      const url = typeof input === "string" || input instanceof URL
        ? String(input)
        : String(input?.url || "");
      const method = String(init.method || "GET").toUpperCase();

      if (target && url === target && method === "POST" && typeof init.body === "string") {
        const parsed = JSON.parse(init.body);
        const sanitized = sanitizeOpenAiToolSchemas(parsed);
        if (sanitized !== parsed) {
          init = { ...init, body: JSON.stringify(sanitized) };
        }
      }
    } catch (error) {
      console.warn("Gemini tool-schema compatibility pass skipped", {
        name: error?.name || "Error",
        message: String(error?.message || error).slice(0, 160)
      });
    }

    return originalFetch(input, init);
  };
}
