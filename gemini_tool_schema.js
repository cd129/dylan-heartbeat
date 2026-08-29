function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeType(type) {
  if (typeof type === "string") return type.toLowerCase();
  return type;
}

function sanitizeSchemaNode(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaNode);
  if (!isPlainObject(schema)) return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isPlainObject(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, sanitizeSchemaNode(child)])
      );
      continue;
    }

    if ((key === "$defs" || key === "definitions") && isPlainObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, sanitizeSchemaNode(child)])
      );
      continue;
    }

    if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key) && Array.isArray(value)) {
      out[key] = value.map(sanitizeSchemaNode);
      continue;
    }

    if (["items", "additionalProperties", "not", "contains", "propertyNames"].includes(key) && isPlainObject(value)) {
      out[key] = sanitizeSchemaNode(value);
      continue;
    }

    out[key] = value;
  }

  // Gemini/Vertex's function-declaration schema validator requires nodes with
  // object properties to be OBJECT and nodes with items to be ARRAY. Some
  // OpenAI-compatible clients emit contradictory or nullable type declarations.
  if (isPlainObject(out.properties)) {
    out.type = "object";
  } else if (Object.prototype.hasOwnProperty.call(out, "items")) {
    out.type = "array";
  } else if (Array.isArray(out.type)) {
    const normalized = [...new Set(out.type.map(sanitizeType).filter(type => typeof type === "string"))];
    const nullable = normalized.includes("null");
    const concrete = normalized.filter(type => type !== "null");
    if (concrete.length === 1) {
      out.type = concrete[0];
      if (nullable && out.nullable === undefined) out.nullable = true;
    }
  } else {
    out.type = sanitizeType(out.type);
  }

  if (Object.prototype.hasOwnProperty.call(out, "const") && !Array.isArray(out.enum)) {
    out.enum = [out.const];
    delete out.const;
  }

  return out;
}

function sanitizeFunctionDefinition(fn) {
  if (!isPlainObject(fn)) return fn;
  if (!isPlainObject(fn.parameters)) return fn;
  return { ...fn, parameters: sanitizeSchemaNode(fn.parameters) };
}

function sanitizeOpenAiToolSchemas(payload) {
  if (!isPlainObject(payload)) return payload;
  let changed = false;
  let tools = payload.tools;
  let functions = payload.functions;

  if (Array.isArray(payload.tools)) {
    tools = payload.tools.map(tool => {
      if (!isPlainObject(tool) || !isPlainObject(tool.function)) return tool;
      const nextFunction = sanitizeFunctionDefinition(tool.function);
      if (nextFunction === tool.function) return tool;
      changed = true;
      return { ...tool, function: nextFunction };
    });
  }

  if (Array.isArray(payload.functions)) {
    functions = payload.functions.map(fn => {
      const next = sanitizeFunctionDefinition(fn);
      if (next !== fn) changed = true;
      return next;
    });
  }

  if (!changed) return payload;
  return { ...payload, ...(tools !== payload.tools ? { tools } : {}), ...(functions !== payload.functions ? { functions } : {}) };
}

module.exports = {
  sanitizeOpenAiToolSchemas,
  sanitizeSchemaNode
};
