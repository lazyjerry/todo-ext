import * as assert from 'node:assert/strict';

import type { Collection } from '../../src/core/model';
import {
  addCategory,
  addTag,
  applyItemPatch,
  canonicalOrder,
  CONCLUSION_MAX,
  createCollection,
  createItem,
  DEFAULT_CATEGORY_NAME,
  formatDate,
  moveItem,
  parseCollection,
  removeCategory,
  removeItem,
  removeTag,
  renameCategory,
  TITLE_MAX,
  updateTag,
  withItem,
} from '../../src/core/model';

const T0 = new Date('2026-09-26T01:02:03.000Z');
const T1 = new Date('2026-09-26T02:00:00.000Z');
const T2 = new Date('2026-09-26T03:00:00.000Z');

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${String(++counter).padStart(16, '0')}`;

function fixture() {
  const collection = createCollection('col_0000000000000001', 'cat_0000000000000001', ' 工作 ', T0);
  const item = createItem('todo_0000000000000001', collection, T0);
  return { collection: withItem(collection, item, T0), item };
}

suite('createCollection', () => {
  test('名稱去頭尾空白、大標題預設當天日期、預設分類是未分類', () => {
    const { collection } = fixture();
    assert.equal(collection.name, '工作');
    assert.equal(collection.title, formatDate(T0));
    assert.deepEqual(
      collection.categories.map((category) => category.name),
      [DEFAULT_CATEGORY_NAME],
    );
    assert.equal(collection.tags.length, 0);
  });

  test('空名稱退回「預設」', () => {
    assert.equal(createCollection('col_0000000000000002', 'cat_0000000000000002', '   ', T0).name, '預設');
  });
});

suite('createItem 與 applyItemPatch', () => {
  test('新項目：未完成、掛未分類、創建時間含時分秒、沒有完成時間', () => {
    const { collection, item } = fixture();
    assert.equal(item.status, '未完成');
    assert.equal(item.categoryId, collection.categories[0].id);
    assert.equal(item.createdAt, T0.toISOString());
    assert.equal(item.completedAt, null);
  });

  test('標題截到 120 字並去掉換行', () => {
    const { collection, item } = fixture();
    const long = 'a'.repeat(200);
    const patched = applyItemPatch(collection, item, { title: `  x\ny${long}` }, T1);
    assert.equal(patched.title.length, TITLE_MAX);
    assert.equal(patched.title.startsWith('x y'), true);
  });

  test('結論截到 512 字並去掉換行；切回未結束的狀態仍保留', () => {
    const { collection, item } = fixture();
    assert.equal(item.conclusion, '');
    const long = 'a'.repeat(600);
    const closed = applyItemPatch(collection, item, { status: '擱置', conclusion: `  x\ny${long}` }, T1);
    assert.equal(closed.conclusion.length, CONCLUSION_MAX);
    assert.equal(closed.conclusion.startsWith('x y'), true);
    const reopened = applyItemPatch(collection, closed, { status: '未完成' }, T2);
    assert.equal(reopened.conclusion, closed.conclusion);
  });

  test('切成已完成或失敗記下完成時間；切回其他狀態清掉；兩者互切保留', () => {
    const { collection, item } = fixture();
    const done = applyItemPatch(collection, item, { status: '已完成' }, T1);
    assert.equal(done.completedAt, T1.toISOString());

    const failed = applyItemPatch(collection, done, { status: '失敗' }, T2);
    assert.equal(failed.completedAt, T1.toISOString(), '已完成 → 失敗 保留原本的完成時間');

    const reopened = applyItemPatch(collection, failed, { status: '待測試' }, T2);
    assert.equal(reopened.completedAt, null);

    const failedAgain = applyItemPatch(collection, reopened, { status: '失敗' }, T2);
    assert.equal(failedAgain.completedAt, T2.toISOString());
  });

  test('不合法的狀態、分類、標籤、時間都保留原值', () => {
    const { collection, item } = fixture();
    const patched = applyItemPatch(
      collection,
      item,
      { status: '亂七八糟' as never, categoryId: 'cat_nope', tagIds: ['tag_nope'], createdAt: 'not a date' },
      T1,
    );
    assert.equal(patched.status, item.status);
    assert.equal(patched.categoryId, item.categoryId);
    assert.deepEqual(patched.tagIds, []);
    assert.equal(patched.createdAt, item.createdAt);
    assert.equal(patched.updatedAt, T1.toISOString());
  });

  test('withItem 新項目插到最前面，既有項目原地替換', () => {
    const { collection, item } = fixture();
    const second = createItem('todo_0000000000000002', collection, T1);
    const next = withItem(collection, second, T1);
    assert.deepEqual(
      next.items.map((entry) => entry.id),
      [second.id, item.id],
    );
    const replaced = withItem(next, { ...item, title: '改了' }, T2);
    assert.equal(replaced.items[1].title, '改了');
    assert.equal(replaced.items.length, 2);
  });
});

/** 三個頂層 A、B、C，A 底下兩個子項目 a1、a2。陣列順序：A a1 a2 B C。 */
function tree(): Collection {
  let collection = createCollection('col_0000000000000001', 'cat_0000000000000001', '工作', T0);
  for (const id of ['C', 'B', 'A']) {
    collection = withItem(collection, { ...createItem(`todo_${id}`, collection, T0), title: id }, T0);
  }
  for (const id of ['a1', 'a2']) {
    collection = withItem(collection, { ...createItem(`todo_${id}`, collection, T0, 'todo_A'), title: id }, T0);
  }
  return collection;
}

const ids = (collection: Collection) => collection.items.map((item) => item.id.slice('todo_'.length));

suite('順序與父子', () => {
  test('陣列順序就是畫面順序：頂層新項目在最前面，子項目接在父項目既有子項目後面', () => {
    const collection = tree();
    assert.deepEqual(ids(collection), ['A', 'a1', 'a2', 'B', 'C']);
    assert.equal(collection.items[1].parentId, 'todo_A');
  });

  test('createItem 的 parentId 指向子項目或不存在的項目時退回頂層', () => {
    const collection = tree();
    assert.equal(createItem('todo_x', collection, T1, 'todo_a1').parentId, null);
    assert.equal(createItem('todo_x', collection, T1, 'todo_ghost').parentId, null);
  });

  test('頂層重排：父項目搬動時子項目跟著走', () => {
    const moved = moveItem(tree(), 'todo_A', null, 1, T1)!;
    assert.deepEqual(ids(moved), ['B', 'A', 'a1', 'a2', 'C']);
    assert.equal(moved.items[1].updatedAt, T0.toISOString(), '純換順序不動項目的 updatedAt');
    assert.deepEqual(ids(moveItem(tree(), 'todo_A', null, 99, T1)!), ['B', 'C', 'A', 'a1', 'a2'], 'index 超過就放最後');
  });

  test('子項目搬到頂層變成父項目；頂層項目搬進別人底下變成子項目', () => {
    const promoted = moveItem(tree(), 'todo_a1', null, 0, T1)!;
    assert.deepEqual(ids(promoted), ['a1', 'A', 'a2', 'B', 'C']);
    assert.equal(promoted.items[0].parentId, null);
    assert.equal(promoted.items[0].updatedAt, T1.toISOString());

    const nested = moveItem(tree(), 'todo_C', 'todo_B', 0, T1)!;
    assert.deepEqual(ids(nested), ['A', 'a1', 'a2', 'B', 'C']);
    assert.equal(nested.items[4].parentId, 'todo_B');
  });

  test('同一個父項目底下換順序、換到另一個父項目底下', () => {
    assert.deepEqual(ids(moveItem(tree(), 'todo_a2', 'todo_A', 0, T1)!), ['A', 'a2', 'a1', 'B', 'C']);
    assert.deepEqual(ids(moveItem(tree(), 'todo_a1', 'todo_B', 0, T1)!), ['A', 'a2', 'B', 'a1', 'C']);
  });

  test('只有兩層：帶著子項目的不能變子項目、子項目不能當父項目、不能搬到自己底下', () => {
    assert.equal(moveItem(tree(), 'todo_A', 'todo_B', 0, T1), undefined);
    assert.equal(moveItem(tree(), 'todo_B', 'todo_a1', 0, T1), undefined);
    assert.equal(moveItem(tree(), 'todo_B', 'todo_B', 0, T1), undefined);
    assert.equal(moveItem(tree(), 'todo_ghost', null, 0, T1), undefined);
  });

  test('刪父項目連子項目一起刪', () => {
    assert.deepEqual(ids(removeItem(tree(), 'todo_A', T1)), ['B', 'C']);
    assert.deepEqual(ids(removeItem(tree(), 'todo_a1', T1)), ['A', 'a2', 'B', 'C']);
  });

  test('canonicalOrder：父項目不存在或疊到第三層的升成頂層', () => {
    const base = tree();
    const orphan = { ...createItem('todo_o', base, T1), parentId: 'todo_ghost' };
    const third = { ...createItem('todo_t', base, T1), parentId: 'todo_a1' };
    const ordered = canonicalOrder([...base.items, orphan, third]);
    assert.deepEqual(
      ordered.map((item) => item.id.slice('todo_'.length)),
      ['A', 'a1', 'a2', 'B', 'C', 'o', 't'],
    );
    assert.equal(ordered.every((item) => item.parentId === null || item.parentId === 'todo_A'), true);
  });

  test('parseCollection 保留父子關係並整理順序', () => {
    const raw = JSON.parse(JSON.stringify(tree()));
    raw.items = [...raw.items].reverse();
    const parsed = parseCollection(raw, nextId)!;
    assert.deepEqual(ids(parsed), ['C', 'B', 'A', 'a2', 'a1']);
    assert.equal(parsed.items[3].parentId, 'todo_A');
  });
});

suite('分類', () => {
  test('新增：空白與重複都拒絕', () => {
    const { collection } = fixture();
    assert.equal(addCategory(collection, 'cat_0000000000000009', '  ', T1), undefined);
    assert.equal(addCategory(collection, 'cat_0000000000000009', DEFAULT_CATEGORY_NAME, T1), undefined);
    const next = addCategory(collection, 'cat_0000000000000009', ' 家務 ', T1)!;
    assert.deepEqual(
      next.categories.map((category) => category.name),
      [DEFAULT_CATEGORY_NAME, '家務'],
    );
  });

  test('重新命名不可撞名', () => {
    const { collection } = fixture();
    const withHome = addCategory(collection, 'cat_0000000000000009', '家務', T1)!;
    assert.equal(renameCategory(withHome, 'cat_0000000000000009', DEFAULT_CATEGORY_NAME, T1), undefined);
    assert.equal(renameCategory(withHome, 'cat_0000000000000009', '雜務', T1)!.categories[1].name, '雜務');
  });

  test('最後一個分類不可刪；刪掉的分類底下的項目改掛未分類', () => {
    const { collection, item } = fixture();
    assert.equal(removeCategory(collection, collection.categories[0].id, T1), undefined);

    const withHome = addCategory(collection, 'cat_0000000000000009', '家務', T1)!;
    const moved = withItem(withHome, applyItemPatch(withHome, item, { categoryId: 'cat_0000000000000009' }, T1), T1);
    assert.equal(moved.items[0].categoryId, 'cat_0000000000000009');

    const removed = removeCategory(moved, 'cat_0000000000000009', T2)!;
    assert.equal(removed.categories.length, 1);
    assert.equal(removed.items[0].categoryId, collection.categories[0].id);
  });
});

suite('標籤', () => {
  test('新增、改色改名、刪除時從項目移除', () => {
    const { collection, item } = fixture();
    const tagged = addTag(collection, 'tag_0000000000000001', '緊急', 'red', T1)!;
    assert.equal(addTag(tagged, 'tag_0000000000000002', '緊急', 'blue', T1), undefined, '同名拒絕');

    const recolored = updateTag(tagged, 'tag_0000000000000001', { color: 'orange', name: '很急' }, T1)!;
    assert.deepEqual(recolored.tags[0], { id: 'tag_0000000000000001', name: '很急', color: 'orange' });
    assert.equal(updateTag(recolored, 'tag_0000000000000001', { name: '' }, T1), undefined);

    const applied = withItem(recolored, applyItemPatch(recolored, item, { tagIds: ['tag_0000000000000001', 'tag_0000000000000001'] }, T1), T1);
    assert.deepEqual(applied.items[0].tagIds, ['tag_0000000000000001'], '重複的標籤 id 只留一個');

    const removed = removeTag(applied, 'tag_0000000000000001', T2)!;
    assert.equal(removed.tags.length, 0);
    assert.deepEqual(removed.items[0].tagIds, []);
  });
});

suite('parseCollection', () => {
  test('完整檔案來回一致', () => {
    const { collection } = fixture();
    const parsed = parseCollection(JSON.parse(JSON.stringify(collection)), nextId);
    assert.deepEqual(parsed, collection);
  });

  test('缺 id 或 name 救不回來', () => {
    assert.equal(parseCollection(null, nextId), undefined);
    assert.equal(parseCollection({ name: 'x' }, nextId), undefined);
    assert.equal(parseCollection({ id: 'x' }, nextId), undefined);
  });

  test('壞欄位逐一修正：狀態退回未完成、分類退回未分類、多餘欄位丟掉、沒分類時補未分類', () => {
    const parsed = parseCollection(
      {
        id: 'col_0000000000000001',
        name: 'x',
        extra: 'ignored',
        categories: [],
        tags: [{ id: 'tag_1', name: '好', color: 'nope' }, { id: 'tag_2', name: '' }],
        items: [
          {
            id: 'todo_1',
            title: 'a',
            status: '???',
            categoryId: 'ghost',
            tagIds: ['tag_1', 'tag_2', 7],
            completedAt: '2026-01-01T00:00:00.000Z',
            createdAt: 'bad',
            secret: 1,
          },
          { id: 'todo_1', title: 'dup' },
          { title: 'no id' },
        ],
      },
      nextId,
    )!;
    assert.equal(parsed.categories.length, 1);
    assert.equal(parsed.categories[0].name, DEFAULT_CATEGORY_NAME);
    assert.deepEqual(parsed.tags, [{ id: 'tag_1', name: '好', color: 'gray' }]);
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    assert.equal(item.status, '未完成');
    assert.equal(item.categoryId, parsed.categories[0].id);
    assert.deepEqual(item.tagIds, ['tag_1']);
    assert.equal(item.completedAt, null, '狀態不是完成類時清掉完成時間');
    assert.equal('secret' in item, false);
    assert.equal('extra' in parsed, false);
  });

  test('完成類狀態保留檔案裡的完成時間', () => {
    const parsed = parseCollection(
      {
        id: 'col_0000000000000001',
        name: 'x',
        items: [{ id: 'todo_1', status: '失敗', completedAt: '2026-01-01T00:00:00.000Z', createdAt: '2025-12-31T00:00:00.000Z' }],
      },
      nextId,
    )!;
    assert.equal(parsed.items[0].completedAt, '2026-01-01T00:00:00.000Z');
  });

  test('結論：舊檔沒有這個欄位補空字串，型別不對也補空字串', () => {
    const parsed = parseCollection(
      {
        id: 'col_0000000000000001',
        name: 'x',
        items: [
          { id: 'todo_1', status: '已完成', conclusion: '做完了' },
          { id: 'todo_2', status: '已完成' },
          { id: 'todo_3', status: '失敗', conclusion: 7 },
        ],
      },
      nextId,
    )!;
    assert.deepEqual(
      parsed.items.map((item) => item.conclusion),
      ['做完了', '', ''],
    );
  });
});
