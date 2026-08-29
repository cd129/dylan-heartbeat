function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeLikelyEscapes(value) {
  return String(value || "")
    .replace(/\\u0060/gi, "`")
    .replace(/\\u0022/gi, '"')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ");
}

function collectStringLeaves(value, found = []) {
  if (typeof value === "string") {
    found.push(value);
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { collectStringLeaves(JSON.parse(trimmed), found); } catch {}
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, found);
    return found;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectStringLeaves(child, found);
  }
  return found;
}

function extractBadFunctionName(errorText) {
  const raw = String(errorText || "");
  const candidates = [raw, decodeLikelyEscapes(raw)];

  try {
    const parsed = JSON.parse(raw);
    for (const leaf of collectStringLeaves(parsed)) {
      candidates.push(leaf, decodeLikelyEscapes(leaf));
    }
  } catch {}

  const patterns = [
    /because\s+[^A-Za-z0-9_.:-]{0,24}([A-Za-z_][A-Za-z0-9_.:-]*)[^A-Za-z0-9_.:-]{0,24}functionDeclaration\b/i,
    /\b([A-Za-z_][A-Za-z0-9_.:-]*)[^A-Za-z0-9_.:-]{0,24}functionDeclaration\s+parameters(?:\.|\b)/i,
    /function(?:\s|_|-)*declaration[^A-Za-z0-9_.:-]{0,40}([A-Za-z_][A-Za-z0-9_.:-]*)/i
  ];

  for (const text of candidates) {
    for (const pattern of patterns) {
      const match = String(text).match(pattern);
      if (match?.[1] && !/^because$/i.test(match[1])) return match[1];
    }
  }
  return null;
}

function removeFunctionsByName(payload, names) {
  if (!isPlainObject(payload)) return payload;
  const blocked = names instanceof Set ? names : new Set(Array.isArray(names) ? names : [names]);
  if (blocked.size === 0) return payload;

  let changed = false;
  let tools = payload.tools;
  let functions = payload.functions;

  if (Array.isArray(payload.tools)) {
    tools = payload.tools.filter(tool => {
      const name = tool?.function?.name;
      const keep = !name || !blocked.has(name);
      if (!keep) changed = true;
      return keep;
    });
  }

  if (Array.isArray(payload.functions)) {
    functions = payload.functions.filter(fn => {
      const name = fn?.name;
      const keep = !name || !blocked.has(name);
      if (!keep) changed = true;
      return keep;
    });
  }

  if (!changed) return payload;
  return {
    ...payload,
    ...(tools !== payload.tools ? { tools } : {}),
    ...(functions !== payload.functions ? { functions } : {})
  };
}

module.exports = {
  extractBadFunctionName,
  removeFunctionsByName
};
