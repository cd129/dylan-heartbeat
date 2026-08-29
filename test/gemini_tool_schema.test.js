const test = require("node:test");
const assert = require("node:assert/strict");

const {
  encodeDeepVertexTypes,
  findStructuralConflicts,
  sanitizeOpenAiToolSchemas,
  sanitizeSchemaNode
} = require("../gemini_tool_schema");

test("fixes nested object schemas and pre-encodes deep Vertex type enums", () => {
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
  const parameters = output.tools[0].function.parameters;
  const anchors = parameters.properties.anchors;
  const color = anchors.properties.color;
  assert.equal(parameters.type, "object");
  assert.equal(anchors.type, "object");
  assert.equal(color.type, "OBJECT");
  assert.equal(color.properties.r.type, "NUMBER");
  assert.deepEqual(findStructuralConflicts(parameters), []);
  assert.equal(input.tools[0].function.parameters.properties.anchors.properties.color.type, "string");
});

test("deep enum encoding leaves root and direct parameter types lowercase", () => {
  const output = encodeDeepVertexTypes({
    type: "object",
    properties: {
      first: {
        type: "object",
        properties: { second: { type: "string" } }
      }
    }
  });
  assert.equal(output.type, "object");
  assert.equal(output.properties.first.type, "object");
  assert.equal(output.properties.first.properties.second.type, "STRING");
});

test("drops conflicting union metadata from structural objects", () => {
  const output = sanitizeSchemaNode({
    type: "string",
    oneOf: [{ type: "string" }, { type: "object", properties: { hex: { type: "string" } } }],
    properties: { r: { type: "number" }, g: { type: "number" } },
    additionalProperties: false,
    default: { r: 0, g: 0 }
  });

  assert.equal(output.type, "object");
  assert.equal(Object.prototype.hasOwnProperty.call(output, "anyOf"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(output, "oneOf"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(output, "additionalProperties"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(output, "default"), false);
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

test("converts nullable anyOf to a concrete nullable schema", () => {
  const output = sanitizeSchemaNode({
    anyOf: [{ type: "string" }, { type: "null" }],
    description: "optional text"
  });

  assert.equal(output.type, "string");
  assert.equal(output.nullable, true);
  assert.equal(output.description, "optional text");
});

test("merges object allOf branches and strips unsupported keyword", () => {
  const output = sanitizeSchemaNode({
    allOf: [
      { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      { type: "object", properties: { y: { type: "number" } }, required: ["y"] }
    ]
  });

  assert.equal(output.type, "object");
  assert.deepEqual(Object.keys(output.properties).sort(), ["x", "y"]);
  assert.deepEqual(output.required.sort(), ["x", "y"]);
  assert.equal(Object.prototype.hasOwnProperty.call(output, "allOf"), false);
});

test("forces function parameter roots to objects", () => {
  const output = sanitizeOpenAiToolSchemas({
    tools: [{ type: "function", function: { name: "odd", parameters: { type: "string" } } }]
  });
  assert.equal(output.tools[0].function.parameters.type, "object");
  assert.deepEqual(output.tools[0].function.parameters.properties, {});
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
