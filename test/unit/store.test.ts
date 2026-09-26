import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCollection } from '../../src/core/model';
import { CollectionStore } from '../../src/core/store';

const T0 = new Date('2026-09-26T01:02:03.000Z');

suite('CollectionStore', () => {
  let dir: string;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'todooo-'));
  });

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('save 後 list 讀得回來，依名稱排序，沒有暫存檔殘留', async () => {
    const store = new CollectionStore(path.join(dir, 'collections'));
    const b = createCollection('col_00000000000000b0', 'cat_00000000000000b0', 'beta', T0);
    const a = createCollection('col_00000000000000a0', 'cat_00000000000000a0', 'alpha', T0);
    await store.save(b);
    await store.save(a);
    const { collections, problems } = await store.list();
    assert.deepEqual(problems, []);
    assert.deepEqual(
      collections.map((collection) => collection.name),
      ['alpha', 'beta'],
    );
    const files = await fs.readdir(store.dir);
    assert.deepEqual(files.sort(), ['col_00000000000000a0.json', 'col_00000000000000b0.json']);
  });

  test('壞掉的 JSON 與非法檔名略過並回報，其他照讀', async () => {
    const store = new CollectionStore(dir);
    await store.save(createCollection('col_0000000000000001', 'cat_0000000000000001', '好', T0));
    await fs.writeFile(path.join(dir, 'col_0000000000000002.json'), '{ broken', 'utf8');
    await fs.writeFile(path.join(dir, 'col_0000000000000003.json'), '{"name":"沒 id"}', 'utf8');
    await fs.writeFile(path.join(dir, '..hack.json'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x', 'utf8');
    const { collections, problems } = await store.list();
    assert.deepEqual(
      collections.map((collection) => collection.id),
      ['col_0000000000000001'],
    );
    assert.deepEqual(problems.map((problem) => path.basename(problem.file)).sort(), ['col_0000000000000002.json', 'col_0000000000000003.json']);
  });

  test('檔名才是身分：內容 id 對不上時以檔名為準', async () => {
    const store = new CollectionStore(dir);
    const original = createCollection('col_0000000000000001', 'cat_0000000000000001', '原本', T0);
    await fs.writeFile(path.join(dir, 'col_0000000000000009.json'), JSON.stringify(original), 'utf8');
    const { collections } = await store.list();
    assert.equal(collections[0].id, 'col_0000000000000009');
  });

  test('remove 刪檔；不合法 id 直接拒絕', async () => {
    const store = new CollectionStore(dir);
    await store.save(createCollection('col_0000000000000001', 'cat_0000000000000001', 'x', T0));
    await store.remove('col_0000000000000001');
    assert.deepEqual((await store.list()).collections, []);
    await assert.rejects(store.remove('../etc/passwd'));
    await assert.rejects(store.save({ ...createCollection('col_0000000000000001', 'cat_0000000000000001', 'x', T0), id: 'x/y' }));
  });
});
