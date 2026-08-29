function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SUPPORTED_KEYS = new Set([
  "$ref",
  "$defs",
  "type",
  "nullable",
  "required",
  "format",
  "description",
  "properties",
  "items",
  "enum",
  "anyOf"
]);

function sanitizeType(type) {
  return typeof type === "string" ? type.toLowerCase() : type;
}

function mergeRequired(a, b) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
}

function isRawNullSchema(schema) {
  if (!isPlainObject(schema)) return false;
  if (sanitizeType(schema.type) === "null") return true;
  if (Object.prototype.hasOwnProperty.call(schema, "const") && schema.const === null) return true;
  return Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null;
}

function mergeAllOfIntoObject(out, branches) {
  let properties = isPlainObject(out.properties) ? { ...out.properties } : null;
  let required = Array.isArray(out.required) ? [...out.required] : [];
  let defs = isPlainObject(out.$defs) ? { ...out.$defs } : null;

  for (const branch of branches) {
    if (!isPlainObject(branch)) continue;
    if (isPlainObject(branch.properties)) properties = { ...(properties || {}), ...branch.properties };
    required = mergeRequired(required, branch.required);
    if (isPlainObject(branch.$defs)) defs = { ...(defs || {}), ...branch.$defs };
  }

  if (properties) out.properties = properties;
  if (required.length > 0) out.required = required;
  if (defs) out.$defs = defs;
}

function sanitizeSchemaNode(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaNode);
  if (!isPlainObject(schema)) return schema;

  const originalType = schema.type;
  const nullableFromType = Array.isArray(originalType)
    && originalType.map(sanitizeType).includes("null");
  const out = {};

  if (isPlainObject(schema.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, sanitizeSchemaNode(child)])
    );
  }

  const rawDefs = isPlainObject(schema.$defs)
    ? schema.$defs
    : isPlainObject(schema.definitions)
      ? schema.definitions
      : null;
  if (rawDefs) {
    out.$defs = Object.fromEntries(
      Object.entries(rawDefs).map(([name, child]) => [name, sanitizeSchemaNode(child)])
    );
  }

  if (isPlainObject(schema.items)) out.items = sanitizeSchemaNode(schema.items);

  const allOf = Array.isArray(schema.allOf) ? schema.allOf.map(sanitizeSchemaNode) : [];
  if (allOf.length > 0) mergeAllOfIntoObject(out, allOf);

  const anyOfSource = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  let anyOf = anyOfSource.map(sanitizeSchemaNode).filter(isPlainObject);

  for (const key of ["$ref", "nullable", "format", "description"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }

  if (Array.isArray(schema.required)) out.required = mergeRequired(out.required, schema.required);
  if (Array.isArray(schema.enum)) out.enum = [...schema.enum];
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !Array.isArray(out.enum)) out.enum = [schema.const];

  if (isPlainObject(out.properties)) {
    out.type = "object";
    if (nullableFromType && out.nullable === undefined) out.nullable = true;
    anyOf = [];
    delete out.items;
  } else if (Object.prototype.hasOwnProperty.call(out, "items")) {
    out.type = "array";
    if (nullableFromType && out.nullable === undefined) out.nullable = true;
    anyOf = [];
  } else if (Array.isArray(originalType)) {
    const normalized = [...new Set(originalType.map(sanitizeType).filter(type => typeof type === "string"))];
    const concrete = normalized.filter(type => type !== "null");
    if (concrete.length === 1) {
      out.type = concrete[0];
      if (normalized.includes("null") && out.nullable === undefined) out.nullable = true;
    }
  } else if (typeof originalType === "string") {
    const normalized = sanitizeType(originalType);
    if (normalized === "null") out.nullable = true;
    else out.type = normalized;
  }

  if (anyOf.length > 0) {
    const entries = anyOfSource.map((raw, index) => ({ raw, sanitized: anyOf[index] })).filter(entry => entry.sanitized);
    const nonNullEntries = entries.filter(entry => !isRawNullSchema(entry.raw));
    const hadNull = nonNullEntries.length !== entries.length;
    if (nonNullEntries.length === 1 && hadNull) {
      const branch = nonNullEntries[0].sanitized;
      for (const [key, value] of Object.entries(branch)) {
        if (key === "description" && out.description !== undefined) continue;
        out[key] = value;
      }
      out.nullable = true;
    } else {
      out.anyOf = anyOf;
    }
  }

  for (const key of Object.keys(out)) {
    if (!SUPPORTED_KEYS.has(key)) delete out[key];
  }

  if (sanitizeType(out.type) === "object") {
    out.type = "object";
    if (!isPlainObject(out.properties)) out.properties = {};
    if (Array.isArray(out.required)) {
      out.required = out.required.filter(name => Object.prototype.hasOwnProperty.call(out.properties, name));
      if (out.required.length === 0) delete out.required;
    }
  }

  return out;
}

