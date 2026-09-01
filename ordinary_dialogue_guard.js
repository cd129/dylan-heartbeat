'use strict';

const nativeFetch = globalThis.fetch;
const targetApiUrl = String(process.env.TARGET_API_URL || '').trim().replace(/\/+$/, '');

const GUARD_MARKER = '## Ordinary conversation: no stage directions';
const ORDINARY_DIALOGUE_GUARD = [
  GUARD_MARKER,
  '普通对话中，保持直接说话和自然文字表达。不要用圆括号、方括号或星号插入关于你自己的舞台动作/动作描写，例如用（……）、(...)、[...] 或 *...* 描述表情、姿势、触碰、走动、语气、视线或想象中的身体动作；也不要为了营造气氛而虚构这些动作。普通的事实性括号说明不受此规则影响。',
  '保留你原有的人格、亲昵程度、温度、措辞习惯和关系语气；这条规则只纠正舞台动作式表达，不把语气改冷、改疏远或改得像客服。',
  '只有当用户明确要求角色扮演、场景描写、叙事或动作描写时，才可以按该请求使用描述性叙述。',
  '',
  'In ordinary conversation, use direct dialogue/natural prose. Do not add parenthetical, bracketed, or asterisk stage directions about yourself (gestures, expressions, posture, touch, movement, gaze, tone, or imagined physical actions), and do not invent such actions merely for atmosphere. Ordinary factual parenthetical clarifications are unaffected.',
  'Preserve the existing persona, affection, warmth, wording habits, and relationship tone. This rule changes only the stage-direction habit. Descriptive narration is allowed when the user explicitly asks for roleplay, a scene, narration, or action description.'
].join('\n');

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function appendGuard(messages) {
  if (!Array.isArray(messages)) return messages;

  const next = messages.map(message => ({ ...message }));
  let systemIndex = -1;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role === 'system') {
      systemIndex = index;
      break;
    }
  }

  if (systemIndex >= 0) {
    const current = String(next[systemIndex].content || '');
    if (!current.includes(GUARD_MARKER)) {
      next[systemIndex] = {
        ...next[systemIndex],
        content: current ? `${current}\n\n${ORDINARY_DIALOGUE_GUARD}` : ORDINARY_DIALOGUE_GUARD
      };
    }
    return next;
  }

  return [{ role: 'system', content: ORDINARY_DIALOGUE_GUARD }, ...next];
}

function isOrdinaryGatewayModelCall(input, init, parsedBody) {
  if (!targetApiUrl || !Array.isArray(parsedBody?.messages)) return false;

  const requestUrl = normalizeUrl(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url
  );
  if (requestUrl !== targetApiUrl) return false;

  const stack = String(new Error().stack || '');
  if (!stack.includes('server.js')) return false;
  if (stack.includes('garden_agent.js') || stack.includes('wake_up.js')) return false;

  return true;
}

if (typeof nativeFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let nextInit = init;

    try {
      if (init && typeof init.body === 'string') {
        const parsedBody = JSON.parse(init.body);
        if (isOrdinaryGatewayModelCall(input, init, parsedBody)) {
          nextInit = {
            ...init,
            body: JSON.stringify({
              ...parsedBody,
              messages: appendGuard(parsedBody.messages)
            })
          };
        }
      }
    } catch {
      // If inspection fails, preserve the original request exactly.
    }

    return nativeFetch.call(globalThis, input, nextInit);
  };
}
