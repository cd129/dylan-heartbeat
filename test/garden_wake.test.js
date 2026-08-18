const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SseParser,
  decodeGardenSseEvent,
  validateRuntimeWake
} = require("../garden_protocol");
const { safeSecretEqual } = require("../garden_auth");
const {
  normalizeEventSummary,
  parseGardenModelOutput
} = require("../garden_runtime");

test("validates Garden runtime payloads", () => {
  assert.deepEqual(
    validateRuntimeWake({
      version: 1,
      type: "garden_wake",
      reason: "forum_notification_available",
      message: "hello"
    }),
    { reason: "forum_notification_available", message: "hello" }
  );
  assert.throws(() => validateRuntimeWake({
    version: 1,
    type: "garden_wake",
    reason: " bad ",
    message: "hello"
  }), /reason/);
  assert.throws(() => validateRuntimeWake({
    version: 2,
    type: "garden_wake",
    reason: "x",
    message: "hello"
  }), /unsupported/);
});

test("SSE parser handles CRLF and multiline data", () => {
  const events = [];
  const parser = new SseParser(event => events.push(event));
  parser.push("event: connected\r\ndata: {\"version\":1}\r\n\r\n");
  parser.push("event: wake\ndata: {\"reason\":\"x\",\n");
  parser.push("data: \"message\":\"hello\"}\n\n");
  parser.finish();
  assert.equal(events.length, 2);
  assert.deepEqual(decodeGardenSseEvent(events[0].event, events[0].data), {
    kind: "connected",
    version: 1
  });
  assert.deepEqual(decodeGardenSseEvent(events[1].event, events[1].data), {
    kind: "wake",
    reason: "x",
    message: "hello"
  });
});

test("invalid wake payload is ignored without killing the protocol stream", () => {
  assert.deepEqual(
    decodeGardenSseEvent("wake", "{not-json"),
    { kind: "ignored", severity: "warn", cause: "invalid JSON for Garden wake event" }
  );
});

test("rejects unsupported Garden protocol version", () => {
  assert.throws(
    () => decodeGardenSseEvent("connected", "{\"version\":2}"),
    /protocol version/
  );
});

test("secret comparison requires exact non-empty match", () => {
  assert.equal(safeSecretEqual("abc", "abc"), true);
  assert.equal(safeSecretEqual("abc", "abd"), false);
  assert.equal(safeSecretEqual("abc", "ab"), false);
  assert.equal(safeSecretEqual("", ""), false);
});

test("Garden model output parser handles no-action and push", () => {
  assert.deepEqual(parseGardenModelOutput("[NO_ACTION] 不重要"), {
    action: "no_action",
    reason: "不重要"
  });
  assert.deepEqual(parseGardenModelOutput("花园有新消息\n有人回复了你的帖子。"), {
    action: "push",
    title: "花园有新消息",
    body: "有人回复了你的帖子。"
  });
});

test("event summary is flattened and bounded", () => {
  const value = normalizeEventSummary("a\n  b " + "x".repeat(500));
  assert.equal(value.includes("\n"), false);
  assert.ok(value.length <= 300);
});