// GG's OpenAI->Vertex bridge is demonstrably re-corrupting a conflict-free schema
// at parameters.anchors.color. The failure depth strongly indicates that its legacy
// FunctionDeclaration conversion stops normalizing type enum values after the first
// property level. Keep the OpenAI-style lowercase values at root/direct parameters,
// but pre-encode deeper nodes using Vertex's enum spelling so a shallow converter can
// safely pass them through.
function encodeDeepVertexTypes(schema, depth = 0) {
  if (!isPlainObject(schema)) return schema;
  const out = { ...schema };
  if (typeof out.type === "string" && depth >= 2) out.type = out.type.toUpperCase();

  if (isPlainObject(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([name, child]) => [name, encodeDeepVertexTypes(child, depth + 1)])
    );
  }
  if (isPlainObject(out.items)) out.items = encodeDeepVertexTypes(out.items, depth + 1);
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(child => encodeDeepVertexTypes(child, depth + 1));
  if (isPlainObject(out.$defs)) {
    out.$defs = Object.fromEntries(
      Object.entries(out.$defs).map(([name, child]) => [name, encodeDeepVertexTypes(child, depth + 1)])
    );
  }
  return out;
}

function sanitizeFunctionDefinition(fn) {
  if (!isPlainObject(fn)) return fn;
  if (!isPlainObject(fn.parameters)) return fn;
  let parameters = sanitizeSchemaNode(fn.parameters);
  parameters.type = "object";
  if (!isPlainObject(parameters.properties)) parameters.properties = {};
  parameters = encodeDeepVertexTypes(parameters, 0);
  return { ...fn, parameters };
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
  return {
    ...payload,
    ...(tools !== payload.tools ? { tools } : {}),
    ...(functions !== payload.functions ? { functions } : {})
  };
}

function findStructuralConflicts(schema, path = "parameters", found = []) {
  if (!isPlainObject(schema)) return found;
  if (isPlainObject(schema.properties) && sanitizeType(schema.type) !== "object") {
    found.push(`${path}:properties/type=${String(schema.type)}`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, "items") && sanitizeType(schema.type) !== "array") {
    found.push(`${path}:items/type=${String(schema.type)}`);
  }
  if (isPlainObject(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) findStructuralConflicts(child, `${path}.${name}`, found);
  }
  if (isPlainObject(schema.items)) findStructuralConflicts(schema.items, `${path}[]`, found);
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((child, index) => findStructuralConflicts(child, `${path}.anyOf[${index}]`, found));
  if (isPlainObject(schema.$defs)) {
    for (const [name, child] of Object.entries(schema.$defs)) findStructuralConflicts(child, `${path}.$defs.${name}`, found);
  }
  return found;
}

module.exports = {
  encodeDeepVertexTypes,
  findStructuralConflicts,
  sanitizeOpenAiToolSchemas,
  sanitizeSchemaNode
};
