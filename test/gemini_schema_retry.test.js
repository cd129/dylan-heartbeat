const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractBadFunctionName,
  removeFunctionsByName
} = require("../gemini_schema_retry");

test("extracts rejected function name from Vertex schema error", () => {
  const text = 'Unable to submit request because designAtmosphereMotion functionDeclaration parameters.anchors.color schema specified incorrect schema type field.';
  assert.equal(extractBadFunctionName(text), "designAtmosphereMotion");
});

test("removes only the rejected OpenAI tool", () => {
  const payload = {
    tools: [
      { type: "function", function: { name: "keepMe", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "designAtmosphereMotion", parameters: { type: "object", properties: {} } } }
    ]
  };
  const output = removeFunctionsByName(payload, "designAtmosphereMotion");
  assert.deepEqual(output.tools.map(tool => tool.function.name), ["keepMe"]);
  assert.equal(payload.tools.length, 2);
});

test("removes remembered names from legacy functions too", () => {
  const output = removeFunctionsByName({
    functions: [{ name: "bad" }, { name: "good" }]
  }, new Set(["bad"]));
  assert.deepEqual(output.functions.map(fn => fn.name), ["good"]);
});
