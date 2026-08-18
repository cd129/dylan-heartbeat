const crypto = require("crypto");
const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 500;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function makeWriteKey(toolName, args) {
  return crypto
    .createHash("sha256")
    .update(String(toolName || ""))
    .update("\0")
    .update(JSON.stringify(canonicalize(args || {})))
    .digest("hex");
}

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function journalPath() {
  return runtimeFile("garden_action_journal.json");
}

function loadJournal() {
  const file = journalPath();
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.error("Garden action journal read failed", {
      name: error?.name || "Error",
      message: error?.message || String(error)
    });
    throw new Error("Garden action journal is unreadable; refusing autonomous writes");
  }
}

function saveJournal(records) {
  writeJsonAtomicSync(journalPath(), records);
}

function pruneJournal(records, env = process.env, now = Date.now()) {
  const retentionMs = positiveNumber(env.GARDEN_WRITE_DEDUPE_RETENTION_MS, DEFAULT_RETENTION_MS, 60_000);
  const maxRecords = positiveNumber(env.GARDEN_WRITE_DEDUPE_MAX_RECORDS, DEFAULT_MAX_RECORDS, 10);
  return records
    .filter(record => Number(record?.updatedAt || record?.createdAt || 0) >= now - retentionMs)
    .sort((a, b) => Number(a.updatedAt || a.createdAt || 0) - Number(b.updatedAt || b.createdAt || 0))
    .slice(-maxRecords);
}

function reserveWrite(toolName, args, env = process.env, now = Date.now()) {
  const key = makeWriteKey(toolName, args);
  const records = pruneJournal(loadJournal(), env, now);
  const existing = records.find(record => record.key === key);
  if (existing) {
    return {
      execute: false,
      key,
      status: String(existing.status || "unknown")
    };
  }

  records.push({
    key,
    tool: String(toolName || ""),
    status: "pending",
    createdAt: now,
    updatedAt: now
  });
  saveJournal(pruneJournal(records, env, now));
  return { execute: true, key, status: "pending" };
}

function markWrite(key, status, env = process.env, now = Date.now()) {
  const allowedStatuses = new Set(["succeeded", "uncertain"]);
  if (!allowedStatuses.has(status)) throw new Error("invalid Garden write journal status");
  const records = pruneJournal(loadJournal(), env, now);
  const record = records.find(item => item.key === key);
  if (!record) throw new Error("Garden write journal reservation is missing");
  record.status = status;
  record.updatedAt = now;
  saveJournal(pruneJournal(records, env, now));
  return record;
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  DEFAULT_RETENTION_MS,
  canonicalize,
  loadJournal,
  makeWriteKey,
  markWrite,
  pruneJournal,
  reserveWrite
};
