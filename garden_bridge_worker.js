const { SseParser, decodeGardenSseEvent } = require("./garden_protocol");

const DEFAULT_BASE_URL = "https://galatea.abysslumina.com";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 330_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

function positiveNumber(raw, fallback, minimum = 1) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("aborted"));
    }, { once: true });
  });
}

function readConfig(env = process.env) {
  const baseUrl = new URL(String(env.GARDEN_BASE_URL || DEFAULT_BASE_URL));
  const local = ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(local && baseUrl.protocol === "http:")) {
    throw new Error("GARDEN_BASE_URL must use HTTPS");
  }

  const machineToken = String(env.GARDEN_MACHINE_TOKEN || "").trim();
  const heartbeatUrl = String(env.GARDEN_HEARTBEAT_URL || "").trim();
  const sharedSecret = String(env.GARDEN_WAKE_SHARED_SECRET || "").trim();
  if (!machineToken) throw new Error("GARDEN_MACHINE_TOKEN is required");
  if (!heartbeatUrl) throw new Error("GARDEN_HEARTBEAT_URL is required");
  if (!sharedSecret) throw new Error("GARDEN_WAKE_SHARED_SECRET is required");

  const target = new URL(heartbeatUrl);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("GARDEN_HEARTBEAT_URL must use HTTP or HTTPS");
  }

  return {
    baseUrl,
    machineToken,
    heartbeatUrl: target.toString(),
    sharedSecret,
    connectTimeoutMs: positiveNumber(env.GARDEN_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, 1000),
    deliveryTimeoutMs: positiveNumber(env.GARDEN_DELIVERY_TIMEOUT_MS, DEFAULT_DELIVERY_TIMEOUT_MS, 1000),
    maxAttempts: positiveNumber(env.GARDEN_DELIVERY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1),
    retryDelayMs: positiveNumber(env.GARDEN_DELIVERY_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 0)
  };
}

async function deliverWake(config, wake, signal) {
  const payload = {
    version: 1,
    type: "garden_wake",
    reason: wake.reason,
    message: wake.message
  };

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(config.heartbeatUrl, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.deliveryTimeoutMs)]),
        headers: {
          "Content-Type": "application/json",
          "x-garden-wake-secret": config.sharedSecret
        },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        console.log("Garden wake delivered", {
          reason: wake.reason,
          message_chars: wake.message.length,
          attempt
        });
        return true;
      }
      console.warn("Garden wake delivery rejected", {
        reason: wake.reason,
        attempt,
        status: response.status
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason || error;
      console.warn("Garden wake delivery failed", {
        reason: wake.reason,
        attempt,
        name: error?.name || "Error",
        message: error?.message || String(error)
      });
    }

    if (attempt < config.maxAttempts) await delay(config.retryDelayMs, signal);
  }

  console.error("Garden wake dropped after delivery retries", {
    reason: wake.reason,
    message_chars: wake.message.length
  });
  return false;
}

async function run(config = readConfig(), externalSignal) {
  const shutdown = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([shutdown.signal, externalSignal])
    : shutdown.signal;

  const url = new URL("/api/machine-events/stream", config.baseUrl);
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort(signal.reason || new Error("aborted"));
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();

  const connectTimer = setTimeout(
    () => requestController.abort(new Error("Garden SSE connection timed out")),
    config.connectTimeoutMs
  );

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${config.machineToken}`
      },
      redirect: "manual",
      signal: requestController.signal
    });
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok) throw new Error(`Garden SSE returned HTTP ${response.status}`);
  const contentType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "text/event-stream") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Garden SSE returned an invalid content type");
  }
  if (!response.body) throw new Error("Garden SSE response body is unavailable");

  console.log("Garden SSE connected; waiting for protocol handshake");

  let handshakeSeen = false;
  let deliveryChain = Promise.resolve();
  let deliveryFailure = null;

  const parser = new SseParser(raw => {
    let event;
    try {
      event = decodeGardenSseEvent(raw.event, raw.data);
    } catch (error) {
      deliveryFailure ||= error;
      return;
    }

    if (event.kind === "ignored") {
      if (event.severity === "warn") console.warn("Garden SSE event ignored", { cause: event.cause });
      return;
    }
    if (event.kind === "connected") {
      handshakeSeen = true;
      console.log("Garden protocol handshake accepted", { version: event.version });
      return;
    }
    if (!handshakeSeen) {
      console.warn("Garden wake ignored before protocol handshake", { reason: event.reason });
      return;
    }

    deliveryChain = deliveryChain.then(() => deliverWake(config, event, signal));
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      parser.push(decoder.decode(result.value, { stream: true }));
      if (deliveryFailure) throw deliveryFailure;
    }
    parser.push(decoder.decode());
    parser.finish();
    if (deliveryFailure) throw deliveryFailure;
    await deliveryChain;
  } finally {
    await reader.cancel().catch(() => undefined);
    signal.removeEventListener("abort", forwardAbort);
  }

  if (signal.aborted) return;
  if (!handshakeSeen) throw new Error("Garden SSE ended before protocol handshake");
  throw new Error("Garden SSE stream ended; automatic reconnect is intentionally disabled");
}

async function main() {
  const shutdown = new AbortController();
  const stop = signalName => {
    if (!shutdown.signal.aborted) {
      shutdown.abort(new Error(`received ${signalName}`));
    }
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  console.log("Galatea Garden wake worker starting", {
    automatic_reconnect: false,
    restart_policy_required: "NEVER"
  });

  try {
    await run(readConfig(), shutdown.signal);
    process.exitCode = 0;
  } catch (error) {
    if (shutdown.signal.aborted) {
      process.exitCode = 0;
      return;
    }
    console.error("Galatea Garden wake worker stopped", {
      name: error?.name || "Error",
      message: error?.message || String(error),
      automatic_reconnect: false
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { deliverWake, readConfig, run };
