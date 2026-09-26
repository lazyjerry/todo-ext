import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createId, isSafeIdSegment } from './ids';
import type { Collection } from './model';
import { parseCollection } from './model';

export interface StoreProblem {
  file: string;
  reason: string;
}

/**
 * 一個 Collection 一份 `<dir>/<id>.json`。
 * 寫入走「先寫暫存檔、再 rename」：另一個視窗同時在讀也不會讀到半份 JSON。
 */
export class CollectionStore {
  constructor(readonly dir: string) {}

  fileFor(id: string): string {
    if (!isSafeIdSegment(id)) {
      throw new Error(`不合法的 Collection id：${id}`);
    }
    const file = path.resolve(this.dir, `${id}.json`);
    if (path.dirname(file) !== path.resolve(this.dir)) {
      throw new Error(`Collection 路徑超出資料夾：${file}`);
    }
    return file;
  }

  /** 讀出全部 Collection；壞掉的檔案略過並回報，不讓一份壞檔拖垮整個面板。 */
  async list(): Promise<{ collections: Collection[]; problems: StoreProblem[] }> {
    await fs.mkdir(this.dir, { recursive: true });
    const collections: Collection[] = [];
    const problems: StoreProblem[] = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const id = name.slice(0, -'.json'.length);
      if (!isSafeIdSegment(id)) {
        continue;
      }
      const file = path.join(this.dir, name);
      try {
        const parsed = parseCollection(JSON.parse(await fs.readFile(file, 'utf8')), createId);
        if (!parsed) {
          problems.push({ file, reason: '缺少 id 或 name' });
          continue;
        }
        // 檔名才是身分；內容的 id 對不上時以檔名為準，避免複製檔案後兩份互相覆寫。
        collections.push(parsed.id === id ? parsed : { ...parsed, id });
      } catch (error) {
        problems.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    collections.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant') || a.createdAt.localeCompare(b.createdAt));
    return { collections, problems };
  }

  async save(collection: Collection): Promise<void> {
    const file = this.fileFor(collection.id);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.fileFor(id), { force: true });
  }
}
