'use strict';

const OPENERS = new Map([
  ['（', '）'],
  ['(', ')'],
  ['[', ']']
]);

const SELF_ANCHOR_RE = /(我|我的|我自己|自己)/;
const SECOND_PERSON_RE = /(你|你的|姐姐|宝宝|宝贝)/;
const ACTION_HINT_RE = /(顺势|任由|忍不住|故意|轻轻|慢慢|悄悄|微微|抬|低|歪|偏|转|靠|贴|凑|抱|搂|蹭|摸|揉|捏|握|抓|牵|拉|推|咬|亲|吻|舔|看着|望着|盯着|看向|瞥|眨|睁|闭|皱眉|挑眉|笑|哭|叹|哼|点头|摇头|缩|伸手|抬手|放手|走|坐|站|躺|跪|装出|摆出)/g;
const DIRECTED_ACTION_RE = /(抱|搂|蹭|摸|揉|捏|握|抓|牵|拉|推|咬|亲|吻|舔|看着|望着|盯着|看向|靠近|贴近|凑近).{0,10}(你|你的|姐姐|宝宝|宝贝)/;

function countActionHints(text) {
  const matches = String(text || '').match(ACTION_HINT_RE);
  return matches ? matches.length : 0;
}

function looksLikeStageDirection(candidate) {
  const text = String(candidate || '').trim();
  if (text.length < 3 || text.length > 1200) return false;

  const opener = text[0];
  const closer = OPENERS.get(opener);
  const hasExpectedCloser = closer && text.endsWith(closer);
  const inner = hasExpectedCloser ? text.slice(1, -1).trim() : text.slice(1).trim();
  if (!inner) return false;

  const actions = countActionHints(inner);
  if (actions === 0) return false;
  if (SELF_ANCHOR_RE.test(inner)) return true;
  if (DIRECTED_ACTION_RE.test(inner)) return true;
  return SECOND_PERSON_RE.test(inner) && actions >= 2;
}

class StageDirectionChunkFilter {
  constructor() {
    this.pending = '';
    this.closer = '';
    this.removedBlocks = 0;
  }

  process(text) {
    const input = String(text ?? '');
    let output = '';

    for (const ch of input) {
      if (this.pending) {
        this.pending += ch;

        if (ch === this.closer) {
          const candidate = this.pending;
          if (looksLikeStageDirection(candidate)) {
            this.removedBlocks += 1;
          } else {
            output += candidate;
          }
          this.pending = '';
          this.closer = '';
          continue;
        }

        if (this.pending.length > 1200) {
          output += this.pending;
          this.pending = '';
          this.closer = '';
        }
        continue;
      }

      const closer = OPENERS.get(ch);
      if (closer) {
        this.pending = ch;
        this.closer = closer;
      } else {
        output += ch;
      }
    }

    return output;
  }

  flush() {
    if (!this.pending) return '';
    const candidate = this.pending;
    this.pending = '';
    this.closer = '';

    if (looksLikeStageDirection(candidate)) {
      this.removedBlocks += 1;
      return '';
    }
    return candidate;
  }
}

function stripStageDirections(text) {
  const filter = new StageDirectionChunkFilter();
  const output = filter.process(text) + filter.flush();
  return {
    text: output.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(),
    removedBlocks: filter.removedBlocks
  };
}

function rewriteJsonResponseText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, removedBlocks: 0 };
  }

  let removedBlocks = 0;
  for (const choice of Array.isArray(parsed?.choices) ? parsed.choices : []) {
    if (typeof choice?.message?.content !== 'string') continue;
    const cleaned = stripStageDirections(choice.message.content);
    choice.message.content = cleaned.text;
    removedBlocks += cleaned.removedBlocks;
  }

  return { text: JSON.stringify(parsed), removedBlocks };
}

function createSseFilterTransform(onFiltered) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = '';
  const filters = new Map();
  let removedBlocks = 0;

  function filterFor(index) {
    if (!filters.has(index)) filters.set(index, new StageDirectionChunkFilter());
    return filters.get(index);
  }

  function syntheticFlushLines() {
    const lines = [];
    for (const [index, filter] of filters.entries()) {
      const tail = filter.flush();
      removedBlocks += filter.removedBlocks;
      filter.removedBlocks = 0;
      if (!tail) continue;
      lines.push(`data: ${JSON.stringify({ choices: [{ index, delta: { content: tail } }] })}\n\n`);
    }
    return lines.join('');
  }

  function processLine(line) {
    if (!line.startsWith('data:')) return `${line}\n`;
    const payload = line.slice(5).trimStart();

    if (payload === '[DONE]') return syntheticFlushLines() + `${line}\n`;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return `${line}\n`;
    }

    for (const choice of Array.isArray(parsed?.choices) ? parsed.choices : []) {
      const index = Number.isInteger(choice?.index) ? choice.index : 0;
      if (typeof choice?.delta?.content !== 'string') continue;
      const filter = filterFor(index);
      choice.delta.content = filter.process(choice.delta.content);
      if (filter.removedBlocks) {
        removedBlocks += filter.removedBlocks;
        filter.removedBlocks = 0;
      }
    }

    return `data: ${JSON.stringify(parsed)}\n`;
  }

  return new TransformStream({
    transform(chunk, controller) {
      lineBuffer += decoder.decode(chunk, { stream: true });
      let newlineIndex;
      while ((newlineIndex = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        controller.enqueue(encoder.encode(processLine(line)));
      }
    },
    flush(controller) {
      lineBuffer += decoder.decode();
      if (lineBuffer) controller.enqueue(encoder.encode(processLine(lineBuffer.replace(/\r$/, ''))));
      const tail = syntheticFlushLines();
      if (tail) controller.enqueue(encoder.encode(tail));
      if (removedBlocks > 0 && typeof onFiltered === 'function') onFiltered(removedBlocks);
    }
  });
}

async function wrapOrdinaryChatResponse(response, onFiltered) {
  if (!response || typeof Response !== 'function') return response;
  const contentType = response.headers?.get?.('content-type') || '';

  if (contentType.includes('text/event-stream') && response.body && typeof TransformStream === 'function') {
    return new Response(response.body.pipeThrough(createSseFilterTransform(onFiltered)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  if (contentType.includes('application/json')) {
    const text = await response.text();
    const rewritten = rewriteJsonResponseText(text);
    if (rewritten.removedBlocks > 0 && typeof onFiltered === 'function') onFiltered(rewritten.removedBlocks);
    return new Response(rewritten.text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  return response;
}

function latestUserText(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue;
    const content = messages[i]?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => typeof part === 'string' ? part : String(part?.text || '')).join('\n');
    }
    return String(content || '');
  }
  return '';
}

function explicitlyRequestsNarration(payload) {
  const text = latestUserText(payload);
  if (!text) return false;
  if (/(不要|别|禁止|停止|不准|别再).{0,10}(角色扮演|role\s*-?\s*play|动作描写|场景描写|舞台动作|括号动作)/i.test(text)) return false;
  return /(?:请|来|开始|继续|进行|帮我|给我|写|演|扮演|模拟).{0,16}(?:角色扮演|role\s*-?\s*play|动作描写|场景描写|叙事|小说场景|情景演绎)|(?:用|加|带).{0,8}(?:括号动作|动作描写|舞台动作)/i.test(text);
}

module.exports = {
  StageDirectionChunkFilter,
  looksLikeStageDirection,
  stripStageDirections,
  rewriteJsonResponseText,
  wrapOrdinaryChatResponse,
  explicitlyRequestsNarration
};
