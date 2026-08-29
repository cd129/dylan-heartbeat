const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasLeadingChatTimestamp,
  stampLatestUserMessage
} = require("../gateway_chat_timestamp");

test("stamps only the latest real user message", () => {
  const input = {
    messages: [
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant" },
      { role: "user", content: "current user" }
    ]
  };
  const output = stampLatestUserMessage(input, "2026-08-29 16:20");
  assert.equal(output.messages[0].content, "old user");
  assert.equal(output.messages[2].content, "（2026-08-29 16:20）current user");
  assert.equal(input.messages[2].content, "current user");
});

test("does not duplicate an existing Kelivo-style timestamp", () => {
  const input = { messages: [{ role: "user", content: "2026-08-29 16:20 hello" }] };
  assert.equal(stampLatestUserMessage(input, "2026-08-29 16:21"), input);
  assert.equal(hasLeadingChatTimestamp(input.messages[0].content), true);
});

test("skips internal user-role system messages", () => {
  const input = {
    messages: [
      { role: "user", content: "real user" },
      { role: "user", content: "<system>internal event</system>" }
    ]
  };
  const output = stampLatestUserMessage(input, "2026-08-29 16:20");
  assert.equal(output.messages[0].content, "（2026-08-29 16:20）real user");
  assert.equal(output.messages[1].content, "<system>internal event</system>");
});

test("stamps the first text part of multimodal user content", () => {
  const input = {
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        { type: "text", text: "look at this" }
      ]
    }]
  };
  const output = stampLatestUserMessage(input, "2026-08-29 16:20");
  assert.equal(output.messages[0].content[1].text, "（2026-08-29 16:20）look at this");
});
