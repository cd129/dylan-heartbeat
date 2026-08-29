const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeOpenAiToolSchemas,
  sanitizeSchemaNode
} = require("../gemini_tool_schema");

test("fixes nested object schemas whose type contradicts properties", () => {
  const input = {
    tools: [{
      type: "function",
      function: {
        name: "designAtmosphereMotion",
        parameters: {
          type: "object",
          properties: {
            anchors: {
              type: "object",
              properties: {
                color: {
                  type: "string",
                  properties: {
                    r: { type: "number" },
                    g: { type: "number" },
                    b: { type: "number" }
                  }
                }
              }
            }
          }
        }
      }
    }]
  };

  const output = sanitizeOpenAiToolSchemas(input);
  assert.equal(output.tools[0].function.parameters.properties.anchors.properties.color.type, "object");
  assert.equal(input.tools[0].function.parameters.properties.anchors.properties.color.type, "string");
});

test("recursively infers array type from items", () => {
  const output = sanitizeSchemaNode({
    type: "object",
    properties: {
      anchors: {
        type: "string",
        items: {
          type: "string",
          properties: { x: { type: "number" } }
        }
      }
    }
  });

  assert.equal(output.properties.anchors.type, "array");
  assert.equal(output.properties.anchors.items.type, "object");
});

test("normalizes nullable single-type arrays and const", () => {
  const output = sanitizeSchemaNode({
    type: ["STRING", "null"],
    const: "fixed"
  });

  assert.equal(output.type, "string");
  assert.equal(output.nullable, true);
  assert.deepEqual(output.enum, ["fixed"]);
  assert.equal(Object.prototype.hasOwnProperty.call(output, "const"), false);
});

test("leaves requests without tool schemas untouched", () => {
  const input = { model: "gemini", messages: [] };
  assert.equal(sanitizeOpenAiToolSchemas(input), input);
});

test("supports legacy functions payloads", () => {
  const output = sanitizeOpenAiToolSchemas({
    functions: [{
      name: "legacy",
      parameters: {
        properties: {
          value: { type: "STRING" }
        }
      }
    }]
  });

  assert.equal(output.functions[0].parameters.type, "object");
  assert.equal(output.functions[0].parameters.properties.value.type, "string");
});
