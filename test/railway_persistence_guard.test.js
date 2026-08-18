const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROBE_FILE,
  isRailwayRuntime,
  prepareRailwayPersistence
} = require("../railway_persistence_guard");

test("detects Railway runtime only from Railway markers", () => {
  assert.equal(isRailwayRuntime({}), false);
  assert.equal(isRailwayRuntime({ RAILWAY_PROJECT_ID: "p" }), true);
});

test("does not touch persistence outside Railway", () => {
  assert.deepEqual(prepareRailwayPersistence({}, new Date("2026-08-18T00:00:00Z")), {
    railway: false,
    checked: false
  });
});

test("fails closed if Railway volume mount path is missing", () => {
  assert.throws(
    () => prepareRailwayPersistence({ RAILWAY_PROJECT_ID: "p", DATA_DIR: "/tmp/data" }),
    /RAILWAY_VOLUME_MOUNT_PATH is missing/
  );
});

test("fails closed if DATA_DIR points somewhere other than the Railway volume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "railway-persistence-mismatch-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "railway-persistence-other-"));
  try {
    assert.throws(
      () => prepareRailwayPersistence({
        RAILWAY_PROJECT_ID: "p",
        RAILWAY_VOLUME_MOUNT_PATH: dir,
        DATA_DIR: other
      }),
      /DATA_DIR does not match/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("creates then advances a persistent boot probe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "railway-persistence-probe-"));
  const env = {
    RAILWAY_PROJECT_ID: "p",
    RAILWAY_VOLUME_MOUNT_PATH: dir,
    DATA_DIR: dir
  };

  try {
    const first = prepareRailwayPersistence(env, new Date("2026-08-18T01:00:00Z"));
    assert.equal(first.probeExisting, false);
    assert.equal(first.probeBoots, 1);

    const second = prepareRailwayPersistence(env, new Date("2026-08-18T02:00:00Z"));
    assert.equal(second.probeExisting, true);
    assert.equal(second.probeBoots, 2);

    const probe = JSON.parse(fs.readFileSync(path.join(dir, PROBE_FILE), "utf8"));
    assert.equal(probe.version, 1);
    assert.equal(probe.createdAt, "2026-08-18T01:00:00.000Z");
    assert.equal(probe.lastSeenAt, "2026-08-18T02:00:00.000Z");
    assert.equal(probe.boots, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed on a corrupt persistence probe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "railway-persistence-corrupt-"));
  const env = {
    RAILWAY_PROJECT_ID: "p",
    RAILWAY_VOLUME_MOUNT_PATH: dir,
    DATA_DIR: dir
  };
  try {
    fs.writeFileSync(path.join(dir, PROBE_FILE), "{broken", "utf8");
    assert.throws(
      () => prepareRailwayPersistence(env),
      /probe is unreadable/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
