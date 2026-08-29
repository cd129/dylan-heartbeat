function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractBadFunctionName(errorText) {
  const text = String(errorText || "");
  const patterns = [
    /because\s+([A-Za-z0-9_.:-]+)\s+functionDeclaration\b/i,
    /\b([A-Za-z0-9_.:-]+)\s+functionDeclaration\s+parameters(?:\.|\b)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
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
