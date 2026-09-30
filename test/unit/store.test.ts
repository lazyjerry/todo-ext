import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCollection } from '../../src/core/model';
import { CollectionStore, StaleError, rawVersion } from '../../src/core/store';

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

  test('另設保存位置的 Collection 讀設定指向的那份，預設資料夾裡同 id 的殘留檔不讀', async () => {
    const custom = path.join(dir, 'elsewhere');
    const store = new CollectionStore(dir, { col_0000000000000001: custom });
    await store.save(createCollection('col_0000000000000001', 'cat_0000000000000001', '搬走的', T0));
    await store.save(createCollection('col_0000000000000002', 'cat_0000000000000002', '留著的', T0));
    await fs.writeFile(
      path.join(dir, 'col_0000000000000001.json'),
      JSON.stringify(createCollection('col_0000000000000001', 'cat_0000000000000001', '殘留', T0)),
      'utf8',
    );
    assert.equal(store.fileFor('col_0000000000000001'), path.join(custom, 'col_0000000000000001.json'));
    assert.equal(store.hasCustomFolder('col_0000000000000001'), true);
    assert.equal(store.hasCustomFolder('col_0000000000000002'), false);
    const { collections, problems } = await store.list();
    assert.deepEqual(problems, []);
    assert.deepEqual(
      collections.map((collection) => collection.name).sort(),
      ['搬走的', '留著的'].sort(),
    );
  });

  test('設定指向的檔案不存在時回報，不自己補一份', async () => {
    const store = new CollectionStore(dir, { col_0000000000000001: path.join(dir, 'gone') });
    const { collections, problems } = await store.list();
    assert.deepEqual(collections, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /todooo\.collectionFolders/);
  });

  test('relocate 搬檔並回傳新的對照表；搬回預設；目的地已有同 id 檔案就拒絕', async () => {
    const store = new CollectionStore(dir);
    const collection = createCollection('col_0000000000000001', 'cat_0000000000000001', 'x', T0);
    await store.save(collection);
    const custom = path.join(dir, 'custom');

    const folders = await store.relocate(collection, custom);
    assert.deepEqual(folders, { col_0000000000000001: custom });
    await assert.rejects(fs.access(path.join(dir, 'col_0000000000000001.json')), '原檔已搬走');
    const moved = new CollectionStore(dir, folders);
    assert.equal((await moved.list()).collections[0].name, 'x');

    await fs.writeFile(path.join(dir, 'col_0000000000000001.json'), '{}', 'utf8');
    await assert.rejects(moved.relocate(collection, undefined), /不覆蓋/);
    await fs.rm(path.join(dir, 'col_0000000000000001.json'));

    const restored = await moved.relocate(collection, undefined);
    assert.deepEqual(restored, {});
    await assert.rejects(fs.access(path.join(custom, 'col_0000000000000001.json')));
    assert.equal((await new CollectionStore(dir, restored).list()).collections[0].name, 'x');
  });

  test('remove 刪檔；不合法 id 直接拒絕', async () => {
    const store = new CollectionStore(dir);
    await store.save(createCollection('col_0000000000000001', 'cat_0000000000000001', 'x', T0));
    await store.remove('col_0000000000000001');
    assert.deepEqual((await store.list()).collections, []);
    await assert.rejects(store.remove('../etc/passwd'));
    await assert.rejects(store.save({ ...createCollection('col_0000000000000001', 'cat_0000000000000001', 'x', T0), id: 'x/y' }));
  });

  test('版本號：save 與 list 都記下 updatedAt；別的視窗改過或刪掉就 assertFresh 拒絕，重讀後放行', async () => {
    const store = new CollectionStore(dir);
    const id = 'col_0000000000000001';
    const collection = createCollection(id, 'cat_0000000000000001', 'x', T0);
    assert.equal(store.version(id), undefined);
    await store.assertFresh(id);
    await store.save(collection);
    assert.equal(store.version(id), collection.updatedAt);
    await store.assertFresh(id);

    // 另一個視窗寫入：updatedAt 變了。
    const other = new CollectionStore(dir);
    await other.save({ ...collection, updatedAt: '2026-09-26T02:00:00.000Z' });
    await assert.rejects(store.assertFresh(id), (error: unknown) => error instanceof StaleError && error.id === id && /更新/.test(error.message));
    await store.list();
    assert.equal(store.version(id), '2026-09-26T02:00:00.000Z');
    await store.assertFresh(id);

    await fs.rm(store.fileFor(id));
    await assert.rejects(store.assertFresh(id), (error: unknown) => error instanceof StaleError && /不存在/.test(error.message));
  });

  test('版本號比的是檔案裡的原字串：手寫的非標準時間或缺 updatedAt 也不會被自己鎖住', async () => {
    const store = new CollectionStore(dir);
    const id = 'col_0000000000000001';
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, name: 'hand', updatedAt: '2026-09-26T01:02:03Z' }), 'utf8');
    await fs.writeFile(path.join(dir, 'col_0000000000000002.json'), JSON.stringify({ id: 'col_0000000000000002', name: 'no time' }), 'utf8');
    await store.list();
    assert.equal(store.version(id), '2026-09-26T01:02:03Z');
    assert.equal(store.version('col_0000000000000002'), '');
    await store.assertFresh(id);
    await store.assertFresh('col_0000000000000002');
    assert.equal(rawVersion({ updatedAt: 5 }), '');
    assert.equal(rawVersion(null), '');
  });

  test('relocate 前先比版本：別的視窗改過就不搬', async () => {
    const store = new CollectionStore(dir);
    const collection = createCollection('col_0000000000000001', 'cat_0000000000000001', 'x', T0);
    await store.save(collection);
    await new CollectionStore(dir).save({ ...collection, name: 'changed', updatedAt: '2026-09-26T02:00:00.000Z' });
    await assert.rejects(store.relocate(collection, path.join(dir, 'custom')), StaleError);
    assert.equal((await new CollectionStore(dir).list()).collections[0].name, 'changed');
  });

  test('設定裡的資料夾是共用資料夾：沒點名的 Collection 一併讀進來、寫回原資料夾；預設資料夾已有同 id 就略過並回報', async () => {
    const shared = path.join(dir, 'shared');
    const other = new CollectionStore(dir, { col_0000000000000002: shared, col_0000000000000003: shared });
    await other.save(createCollection('col_0000000000000002', 'cat_0000000000000002', '別處建的', T0));
    await other.save(createCollection('col_0000000000000003', 'cat_0000000000000003', '撞 id 的', T0));
    const store = new CollectionStore(dir, { col_0000000000000001: shared });
    await store.save(createCollection('col_0000000000000001', 'cat_0000000000000001', '點名的', T0));
    await store.save(createCollection('col_0000000000000003', 'cat_0000000000000003', '預設那份', T0));

    const { collections, problems } = await store.list();
    assert.deepEqual(
      collections.map((collection) => collection.name).sort(),
      ['別處建的', '點名的', '預設那份'].sort(),
    );
    assert.deepEqual(
      problems.map((problem) => problem.file),
      [path.join(shared, 'col_0000000000000003.json')],
    );
    assert.equal(store.hasCustomFolder('col_0000000000000002'), true);
    assert.equal(store.fileFor('col_0000000000000002'), path.join(shared, 'col_0000000000000002.json'));
    assert.equal(store.fileFor('col_0000000000000003'), path.join(dir, 'col_0000000000000003.json'));
  });

  test('relocate 回傳的對照表帶上共用資料夾裡找到的 Collection：點名那份搬走後其他的不會消失', async () => {
    const shared = path.join(dir, 'shared');
    await new CollectionStore(dir, { col_0000000000000002: shared }).save(createCollection('col_0000000000000002', 'cat_0000000000000002', '共用的', T0));
    const store = new CollectionStore(dir, { col_0000000000000001: shared });
    const named = createCollection('col_0000000000000001', 'cat_0000000000000001', '點名的', T0);
    await store.save(named);
    await store.list();

    const folders = await store.relocate(named, undefined);
    assert.deepEqual(folders, { col_0000000000000002: shared });
    assert.deepEqual(
      (await new CollectionStore(dir, folders).list()).collections.map((collection) => collection.name).sort(),
      ['共用的', '點名的'].sort(),
    );
  });

  test('寫設定失敗時的回滾：用搬檔後的對照表建新 store，把檔案搬回原本的共用資料夾', async () => {
    const shared = path.join(dir, 'shared');
    await new CollectionStore(dir, { col_0000000000000002: shared }).save(createCollection('col_0000000000000002', 'cat_0000000000000002', '共用的', T0));
    const store = new CollectionStore(dir, { col_0000000000000001: shared });
    const found = (await store.list()).collections.find((collection) => collection.id === 'col_0000000000000002')!;
    const previous = store.folderFor(found.id);
    const elsewhere = path.join(dir, 'elsewhere');

    const folders = await store.relocate(found, elsewhere);
    await new CollectionStore(dir, folders).relocate(found, previous);
    await fs.access(path.join(shared, 'col_0000000000000002.json'));
    await assert.rejects(fs.access(path.join(elsewhere, 'col_0000000000000002.json')));
  });
});
