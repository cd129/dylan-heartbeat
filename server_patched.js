// Runtime patch for Dylan Heartbeat on Railway.
// Keeps upstream source changes minimal while fixing two deployment-level issues:
// 1) ordinary Kelivo chats know the Bark capability boundary without ever seeing the key;
// 2) /admin/test-bark actually sends a Bark push instead of only writing a fake timeline event.

const Fastify = require("fastify");
const originalFetch = global.fetch;

const RUNTIME_AWARENESS = `\n\n## Dylan Heartbeat 运行环境说明\n- 你通过 Dylan Heartbeat 获得“后台自主唤醒后向用户发送 Bark 推送”的能力。\n- Bark Device Key 由服务器安全保管，你看不到、也不需要知道它；不要向用户索要 Bark Key、Device Key 或 Bark 专属链接。\n- 普通聊天回复本身不能直接触发 Bark 推送。只有后台自动唤醒流程会根据你的输出决定是否推送，并由服务器代为发送。\n- 如果用户在普通聊天里要求“现在给 Bark 发一条测试消息”，请如实说明普通聊天不能直接触发推送；不要假装已经发送。`;

function injectRuntimeAwareness(payload) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages.map(message => ({ ...message }));
  const systemIndex = messages.findIndex(message => message && message.role === "system");

  if (systemIndex >= 0) {
    const current = typeof messages[systemIndex].content === "string"
      ? messages[systemIndex].content
      : String(messages[systemIndex].content ?? "");
    if (!current.includes("## Dylan Heartbeat 运行环境说明")) {
      messages[systemIndex].content = current + RUNTIME_AWARENESS;
    }
  } else {
    messages.unshift({
      role: "system",
      content: RUNTIME_AWARENESS.trim()
    });
  }

  return { ...payload, messages };
}

// Patch fetch only inside the gateway process. wake_up.js still runs as its own process,
// so its autonomous wake prompt and Bark delivery path are unchanged.
global.fetch = async function patchedFetch(input, init = {}) {
  try {
    const target = String(process.env.TARGET_API_URL || "");
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");

    if (target && url === target && String(init.method || "GET").toUpperCase() === "POST" && typeof init.body === "string") {
      const parsed = JSON.parse(init.body);
      const patched = injectRuntimeAwareness(parsed);
      init = { ...init, body: JSON.stringify(patched) };
    }
  } catch (error) {
    console.warn("runtime awareness injection skipped:", error?.message || error);
  }
  return originalFetch(input, init);
};

async function sendRealBarkTest() {
  const key = String(process.env.BARK_KEY || "").trim();
  if (!key) return { ok: false, status: 500, error: "BARK_KEY 未配置" };

  const payload = {
    title: "Heartbeat 测试",
    body: "如果你看到这条，Dylan Heartbeat → Bark → iPhone 已连通。",
    device_key: key
  };
  const icon = String(process.env.CUSTOM_ICON_URL || "").trim();
  if (icon) payload.icon = icon;

  try {
    const response = await originalFetch("https://api.day.app/push", {
      method: "POST",
      signal: AbortSignal.timeout(Number(process.env.PUSH_TIMEOUT_MS) || 15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let result = {};
    try { result = JSON.parse(text); } catch {}

    if (!response.ok || (result.code && result.code !== 200)) {
      return {
        ok: false,
        status: 502,
        error: result.message || text || `Bark HTTP ${response.status}`
      };
    }
    return { ok: true, status: 200 };
  } catch (error) {
    return { ok: false, status: 502, error: error?.message || String(error) };
  }
}

// Monkey-patch Fastify factory before loading server.js. We only replace the handlers
// for the two existing test routes, keeping their original Basic Auth preHandler/options.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "fastify") {
    return function patchedFastify(...args) {
      const app = Fastify(...args);
      const originalGet = app.get.bind(app);
      app.get = function patchedGet(path, options, handler) {
        if (path === "/test-bark" || path === "/admin/test-bark") {
          const hasOptions = typeof options === "object" && options !== null;
          const routeOptions = hasOptions ? options : {};
          const realHandler = async (_req, reply) => {
            const result = await sendRealBarkTest();
            if (!result.ok) return reply.code(result.status).send({ success: false, error: result.error });
            return reply.send({ success: true, pushed: true });
          };
          return originalGet(path, routeOptions, realHandler);
        }
        return originalGet(path, options, handler);
      };
      return app;
    };
  }
  return originalLoad(request, parent, isMain);
};

require("./server.js");
