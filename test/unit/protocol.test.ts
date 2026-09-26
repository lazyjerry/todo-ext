import * as assert from 'node:assert/strict';

import { createId, isSafeIdSegment } from '../../src/core/ids';
import { clampRatio, isClientMessage, RATIO_DEFAULT, RATIO_MAX, RATIO_MIN } from '../../src/shared/protocol';

suite('ids', () => {
  test('createId 產生的 id 通過 isSafeIdSegment', () => {
    for (const prefix of ['col', 'cat', 'tag', 'todo']) {
      assert.equal(isSafeIdSegment(createId(prefix)), true);
    }
  });

  test('路徑穿越與奇怪的字串都擋掉', () => {
    for (const bad of ['../x', 'col_../..', 'col_0000000000000001/..', 'col_00000000000000GG', '', 42, null, 'col_0000000000000001.json']) {
      assert.equal(isSafeIdSegment(bad), false, String(bad));
    }
  });
});

suite('isClientMessage', () => {
  test('合法訊息', () => {
    const ok: unknown[] = [
      { type: 'ready' },
      { type: 'createCollection' },
      { type: 'createItem' },
      { type: 'selectCollection', id: 'x' },
      { type: 'updateItem', id: 'x', patch: {} },
      { type: 'updateItem', id: 'x', patch: { title: 'a', content: 'b', status: '已完成', categoryId: 'c', tagIds: ['t'], createdAt: 'd' } },
      { type: 'createCategory', name: 'x' },
      { type: 'renameCategory', id: 'x', name: 'y' },
      { type: 'createTag', name: 'x', color: 'red' },
      { type: 'updateTag', id: 'x' },
      { type: 'updateTag', id: 'x', color: 'blue' },
      { type: 'setRatio', ratio: 0.5 },
      { type: 'createItem', parentId: 'p' },
      { type: 'moveItem', id: 'x', parentId: null, index: 0 },
      { type: 'moveItem', id: 'x', parentId: 'p', index: 3 },
      { type: 'setCollectionFolder', id: 'c' },
    ];
    for (const message of ok) {
      assert.equal(isClientMessage(message), true, JSON.stringify(message));
    }
  });

  test('moveItem 的 index 必須是非負整數、parentId 只能是字串或 null', () => {
    const bad: unknown[] = [
      { type: 'moveItem', id: 'x', parentId: null, index: -1 },
      { type: 'moveItem', id: 'x', parentId: null, index: 1.5 },
      { type: 'moveItem', id: 'x', parentId: null, index: '0' },
      { type: 'moveItem', id: 'x', parentId: undefined, index: 0 },
      { type: 'moveItem', id: 'x', parentId: 7, index: 0 },
      { type: 'createItem', parentId: 7 },
      { type: 'setCollectionFolder' },
    ];
    for (const message of bad) {
      assert.equal(isClientMessage(message), false, JSON.stringify(message));
    }
  });

  test('型別不對、未知指令、patch 帶多餘欄位都拒絕', () => {
    const bad: unknown[] = [
      null,
      'ready',
      { type: 'nuke' },
      { type: 'selectCollection' },
      { type: 'updateItem', id: 'x' },
      { type: 'updateItem', id: 'x', patch: { id: 'y' } },
      { type: 'updateItem', id: 'x', patch: { completedAt: 'now' } },
      { type: 'updateItem', id: 'x', patch: { status: '亂' } },
      { type: 'updateItem', id: 'x', patch: { tagIds: [1] } },
      { type: 'createTag', name: 'x', color: 'neon' },
      { type: 'setRatio', ratio: Number.NaN },
      { type: 'setRatio', ratio: '0.5' },
    ];
    for (const message of bad) {
      assert.equal(isClientMessage(message), false, JSON.stringify(message));
    }
  });
});

suite('clampRatio', () => {
  test('限制在範圍內並取到小數第二位；非數字退回預設', () => {
    assert.equal(clampRatio(0.6), 0.6);
    assert.equal(clampRatio(0.123), 0.2);
    assert.equal(clampRatio(0.999), RATIO_MAX);
    assert.equal(clampRatio(-1), RATIO_MIN);
    assert.equal(clampRatio(0.456), 0.46);
    assert.equal(clampRatio('x'), RATIO_DEFAULT);
    assert.equal(clampRatio(undefined), RATIO_DEFAULT);
  });
});
