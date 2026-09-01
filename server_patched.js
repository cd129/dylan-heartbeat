// Runtime patch for Dylan Heartbeat on Railway.
// Keeps upstream source changes minimal while fixing deployment-level issues:
// 1) ordinary Kelivo/Aru chats know the Bark capability boundary without ever seeing the key;
// 2) timestamp-less Aru turns are stamped at gateway receipt so wake-up recency stays correct;
// 3) /admin/test-bark actually sends a Bark push instead of only writing a fake timeline event;
// 4) a secret-protected Garden wake endpoint can trigger the existing model/push/timeline runtime.

const Fastify = require("fastify");
const originalFetch = global.fetch;
const { safeSecretEqual } = require("./garden_auth");
const { enqueueGardenWake } = require("./garden_runtime");
const { stampLatestUserMessage } = require("./gateway_chat_timestamp");
const { formatDateTimeInTimeZone, resolveTimeZone } = require("./time_utils");
const {
  wrapOrdinaryChatResponse,
  explicitlyRequestsNarration
} = require("./ordinary_stage_filter");

const TIME_ZONE = resolveTimeZone();

const RUNTIME_AWARENESS = `

## Dylan Heartbeat 运行环境说明
- 你通过 Dylan Heartbeat 获得“后台自主唤醒后向用户发送 Bark 推送”的能力。
- Bark Device Key 由服务器安全保管，你看不到、也不需要知道它；不要向用户索要 Bark Key、Device Key 或 Bark 专属链接。
- 普通聊天回复本身不能直接触发 Bark 推送。只有后台自动唤醒流程会根据你的输出决定是否推送，并由服务器代为发送。
- 如果用户在普通聊天里要求“现在给 Bark 发一条测试消息”，请如实说明普通聊天不能直接触发推送；不要假装已经发送。

## 普通对话表达规则
- 普通对话中保持直接说话和自然文字表达，不要用圆括号、方括号或星号插入关于你自己的舞台动作/动作描写，例如用（……）、(...)、[...] 或 *...* 描述表情、姿势、触碰、走动、视线、语气或想象中的身体动作；也不要为了营造气氛而虚构这些动作。
- 普通的事实性括号说明不受此规则影响。
- 保留原有的人格、亲昵程度、温度、措辞习惯和关系语气；这条规则只纠正舞台动作式表达，不把语气改冷、改疏远或改得像客服。
- 只有当用户明确要求角色扮演、场景描写、叙事或动作描写时，才可以按该请求使用描述性叙述。`;

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

function isOrdinaryGatewayModelCall() {
  const stack = String(new Error().stack || "");
  return stack.includes("server.js") &&
    !stack.includes("garden_agent.js") &&
    !stack.includes("garden_runtime.js") &&
    !stack.includes("wake_up.js");
}

function stampCurrentChatTurn(req) {
  if (!req || req.method !== "POST") return false;
  const path = String(req.url || "").split("?", 1)[0];
  if (path !== "/v1/chat/completions") return false;
  const body = req.body;
  if (!body || !Array.isArray(body.messages)) return false;

  const timestamp = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  const stamped = stampLatestUserMessage(body, timestamp);
  if (stamped === body) return false;
  req.body = stamped;
  return true;
}

// Patch fetch only inside the gateway process. wake_up.js still runs as its own process,
// so its autonomous wake prompt and Bark delivery path are unchanged.
global.fetch = async function patchedFetch(input, init = {}) {
  let shouldHardFilterOrdinaryOutput = false;

  try {
    const target = String(process.env.TARGET_API_URL || "");
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");

    if (target && url === target && String(init.method || "GET").toUpperCase() === "POST" && typeof init.body === "string") {
      const parsed = JSON.parse(init.body);
      const ordinaryGatewayCall = isOrdinaryGatewayModelCall();
      shouldHardFilterOrdinaryOutput = ordinaryGatewayCall && !explicitlyRequestsNarration(parsed);
      const patched = injectRuntimeAwareness(parsed);
      init = { ...init, body: JSON.stringify(patched) };
    }
  } catch (error) {
    console.warn("runtime awareness injection skipped:", error?.message || error);
  }

  const response = await originalFetch(input, init);
  if (!shouldHardFilterOrdinaryOutput) return response;

  try {
    return await wrapOrdinaryChatResponse(response, removedBlocks => {
      console.log(JSON.stringify({
        event: "ordinary_stage_directions_filtered",
        removed_blocks: removedBlocks
      }));
    });
  } catch (error) {
    console.warn("ordinary stage-direction output filter skipped:", error?.message || error);
    return response;
  }
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

async function handleGardenWakeRequest(req, reply) {
  const expected = String(process.env.GARDEN_WAKE_SHARED_SECRET || "").trim();
  const supplied = String(req.headers["x-garden-wake-secret"] || "");

  if (!expected) {
    return reply.code(503).send({
      success: false,
      error: "Garden wake endpoint is not configured"
    });
  }
  if (!safeSecretEqual(expected, supplied)) {
    return reply.code(401).send({ success: false, error: "unauthorized" });
  }

  try {
    const result = await enqueueGardenWake(req.body);
    return reply.send({
      success: true,
      action: result.action,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(typeof result.timelineRecorded === "boolean"
        ? { timeline_recorded: result.timelineRecorded }
        : {})
    });
  } catch (error) {
    const message = String(error?.message || "");
    const validationFailure =
      message.startsWith("invalid Garden") ||
      message.startsWith("unsupported Garden");
    console.error("Garden wake request failed", {
      name: error?.name || "Error",
      message: validationFailure ? "invalid Garden wake payload" : message
    });
    return reply.code(validationFailure ? 400 : 502).send({
      success: false,
      error: validationFailure ? "invalid Garden wake payload" : "Garden wake processing failed"
    });
  }
}

// Monkey-patch Fastify factory before loading server.js. We only replace the handlers
// for the two existing test routes, add a timestamp bridge for public chat requests,
// and register one isolated Garden endpoint.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "fastify") {
    return function patchedFastify(...args) {
      const app = Fastify(...args);
      const originalGet = app.get.bind(app);

      app.addHook("preHandler", async req => {
        try {
          if (stampCurrentChatTurn(req)) {
            console.log(JSON.stringify({
              event: "gateway_latest_user_timestamp_injected",
              time_zone: TIME_ZONE
            }));
          }
        } catch (error) {
          console.warn("gateway chat timestamp injection skipped", {
            name: error?.name || "Error",
            message: String(error?.message || error).slice(0, 160)
          });
        }
      });

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

      app.post("/internal/garden-wake", handleGardenWakeRequest);
      return app;
    };
  }
  return originalLoad(request, parent, isMain);
};

require("./server.js");
