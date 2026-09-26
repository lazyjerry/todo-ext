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

/** 個別 Collection 的保存資料夾：id → 資料夾路徑。沒列在這裡的都放預設資料夾。 */
export type CollectionFolders = Readonly<Record<string, string>>;

/**
 * 一個 Collection 一份 `<資料夾>/<id>.json`。預設都在 `dir`；`folders` 列出的 Collection 改放各自的資料夾。
 * 寫入走「先寫暫存檔、再 rename」：另一個視窗同時在讀也不會讀到半份 JSON。
 */
export class CollectionStore {
  constructor(
    readonly dir: string,
    readonly folders: CollectionFolders = {},
  ) {}

  /** 這個 Collection 目前該放在哪個資料夾。 */
  folderFor(id: string): string {
    return this.hasCustomFolder(id) ? this.folders[id] : this.dir;
  }

  hasCustomFolder(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.folders, id) && typeof this.folders[id] === 'string' && this.folders[id] !== '';
  }

  fileFor(id: string): string {
    if (!isSafeIdSegment(id)) {
      throw new Error(`不合法的 Collection id：${id}`);
    }
    const dir = path.resolve(this.folderFor(id));
    const file = path.resolve(dir, `${id}.json`);
    if (path.dirname(file) !== dir) {
      throw new Error(`Collection 路徑超出資料夾：${file}`);
    }
    return file;
  }

  /**
   * 讀出全部 Collection；壞掉的檔案略過並回報，不讓一份壞檔拖垮整個面板。
   * 另設保存位置的 Collection 只讀設定指向的那份；預設資料夾裡同 id 的殘留檔不讀，避免兩份互相覆寫。
   */
  async list(): Promise<{ collections: Collection[]; problems: StoreProblem[] }> {
    await fs.mkdir(this.dir, { recursive: true });
    const collections: Collection[] = [];
    const problems: StoreProblem[] = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const id = name.slice(0, -'.json'.length);
      if (!isSafeIdSegment(id) || this.hasCustomFolder(id)) {
        continue;
      }
      await this.readInto(path.join(this.dir, name), id, collections, problems);
    }
    for (const id of Object.keys(this.folders)) {
      if (!isSafeIdSegment(id) || !this.hasCustomFolder(id)) {
        continue;
      }
      const file = this.fileFor(id);
      try {
        await fs.access(file);
      } catch {
        problems.push({ file, reason: '找不到檔案；若已不需要這個 Collection，請從設定 todooo.collectionFolders 移除這筆' });
        continue;
      }
      await this.readInto(file, id, collections, problems);
    }
    collections.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant') || a.createdAt.localeCompare(b.createdAt));
    return { collections, problems };
  }

  private async readInto(file: string, id: string, collections: Collection[], problems: StoreProblem[]): Promise<void> {
    try {
      const parsed = parseCollection(JSON.parse(await fs.readFile(file, 'utf8')), createId);
      if (!parsed) {
        problems.push({ file, reason: '缺少 id 或 name' });
        return;
      }
      // 檔名才是身分；內容的 id 對不上時以檔名為準，避免複製檔案後兩份互相覆寫。
      collections.push(parsed.id === id ? parsed : { ...parsed, id });
    } catch (error) {
      problems.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async save(collection: Collection): Promise<void> {
    const file = this.fileFor(collection.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
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

  /**
   * 把一個 Collection 的檔案搬到另一個資料夾；`folder` 給 undefined 代表搬回預設資料夾。
   * 目的地已經有同 id 的檔案就拒絕，不覆蓋別人的資料。搬成功後回傳新的資料夾對照表，
   * 由呼叫端寫進設定並用它建新的 store；這個 store 本身不變。
   */
  async relocate(collection: Collection, folder: string | undefined): Promise<Record<string, string>> {
    const from = this.fileFor(collection.id);
    const next: Record<string, string> = { ...this.folders };
    if (folder === undefined) {
      delete next[collection.id];
    } else {
      next[collection.id] = folder;
    }
    const target = new CollectionStore(this.dir, next);
    const to = target.fileFor(collection.id);
    if (from === to) {
      return next;
    }
    try {
      await fs.access(to);
      throw new Error(`目的地已經有 ${path.basename(to)}，不覆蓋既有檔案`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await target.save(collection);
    await fs.rm(from, { force: true });
    return next;
  }
}
