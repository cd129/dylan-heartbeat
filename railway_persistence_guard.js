const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, resolveDataDir, writeJsonAtomicSync } = require("./runtime_paths");

const PROBE_FILE = ".railway_persistence_probe.json";

function isRailwayRuntime(env = process.env) {
  return Boolean(
    env.RAILWAY_ENVIRONMENT ||
    env.RAILWAY_PROJECT_ID ||
    env.RAILWAY_SERVICE_ID
  );
}

function normalizedAbsolute(value) {
  return path.resolve(String(value || ""));
}

function decodeMountInfoField(value) {
  return String(value || "").replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function mountInfoHasPath(mountInfoText, mountPath) {
  const target = normalizedAbsolute(mountPath);
  return String(mountInfoText || "")
    .split("\n")
    .some(line => {
      if (!line.trim()) return false;
      const fields = line.trim().split(/\s+/);
      if (fields.length < 6) return false;
      return normalizedAbsolute(decodeMountInfoField(fields[4])) === target;
    });
}

function readMountInfo() {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch (error) {
    throw new Error(`Unable to inspect Linux mount table: ${error?.message || error}`);
  }
}

function prepareRailwayPersistence(env = process.env, now = new Date(), options = {}) {
  if (!isRailwayRuntime(env)) {
    return { railway: false, checked: false };
  }

  const mountPath = String(env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (!mountPath) {
    throw new Error("RAILWAY_VOLUME_MOUNT_PATH is missing; refusing stateful Railway runtime");
  }

  const dataDir = resolveDataDir(env);
  if (normalizedAbsolute(dataDir) !== normalizedAbsolute(mountPath)) {
    throw new Error("DATA_DIR does not match the Railway volume mount path");
  }

  const mountInfoText = Object.prototype.hasOwnProperty.call(options, "mountInfoText")
    ? options.mountInfoText
    : readMountInfo();
  if (!mountInfoHasPath(mountInfoText, mountPath)) {
    throw new Error("Railway volume mount path is not an active Linux mount point");
  }

  fs.mkdirSync(dataDir, { recursive: true });

  const appStat = fs.statSync(PROJECT_DIR);
  const dataStat = fs.statSync(dataDir);
  const probePath = path.join(dataDir, PROBE_FILE);
  const timestamp = now.toISOString();
  let existing = false;
  let boots = 1;
  let createdAt = timestamp;

  if (fs.existsSync(probePath)) {
    existing = true;
    let prior;
    try {
      prior = JSON.parse(fs.readFileSync(probePath, "utf8"));
    } catch (error) {
      throw new Error(`Railway persistence probe is unreadable: ${error?.message || error}`);
    }
    if (!prior || prior.version !== 1 || !Number.isInteger(prior.boots) || prior.boots < 1) {
      throw new Error("Railway persistence probe has an invalid format");
    }
    boots = prior.boots + 1;
    createdAt = typeof prior.createdAt === "string" && prior.createdAt
      ? prior.createdAt
      : timestamp;
  }

  writeJsonAtomicSync(probePath, {
    version: 1,
    createdAt,
    lastSeenAt: timestamp,
    boots
  });

  return {
    railway: true,
    checked: true,
    dataDir,
    mountPath,
    probeExisting: existing,
    probeBoots: boots,
    distinctDeviceFromApp: appStat.dev !== dataStat.dev
  };
}

module.exports = {
  PROBE_FILE,
  decodeMountInfoField,
  isRailwayRuntime,
  mountInfoHasPath,
  prepareRailwayPersistence
};
