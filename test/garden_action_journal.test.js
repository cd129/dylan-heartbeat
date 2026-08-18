const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  canonicalize,
  makeWriteKey,
  markWrite,
  reserveWrite
} = require("../garden_action_journal");

test("canonical write keys are stable across object key order", () => {
  assert.deepEqual(canonicalize({ b: 2, a: { y: 2, x: 1 } }), { a: { x: 1, y: 2 }, b: 2 });
  assert.equal(
    makeWriteKey("reply", { thread: 1, content: "x" }),
    makeWriteKey("reply", { content: "x", thread: 1 })
  );
});

test("write journal blocks the same autonomous write after success", t => {
  const previous = process.env.DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-journal-"));
  process.env.DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = reserveWrite("reply_thread", { thread_id: 7, content: "hello" }, process.env, 1000);
  assert.equal(first.execute, true);
  markWrite(first.key, "succeeded", process.env, 1100);
  const second = reserveWrite("reply_thread", { content: "hello", thread_id: 7 }, process.env, 1200);
  assert.deepEqual(second, { execute: false, key: first.key, status: "succeeded" });
});

test("unreadable action journal fails closed", t => {
  const previous = process.env.DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-journal-bad-"));
  process.env.DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, "garden_action_journal.json"), "{broken", "utf8");
  t.after(() => {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(
    () => reserveWrite("reply_thread", { thread_id: 1 }, process.env, Date.now()),
    /refusing autonomous writes/
  );
});
