'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StageDirectionChunkFilter,
  stripStageDirections,
  rewriteJsonResponseText,
  explicitlyRequestsNarration
} = require('./ordinary_stage_filter');

test('removes standalone self stage directions while preserving dialogue', () => {
  const input = '（顺势把下巴搁在你的手心，任由你把我的白头发揉得乱糟糟的，紫绿色的眼睛微微睁大，有些错愕地看着你）\n\n等等，27号就解决了？\n\n（忍不住轻轻咬了一下你的指尖，故意装出一副委屈又好气好笑的样子）\n\n那我今天下午一直守在屏幕这边。';
  const result = stripStageDirections(input);
  assert.equal(result.removedBlocks, 2);
  assert.equal(result.text, '等等，27号就解决了？\n\n那我今天下午一直守在屏幕这边。');
});

test('keeps ordinary factual parentheses', () => {
  const input = '他25号回信（也就是两天前），这个结构已经很清楚。AP（Advanced Placement）也一样。';
  const result = stripStageDirections(input);
  assert.equal(result.removedBlocks, 0);
  assert.equal(result.text, input);
});

test('detects a stage direction split across streamed chunks', () => {
  const filter = new StageDirectionChunkFilter();
  const first = filter.process('（顺势把下巴搁在你的');
  const second = filter.process('手心，轻轻看着你）等等，');
  const third = filter.process('我知道了。') + filter.flush();
  assert.equal(first, '');
  assert.equal(second, '等等，');
  assert.equal(third, '我知道了。');
  assert.equal(filter.removedBlocks, 1);
});

test('rewrites non-stream OpenAI JSON assistant content only', () => {
  const payload = JSON.stringify({
    id: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content: '（轻轻抱住你）\n\n好，我知道了。' } }]
  });
  const result = rewriteJsonResponseText(payload);
  const parsed = JSON.parse(result.text);
  assert.equal(result.removedBlocks, 1);
  assert.equal(parsed.choices[0].message.content, '好，我知道了。');
});

test('explicit narration requests bypass the hard filter, but prohibitions do not', () => {
  assert.equal(explicitlyRequestsNarration({ messages: [{ role: 'user', content: '来一段角色扮演，带动作描写。' }] }), true);
  assert.equal(explicitlyRequestsNarration({ messages: [{ role: 'user', content: '别再角色扮演，也不要动作描写。' }] }), false);
  assert.equal(explicitlyRequestsNarration({ messages: [{ role: 'user', content: '我们正常聊这个就好。' }] }), false);
});
