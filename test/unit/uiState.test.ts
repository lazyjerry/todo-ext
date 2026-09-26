import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { UiStateStore } from '../../src/core/store';
import { DEFAULT_VIEW, isViewState, parseUiState, QUERY_MAX, viewOf } from '../../src/core/uiState';

suite('uiState', () => {
  test('parseUiState：不是物件整份預設；認不得的欄位退回預設、關鍵字截到上限', () => {
    assert.deepEqual(parseUiState(null), { ...DEFAULT_VIEW, collectionId: null, updatedAt: '' });
    assert.deepEqual(parseUiState('x'), { ...DEFAULT_VIEW, collectionId: null, updatedAt: '' });
    const parsed = parseUiState({
      collectionId: 'col_1',
      itemId: 'todo_1',
      filter: 'open',
      query: 'x'.repeat(QUERY_MAX + 5),
      expanded: true,
      updatedAt: '2026-09-27T00:00:00.000Z',
    });
    assert.deepEqual(parsed, {
      collectionId: 'col_1',
      itemId: 'todo_1',
      filter: 'open',
      query: 'x'.repeat(QUERY_MAX),
      expanded: true,
      updatedAt: '2026-09-27T00:00:00.000Z',
    });
    const messy = parseUiState({ collectionId: 7, itemId: {}, filter: 'nope', query: 3, expanded: 'yes', updatedAt: 1 });
    assert.deepEqual(messy, { ...DEFAULT_VIEW, collectionId: null, updatedAt: '' });
  });

  test('isViewState 逐欄檢查；viewOf 只留 webview 那部分', () => {
    const view = { itemId: null, filter: 'all', query: '', expanded: false };
    assert.equal(isViewState(view), true);
    assert.equal(isViewState({ ...view, itemId: 'todo_1', filter: 'done', expanded: true }), true);
    for (const bad of [
      null,
      {},
      { ...view, itemId: undefined },
      { ...view, itemId: 1 },
      { ...view, filter: 'nope' },
      { ...view, query: 'x'.repeat(QUERY_MAX + 1) },
      { ...view, expanded: 'true' },
    ]) {
      assert.equal(isViewState(bad), false, JSON.stringify(bad));
    }
    assert.deepEqual(viewOf({ ...view, filter: 'all', collectionId: 'c', updatedAt: 't' }), view);
  });
});

suite('UiStateStore', () => {
  let dir: string;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'todooo-ui-'));
  });

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('write 後 read 讀得回來；檔案不存在或壞掉都回 undefined', async () => {
    const store = new UiStateStore(path.join(dir, 'nested', 'ui-state.json'));
    assert.equal(await store.read(), undefined);
    const state = { ...DEFAULT_VIEW, collectionId: 'col_1', itemId: 'todo_1', query: 'abc', updatedAt: '2026-09-27T00:00:00.000Z' };
    await store.write(state);
    assert.deepEqual(await store.read(), state);
    assert.deepEqual((await fs.readdir(path.dirname(store.file))).sort(), ['ui-state.json']);
    await fs.writeFile(store.file, '{ broken', 'utf8');
    assert.equal(await store.read(), undefined);
  });
});
