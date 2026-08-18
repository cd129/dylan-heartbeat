const test = require("node:test");
const assert = require("node:assert/strict");
const { deliverWake, readConfig } = require("../garden_bridge_worker");

test("bridge config requires credentials and HTTPS Garden URL", () => {
  assert.throws(() => readConfig({
    GARDEN_BASE_URL: "https://galatea.abysslumina.com",
    GARDEN_HEARTBEAT_URL: "http://dylan-heartbeat.railway.internal:3000/internal/garden-wake",
    GARDEN_WAKE_SHARED_SECRET: "secret"
  }), /GARDEN_MACHINE_TOKEN/);

  assert.throws(() => readConfig({
    GARDEN_BASE_URL: "http://example.com",
    GARDEN_MACHINE_TOKEN: "machine",
    GARDEN_HEARTBEAT_URL: "http://dylan-heartbeat.railway.internal:3000/internal/garden-wake",
    GARDEN_WAKE_SHARED_SECRET: "secret"
  }), /HTTPS/);

  const config = readConfig({
    GARDEN_BASE_URL: "https://galatea.abysslumina.com",
    GARDEN_MACHINE_TOKEN: "machine",
    GARDEN_HEARTBEAT_URL: "http://dylan-heartbeat.railway.internal:3000/internal/garden-wake",
    GARDEN_WAKE_SHARED_SECRET: "secret"
  });
  assert.equal(config.machineToken, "machine");
  assert.equal(config.sharedSecret, "secret");
});

test("delivery sends only the bridge shared secret to Heartbeat", async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return { ok: true, status: 200 };
  };

  try {
    const config = {
      heartbeatUrl: "http://heartbeat.internal/internal/garden-wake",
      sharedSecret: "bridge-secret",
      deliveryTimeoutMs: 5000,
      maxAttempts: 2,
      retryDelayMs: 0
    };
    const controller = new AbortController();
    const ok = await deliverWake(
      config,
      { reason: "forum_notification_available", message: "hello" },
      controller.signal
    );
    assert.equal(ok, true);
    assert.equal(captured.init.headers["x-garden-wake-secret"], "bridge-secret");
    assert.equal(captured.init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(captured.init.body), {
      version: 1,
      type: "garden_wake",
      reason: "forum_notification_available",
      message: "hello"
    });
  } finally {
    global.fetch = originalFetch;
  }
});
