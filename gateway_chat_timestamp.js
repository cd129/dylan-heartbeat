function isTextPart(part) {
  if (!part || typeof part !== "object") return false;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type === "text" || type === "input_text" || typeof part.text === "string";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part === "string") return part;
      if (!isTextPart(part)) return "";
      return String(part.text ?? part.content ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

function hasLeadingChatTimestamp(content) {
  return /^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/.test(
    normalizeContentToText(content)
  );
}

function stampContent(content, timestamp) {
  const prefix = `（${timestamp}）`;
  if (typeof content === "string") return `${prefix}${content}`;

  if (Array.isArray(content)) {
    const parts = content.map(part => {
      if (part && typeof part === "object") return { ...part };
      return part;
    });
    const index = parts.findIndex(part => typeof part === "string" || isTextPart(part));
    if (index < 0) return [{ type: "text", text: prefix }, ...parts];
    if (typeof parts[index] === "string") {
      parts[index] = `${prefix}${parts[index]}`;
    } else if (typeof parts[index].text === "string") {
      parts[index].text = `${prefix}${parts[index].text}`;
    } else {
      parts[index].content = `${prefix}${String(parts[index].content ?? "")}`;
    }
    return parts;
  }

  return content;
}

function stampLatestUserMessage(payload, timestamp) {
  if (!payload || !Array.isArray(payload.messages) || !timestamp) return payload;

  let index = -1;
  for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
    const message = payload.messages[i];
    if (!message || message.role !== "user") continue;
    const text = normalizeContentToText(message.content).trim();
    if (!text || text.startsWith("<system>")) continue;
    index = i;
    break;
  }

  if (index < 0) return payload;
  const target = payload.messages[index];
  if (hasLeadingChatTimestamp(target.content)) return payload;

  const messages = payload.messages.slice();
  messages[index] = {
    ...target,
    content: stampContent(target.content, timestamp)
  };
  return { ...payload, messages };
}

module.exports = {
  hasLeadingChatTimestamp,
  normalizeContentToText,
  stampLatestUserMessage
};
