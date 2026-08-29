const {
  findStructuralConflicts,
  sanitizeOpenAiToolSchemas
} = require("./gemini_tool_schema");
const {
  extractBadFunctionName,
  removeFunctionsByName
} = require("./gemini_schema_retry");

// This specific Kelivo tool has repeatedly reached GG as an invalid Vertex
// FunctionDeclaration even after the outgoing OpenAI schema was structurally clean.
// Block it before the first GG request rather than relying on parsing GG's 400 body.
const KNOWN_GG_BAD_TOOL_SCHEMAS = new Set(["designAtmosphereMotion"]);

if (!global.__geminiToolSchemaCompatInstalled && typeof global.fetch === "function") {
  const originalFetch = global.fetch;
  const badToolSchemas = global.__geminiBadToolSchemas || new Set(KNOWN_GG_BAD_TOOL_SCHEMAS);
  for (const name of KNOWN_GG_BAD_TOOL_SCHEMAS) badToolSchemas.add(name);
  global.__geminiBadToolSchemas = badToolSchemas;
  global.__geminiToolSchemaCompatInstalled = true;

  global.fetch = async function geminiSchemaCompatFetch(input, init = {}) {
    const target = String(process.env.TARGET_API_URL || "");
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");
    const method = String(init.method || "GET").toUpperCase();

    if (!(target && url === target && method === "POST" && typeof init.body === "string")) {
      return originalFetch(input, init);
    }

    let payload;
    try {
      const parsed = JSON.parse(init.body);
      payload = sanitizeOpenAiToolSchemas(parsed);
      payload = removeFunctionsByName(payload, badToolSchemas);

      const functions = Array.isArray(payload.tools)
        ? payload.tools
            .map(tool => tool?.function)
            .filter(fn => fn && typeof fn === "object")
        : [];
      const conflicts = functions.flatMap(fn =>
        findStructuralConflicts(fn.parameters).map(path => `${fn.name || "unknown"}:${path}`)
      );
      console.log(JSON.stringify({
        event: "gemini_tool_schema_sanitized",
        tool_count: functions.length,
        designAtmosphereMotion_present: functions.some(fn => fn.name === "designAtmosphereMotion"),
        structural_conflicts_after: conflicts.slice(0, 20),
        structural_conflict_count_after: conflicts.length,
        blocked_tool_schema_count: badToolSchemas.size,
        known_bad_tool_block_active: badToolSchemas.has("designAtmosphereMotion")
      }));
    } catch (error) {
      console.warn("Gemini tool-schema compatibility pass skipped", {
        name: error?.name || "Error",
        message: String(error?.message || error).slice(0, 160)
      });
      return originalFetch(input, init);
    }

    const maxSchemaRetries = 3;
    let attempt = 0;
    let currentPayload = payload;

    while (true) {
      const response = await originalFetch(input, {
        ...init,
        body: JSON.stringify(currentPayload)
      });

      if (response.status !== 400 || attempt >= maxSchemaRetries) return response;

      let errorText = "";
      try {
        errorText = await response.clone().text();
      } catch (error) {
        console.warn(JSON.stringify({
          event: "gemini_schema_retry_body_read_failed",
          message: String(error?.message || error).slice(0, 160)
        }));
        return response;
      }

      const badFunctionName = extractBadFunctionName(errorText);
      console.warn(JSON.stringify({
        event: "gemini_schema_400_inspected",
        extracted_function: badFunctionName,
        error_mentions_function_declaration: /functionDeclaration/i.test(errorText),
        error_chars: errorText.length
      }));

      if (!badFunctionName) return response;

      const nextPayload = removeFunctionsByName(currentPayload, badFunctionName);
      if (nextPayload === currentPayload) {
        console.warn(JSON.stringify({
          event: "gemini_schema_retry_tool_not_found",
          rejected_function: badFunctionName
        }));
        return response;
      }

      badToolSchemas.add(badFunctionName);
      attempt += 1;
      currentPayload = nextPayload;

      const remainingToolCount = Array.isArray(currentPayload.tools)
        ? currentPayload.tools.filter(tool => tool?.function?.name).length
        : 0;
      console.warn(JSON.stringify({
        event: "gemini_schema_retry_drop_tool",
        rejected_function: badFunctionName,
        retry_attempt: attempt,
        remaining_tool_count: remainingToolCount,
        remembered_bad_tool_count: badToolSchemas.size
      }));
    }
  };
}
