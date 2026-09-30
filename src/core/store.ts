import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createId, isSafeIdSegment } from './ids';
import type { Collection } from './model';
import { parseCollection } from './model';
import type { UiState } from './uiState';
import { parseUiState } from './uiState';

export interface StoreProblem {
  file: string;
  reason: string;
}

/** 個別 Collection 的保存資料夾：id → 資料夾路徑。沒列在這裡的都放預設資料夾。 */
export type CollectionFolders = Readonly<Record<string, string>>;

/** 寫入前發現磁碟上的版本跟上次讀到的不同：別的視窗改過或刪掉了，這次變更不能寫。 */
export class StaleError extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
    this.name = 'StaleError';
  }
}

/** 檔案裡 `updatedAt` 的原字串就是版本號。手改的檔案格式可能不標準，所以不正規化、只比字串。 */
export function rawVersion(json: unknown): string {
  const updatedAt = json && typeof json === 'object' ? (json as Record<string, unknown>).updatedAt : undefined;
  return typeof updatedAt === 'string' ? updatedAt : '';
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 先寫暫存檔、再 rename：另一個視窗同時在讀也不會讀到半份 JSON。 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * 一個 Collection 一份 `<資料夾>/<id>.json`。預設都在 `dir`；`folders` 列出的 Collection 改放各自的資料夾。
 * 每份的版本號（檔案裡 `updatedAt` 的原字串）在讀與寫時記下來，寫入前拿來跟磁碟比。
 * `folders` 裡出現的資料夾是共用資料夾：裡面沒被點名的 Collection 也一併讀進來，寫回原資料夾。
 */
export class CollectionStore {
  /** 上次讀或寫時每個 Collection 的版本號。 */
  private readonly versions = new Map<string, string>();
  /** 上次 `list()` 在共用資料夾裡找到、`folders` 沒點名的 Collection：id → 資料夾。 */
  private readonly discovered = new Map<string, string>();

  constructor(
    readonly dir: string,
    readonly folders: CollectionFolders = {},
  ) {}

  /** 上次讀或寫時記下的版本號；沒讀過的回 undefined。 */
  version(id: string): string | undefined {
    return this.versions.get(id);
  }

  /**
   * 寫入前先看磁碟：版本號跟上次讀到的不同，代表別的視窗已經改過（或刪掉），要拒絕這次變更。
   * 沒讀過的（剛建的）不比。磁碟上的 JSON 壞掉時照樣丟錯，不拿記憶體裡的內容蓋掉它。
   */
  async assertFresh(id: string): Promise<void> {
    const known = this.versions.get(id);
    if (known === undefined) {
      return;
    }
    let text: string;
    try {
      text = await fs.readFile(this.fileFor(id), 'utf8');
    } catch (error) {
      if (isEnoent(error)) {
        throw new StaleError(id, '的檔案已不存在，可能被其他視窗刪除');
      }
      throw error;
    }
    if (rawVersion(JSON.parse(text)) !== known) {
      throw new StaleError(id, '已被其他視窗更新');
    }
  }

  /** 這個 Collection 目前該放在哪個資料夾。 */
  folderFor(id: string): string {
    return this.hasConfiguredFolder(id) ? this.folders[id] : (this.discovered.get(id) ?? this.dir);
  }

  hasCustomFolder(id: string): boolean {
    return this.hasConfiguredFolder(id) || this.discovered.has(id);
  }

  /** `folders` 有點名這個 id。 */
  private hasConfiguredFolder(id: string): boolean {
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
    this.versions.clear();
    this.discovered.clear();
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
    await this.readShared(collections, problems);
    collections.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant') || a.createdAt.localeCompare(b.createdAt));
    return { collections, problems };
  }

  private async readInto(file: string, id: string, collections: Collection[], problems: StoreProblem[]): Promise<boolean> {
    try {
      const json: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      const parsed = parseCollection(json, createId);
      if (!parsed) {
        problems.push({ file, reason: '缺少 id 或 name' });
        return false;
      }
      // 檔名才是身分；內容的 id 對不上時以檔名為準，避免複製檔案後兩份互相覆寫。
      collections.push(parsed.id === id ? parsed : { ...parsed, id });
      this.versions.set(id, rawVersion(json));
      return true;
    } catch (error) {
      problems.push({ file, reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * 掃 `folders` 裡出現的每個資料夾，讀進沒被點名的 Collection，記在 `discovered`，之後寫回同一個資料夾。
   * 點名過的 id 各讀各的；預設資料夾已經有同 id 的就略過並回報，不讓兩份互相覆寫。
   */
  private async readShared(collections: Collection[], problems: StoreProblem[]): Promise<void> {
    const shared = new Set(
      Object.keys(this.folders)
        .filter((id) => isSafeIdSegment(id) && this.hasConfiguredFolder(id))
        .map((id) => path.resolve(this.folders[id])),
    );
    for (const folder of shared) {
      let names: string[];
      try {
        names = await fs.readdir(folder);
      } catch (error) {
        // 資料夾不存在時，點名的那份已經回報過「找不到檔案」。
        if (!isEnoent(error)) {
          problems.push({ file: folder, reason: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) {
          continue;
        }
        const id = name.slice(0, -'.json'.length);
        if (!isSafeIdSegment(id) || this.hasCustomFolder(id)) {
          continue;
        }
        const file = path.join(folder, name);
        if (collections.some((collection) => collection.id === id)) {
          problems.push({ file, reason: '預設資料夾已有同 id 的 Collection，這份不讀；要改用這份請先移走預設資料夾那份' });
          continue;
        }
        if (await this.readInto(file, id, collections, problems)) {
          this.discovered.set(id, folder);
        }
      }
    }
  }

  /** 寫檔不比版本，呼叫端要先 `assertFresh`；寫完把版本號更新成這份的 `updatedAt`。 */
  async save(collection: Collection): Promise<void> {
    await writeJsonAtomic(this.fileFor(collection.id), collection);
    this.versions.set(collection.id, collection.updatedAt);
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.fileFor(id), { force: true });
    this.versions.delete(id);
  }

  /**
   * 把一個 Collection 的檔案搬到另一個資料夾；`folder` 給 undefined 代表搬回預設資料夾。
   * 目的地已經有同 id 的檔案就拒絕，不覆蓋別人的資料。搬成功後回傳新的資料夾對照表，
   * 由呼叫端寫進設定並用它建新的 store；這個 store 本身不變。
   * 搬的是記憶體裡這份內容，所以先比版本：別的視窗改過就不搬，免得把舊內容搬過去。
   */
  async relocate(collection: Collection, folder: string | undefined): Promise<Record<string, string>> {
    await this.assertFresh(collection.id);
    const from = this.fileFor(collection.id);
    // 共用資料夾裡找到的也寫進對照表：點名的那份搬走後，資料夾仍留在設定裡，其他 Collection 不會跟著消失。
    const next: Record<string, string> = { ...Object.fromEntries(this.discovered), ...this.folders };
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
      if (!isEnoent(error)) {
        throw error;
      }
    }
    await target.save(collection);
    await fs.rm(from, { force: true });
    return next;
  }
}

/** 畫面狀態檔 `ui-state.json`：跟 Collection 分開，讀不到就當沒有，寫入一樣走暫存檔再 rename。 */
export class UiStateStore {
  constructor(readonly file: string) {}

  /** 檔案不存在或壞掉都回 undefined：畫面狀態丟了沒關係，從預設重新開始就好。 */
  async read(): Promise<UiState | undefined> {
    try {
      return parseUiState(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      return undefined;
    }
  }

  async write(state: UiState): Promise<void> {
    await writeJsonAtomic(this.file, state);
  }
}
