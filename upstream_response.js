function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => typeof part === "string" ? part : String(part?.text || part?.content || "")).join("");
}

function mergeToolCallDelta(map, rawCall, fallbackIndex = 0) {
  if (!rawCall || typeof rawCall !== "object") return;
  const index = Number.isInteger(rawCall.index) ? rawCall.index : fallbackIndex;
  const current = map.get(index) || {
    id: "",
    type: "function",
    function: { name: "", arguments: "" }
  };
  if (typeof rawCall.id === "string") current.id = rawCall.id;
  if (typeof rawCall.type === "string") current.type = rawCall.type;
  if (rawCall.function && typeof rawCall.function === "object") {
    if (typeof rawCall.function.name === "string") current.function.name += rawCall.function.name;
    if (typeof rawCall.function.arguments === "string") current.function.arguments += rawCall.function.arguments;
  }
  map.set(index, current);
}

function parseSseChatCompletion(text) {
  let streamed = "";
  let completed = "";
  let lastPayload = null;
  let completedToolCalls = null;
  const toolCallDeltas = new Map();

  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/i);
    if (!match) continue;
    const raw = match[1].trim();
    if (!raw || raw === "[DONE]") continue;
    let payload;
    try { payload = JSON.parse(raw); } catch { continue; }
    if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    lastPayload = payload;
    const choice = payload?.choices?.[0] || {};
    const delta = contentText(choice.delta?.content);
    const message = contentText(choice.message?.content);
    const legacy = contentText(choice.text);
    if (delta) streamed += delta;
    else if (message || legacy) completed = message || legacy;

    if (Array.isArray(choice.delta?.tool_calls)) {
      choice.delta.tool_calls.forEach((call, index) => mergeToolCallDelta(toolCallDeltas, call, index));
    }
    if (Array.isArray(choice.message?.tool_calls)) completedToolCalls = choice.message.tool_calls;
  }

  const content = streamed || completed;
  const streamedToolCalls = Array.from(toolCallDeltas.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter(call => call.id || call.function.name || call.function.arguments);
  const toolCalls = completedToolCalls || (streamedToolCalls.length > 0 ? streamedToolCalls : undefined);

  if (!content && !toolCalls && !lastPayload) throw new Error("SSE 响应中没有可读取的 data JSON");
  return {
    ...(lastPayload || {}),
    choices: [{
      ...(lastPayload?.choices?.[0] || {}),
      message: {
        ...(lastPayload?.choices?.[0]?.message || {}),
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {})
      }
    }]
  };
}

function parseChatCompletionResponse(text, contentType = "") {
  const raw = String(text || "");
  // 批注 2026-08-10：官方在 stream=false 时返回 JSON；少数兼容端仍会回 data: SSE。
  // 先按真实响应识别再解析，保护官方 JSON 快路径，也避免兼容端让整次唤醒误报“不是 JSON”。
  if (/text\/event-stream/i.test(contentType) || /^\s*(?:event:.*\r?\n)?data:/i.test(raw)) {
    return parseSseChatCompletion(raw);
  }
  return JSON.parse(raw);
}

module.exports = { contentText, mergeToolCallDelta, parseChatCompletionResponse, parseSseChatCompletion };
