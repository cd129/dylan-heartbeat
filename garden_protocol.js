const MAX_WAKE_MESSAGE_LENGTH = 4096;
const MAX_WAKE_REASON_LENGTH = 128;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateWakeFields(reason, message) {
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > MAX_WAKE_REASON_LENGTH ||
    reason.trim() !== reason
  ) {
    throw new Error("invalid Garden wake reason");
  }
  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    message.length > MAX_WAKE_MESSAGE_LENGTH
  ) {
    throw new Error("invalid Garden wake message");
  }
  return { reason, message };
}

function validateRuntimeWake(payload) {
  if (!isRecord(payload)) throw new Error("invalid Garden runtime payload");
  if (payload.version !== 1 || payload.type !== "garden_wake") {
    throw new Error("unsupported Garden runtime payload");
  }
  return validateWakeFields(payload.reason, payload.message);
}

function decodeGardenSseEvent(eventName, data) {
  if (eventName !== "connected" && eventName !== "wake") {
    return { kind: "ignored", severity: "debug", cause: "unknown event type" };
  }

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    if (eventName === "connected") throw new Error("invalid JSON for Garden connected event");
    return { kind: "ignored", severity: "warn", cause: "invalid JSON for Garden wake event" };
  }

  if (!isRecord(payload)) {
    if (eventName === "connected") throw new Error("invalid payload for Garden connected event");
    return { kind: "ignored", severity: "warn", cause: "invalid payload for Garden wake event" };
  }

  if (eventName === "connected") {
    if (payload.version !== 1) throw new Error("unsupported Garden protocol version");
    return { kind: "connected", version: 1 };
  }

  try {
    const wake = validateWakeFields(payload.reason, payload.message);
    return { kind: "wake", ...wake };
  } catch (error) {
    return { kind: "ignored", severity: "warn", cause: error?.message || "invalid Garden wake event" };
  }
}

class SseParser {
  constructor(onEvent) {
    if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
    this.onEvent = onEvent;
    this.buffer = "";
    this.eventName = "";
    this.dataLines = [];
  }

  push(text) {
    this.buffer += String(text || "");
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line);
    }
  }

  finish() {
    if (this.buffer.length > 0) {
      let line = this.buffer;
      this.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line);
    }
    this.#dispatch();
  }

  #line(line) {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
  }

  #dispatch() {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return;
    }
    const event = {
      event: this.eventName || "message",
      data: this.dataLines.join("\n")
    };
    this.eventName = "";
    this.dataLines = [];
    this.onEvent(event);
  }
}

module.exports = {
  MAX_WAKE_MESSAGE_LENGTH,
  MAX_WAKE_REASON_LENGTH,
  SseParser,
  decodeGardenSseEvent,
  validateRuntimeWake,
  validateWakeFields
};
