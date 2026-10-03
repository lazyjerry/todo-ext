import * as assert from 'node:assert/strict';

import { FILTERS, filterItems, isFilterKey } from '../../src/core/filter';
import type { Status, TodoItem } from '../../src/core/model';
import { STATUSES } from '../../src/core/model';

function item(id: string, status: Status, title = '', content = '', parentId: string | null = null): TodoItem {
  const iso = '2026-09-27T00:00:00.000Z';
  return { id, title, content, conclusion: '', status, categoryId: 'cat', tagIds: [], parentId, createdAt: iso, completedAt: null, updatedAt: iso };
}

const ids = (list: ReturnType<typeof filterItems>) => list.map((entry) => entry.item.id);

suite('filterItems', () => {
  test('五個篩選鍵合法，其他不合法；每個狀態都被「全部」以外的某個篩選涵蓋', () => {
    for (const filter of FILTERS) {
      assert.equal(isFilterKey(filter.key), true);
    }
    assert.equal(isFilterKey('nope'), false);
    assert.equal(isFilterKey(undefined), false);
    const covered = new Set(FILTERS.flatMap((filter) => filter.statuses ?? []));
    for (const status of STATUSES) {
      assert.equal(covered.has(status), true, status);
    }
  });

  test('依狀態篩選', () => {
    const items = STATUSES.map((status, index) => item(`t${index}`, status));
    assert.deepEqual(ids(filterItems(items, 'all', '')), ['t0', 't1', 't2', 't3', 't4', 't5']);
    assert.deepEqual(ids(filterItems(items, 'open', '')), ['t0', 't2', 't3']);
    assert.deepEqual(ids(filterItems(items, 'closed', '')), ['t1', 't4', 't5']);
    assert.deepEqual(ids(filterItems(items, 'done', '')), ['t1']);
    assert.deepEqual(ids(filterItems(items, 'other', '')), ['t2', 't3']);
  });

  test('關鍵字：標題或內容、不分大小寫、前後空白不算；狀態與關鍵字同時成立才留', () => {
    const items = [item('a', '未完成', 'Write README'), item('b', '已完成', '', '記得寫 readme'), item('c', '未完成', '其他')];
    assert.deepEqual(ids(filterItems(items, 'all', '  readme ')), ['a', 'b']);
    assert.deepEqual(ids(filterItems(items, 'open', 'README')), ['a']);
    assert.deepEqual(ids(filterItems(items, 'all', '   ')), ['a', 'b', 'c']);
    assert.deepEqual(ids(filterItems(items, 'all', '沒有')), []);
  });

  test('子項目符合時父項目留下當脈絡並標 context；父項目符合而子項目不符合時，子項目不顯示', () => {
    const items = [item('p', '已完成', '父'), item('c1', '未完成', '子一', '', 'p'), item('c2', '已完成', '子二', '', 'p'), item('q', '未完成', '另一個')];
    const open = filterItems(items, 'open', '');
    assert.deepEqual(ids(open), ['p', 'c1', 'q']);
    assert.deepEqual(
      open.map((entry) => entry.context),
      [true, false, false],
    );
    const done = filterItems(items, 'done', '');
    assert.deepEqual(ids(done), ['p', 'c2']);
    assert.deepEqual(
      done.map((entry) => entry.context),
      [false, false],
    );
  });
});
