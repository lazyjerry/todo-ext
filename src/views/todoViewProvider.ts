import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { createId, isSafeIdSegment } from '../core/ids';
import type { Collection } from '../core/model';
import {
  addCategory,
  addTag,
  applyItemPatch,
  childrenOf,
  createCollection,
  createItem,
  DEFAULT_COLLECTION_NAME,
  moveItem,
  NAME_MAX,
  removeCategory,
  removeItem,
  removeTag,
  renameCategory,
  renameCollection,
  updateTag,
  withItem,
} from '../core/model';
import type { CollectionFolders } from '../core/store';
import { CollectionStore, StaleError, UiStateStore } from '../core/store';
import type { UiState } from '../core/uiState';
import { DEFAULT_VIEW, viewOf } from '../core/uiState';
import type { ClientMessage, HostMessage } from '../shared/protocol';
import { clampRatio, isClientMessage } from '../shared/protocol';

const SELECTED_KEY = 'todooo.selectedCollection';
const RATIO_KEY = 'todooo.ratio';
const DATA_FOLDER_SETTING = 'todooo.dataFolder';
const FOLDERS_SETTING = 'todooo.collectionFolders';
const UI_STATE_FILE = 'ui-state.json';

/**
 * 底部 Panel 裡的 view。收起再打開時 webview 保留（retainContextWhenHidden），
 * 資料狀態一律留在 provider 上，view 被 VS Code 回收重建也照樣接得回來。
 */
export class TodoViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'todooo.panel';

  private view: vscode.WebviewView | undefined;
  private store: CollectionStore;
  private uiStore: UiStateStore;
  private collections: Collection[] = [];
  /** 畫面狀態的記憶體副本；開面板、按刷新時從 `ui-state.json` 讀進來，使用者一動就寫回去。 */
  private ui: UiState;
  private readonly disposables: vscode.Disposable[] = [];
  /** 序列化所有會改資料的操作，避免兩則訊息交錯寫同一份檔案。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new CollectionStore(collectionsDir(), collectionFolders());
    this.uiStore = new UiStateStore(path.join(dataDir(), UI_STATE_FILE));
    // 0.3.x 之前選到的 Collection 記在 globalState；第一次還沒有畫面狀態檔時拿它當起點。
    const legacy = this.context.globalState.get<unknown>(SELECTED_KEY);
    this.ui = { ...DEFAULT_VIEW, collectionId: typeof legacy === 'string' ? legacy : null, updatedAt: '' };
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(DATA_FOLDER_SETTING) || event.affectsConfiguration(FOLDERS_SETTING)) {
          this.store = new CollectionStore(collectionsDir(), collectionFolders());
          this.uiStore = new UiStateStore(path.join(dataDir(), UI_STATE_FILE));
          this.enqueue(() => this.reload({ view: true }));
        }
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (isClientMessage(message)) {
        this.enqueue(() => this.handle(message));
      }
    });
    // 面板收起再打開時重讀磁碟與畫面狀態：別的視窗可能改過，要切到最後一次變更的狀態。
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.enqueue(() => this.reload({ view: true }));
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  dispose(): void {
    for (const item of this.disposables) {
      item.dispose();
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch(async (error: unknown) => {
        if (!(error instanceof StaleError)) {
          reportError(error);
          return;
        }
        // 別的視窗改過：這次變更不寫，提示後重讀最新內容。焦點與正在打的字都不動，
        // 下一次送出（下一個字、失焦）就以新版本為基準，使用者不必重做。
        const name = this.collections.find((entry) => entry.id === error.id)?.name ?? error.id;
        void vscode.window.showWarningMessage(`todooo：「${name}」${error.message}，這次變更未保存；已重新讀取最新內容。`);
        await this.reload();
      })
      .catch(reportError);
  }

  private get ratio(): number {
    return clampRatio(this.context.globalState.get<unknown>(RATIO_KEY));
  }

  private get selected(): Collection | undefined {
    return this.collections.find((collection) => collection.id === this.ui.collectionId) ?? this.collections[0];
  }

  /**
   * 重讀全部 Collection；一份都沒有就建預設的那份，面板永遠至少有一個 Collection。
   * `view` 為 true 時連畫面狀態檔一起讀，並要 webview 切到那個狀態（開面板、按刷新時）。
   */
  private async reload(options: { view?: boolean } = {}): Promise<void> {
    const { collections, problems } = await this.store.list();
    this.collections = collections;
    for (const problem of problems) {
      void vscode.window.showWarningMessage(`todooo：略過無法讀取的 ${path.basename(problem.file)}（${problem.reason}）`);
    }
    if (this.collections.length === 0) {
      const created = createCollection(createId('col'), createId('cat'), DEFAULT_COLLECTION_NAME, new Date());
      await this.store.save(created);
      this.collections = [created];
    }
    if (options.view) {
      const saved = await this.uiStore.read();
      if (saved) {
        this.ui = saved;
      }
    }
    const selected = this.selected!;
    if (selected.id !== this.ui.collectionId) {
      await this.saveUi({ collectionId: selected.id });
    }
    this.postState(undefined, options.view);
  }

  private postState(focusItemId?: string, withView = false): void {
    const collection = this.selected;
    if (!collection) {
      this.post({ type: 'empty', reason: '沒有可用的 Collection' });
      return;
    }
    this.post({
      type: 'state',
      collections: this.collections.map(({ id, name }) => ({ id, name })),
      collection,
      ratio: this.ratio,
      folder: collapseHome(this.store.folderFor(collection.id)),
      customFolder: this.store.hasCustomFolder(collection.id),
      focusItemId,
      view: withView ? viewOf(this.ui) : undefined,
    });
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** 畫面狀態一動就整份寫回檔案，讓其他視窗下次開面板或按刷新時切得過來。 */
  private async saveUi(patch: Partial<UiState>): Promise<void> {
    this.ui = { ...this.ui, ...patch, updatedAt: new Date().toISOString() };
    await this.uiStore.write(this.ui);
  }

  /** 把改好的 Collection 寫回磁碟並更新記憶體中的那份，再把整個狀態送給 webview。寫之前先比版本。 */
  private async commit(collection: Collection, focusItemId?: string): Promise<void> {
    await this.store.assertFresh(collection.id);
    await this.store.save(collection);
    const index = this.collections.findIndex((entry) => entry.id === collection.id);
    if (index < 0) {
      this.collections.push(collection);
    } else {
      this.collections[index] = collection;
    }
    this.collections.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant') || a.createdAt.localeCompare(b.createdAt));
    this.postState(focusItemId);
  }

  /** 換 Collection 時選到的項目一起清掉，跟 webview 端的行為一致。 */
  private async select(id: string): Promise<void> {
    await this.saveUi({ collectionId: id, itemId: null });
    this.postState();
  }

  private async handle(message: ClientMessage): Promise<void> {
    if (message.type === 'ready' || message.type === 'refresh') {
      await this.reload({ view: true });
      return;
    }
    if (message.type === 'setView') {
      await this.saveUi(message.view);
      return;
    }
    const collection = this.selected;
    if (!collection) {
      await this.reload();
      return;
    }
    const now = new Date();
    switch (message.type) {
      case 'selectCollection': {
        if (this.collections.some((entry) => entry.id === message.id)) {
          await this.select(message.id);
        }
        return;
      }
      case 'createCollection': {
        const name = await askName('新 Collection 的名稱');
        if (name === undefined) {
          return;
        }
        const created = createCollection(createId('col'), createId('cat'), name, now);
        await this.store.save(created);
        this.collections.push(created);
        await this.select(created.id);
        return;
      }
      case 'renameCollection': {
        const target = this.collections.find((entry) => entry.id === message.id);
        if (!target) {
          return;
        }
        const name = await askName('Collection 的新名稱', target.name);
        if (name === undefined) {
          return;
        }
        const renamed = renameCollection(target, name, now);
        if (renamed) {
          await this.commit(renamed);
        }
        return;
      }
      case 'deleteCollection': {
        const target = this.collections.find((entry) => entry.id === message.id);
        if (!target) {
          return;
        }
        if (this.collections.length <= 1) {
          void vscode.window.showWarningMessage('todooo：至少需保留一個 Collection。');
          return;
        }
        const confirmed = await confirm(`刪除 Collection「${target.name}」與其中 ${target.items.length} 個 TODO？此動作無法復原。`);
        if (!confirmed) {
          return;
        }
        await this.store.assertFresh(target.id);
        await this.store.remove(target.id);
        this.collections = this.collections.filter((entry) => entry.id !== target.id);
        await this.select(this.collections[0].id);
        return;
      }
      case 'setCollectionFolder': {
        const target = this.collections.find((entry) => entry.id === message.id);
        if (target) {
          await this.relocate(target);
        }
        return;
      }
      case 'createItem': {
        const item = createItem(createId('todo'), collection, now, message.parentId ?? null);
        await this.commit(withItem(collection, item, now), item.id);
        return;
      }
      case 'updateItem': {
        const item = collection.items.find((entry) => entry.id === message.id);
        if (item) {
          await this.commit(withItem(collection, applyItemPatch(collection, item, message.patch, now), now));
        }
        return;
      }
      case 'moveItem': {
        if (!collection.items.some((entry) => entry.id === message.id)) {
          this.postState();
          return;
        }
        await this.commitOrWarn(
          moveItem(collection, message.id, message.parentId, message.index, now),
          '帶著子項目的 TODO 只能留在頂層，子項目底下也不能再放子項目。',
        );
        return;
      }
      case 'deleteItem': {
        const item = collection.items.find((entry) => entry.id === message.id);
        if (!item) {
          return;
        }
        const children = childrenOf(collection, item.id).length;
        const hint = children > 0 ? `與底下 ${children} 個子項目` : '';
        if (await confirm(`刪除 TODO「${item.title || '（無標題）'}」${hint}？此動作無法復原。`)) {
          await this.commit(removeItem(collection, item.id, now));
        }
        return;
      }
      case 'createCategory':
        await this.commitOrWarn(addCategory(collection, createId('cat'), message.name, now), '分類名稱不可為空，也不可與既有分類重複。');
        return;
      case 'renameCategory':
        await this.commitOrWarn(renameCategory(collection, message.id, message.name, now), '分類名稱不可為空，也不可與既有分類重複。');
        return;
      case 'deleteCategory': {
        const category = collection.categories.find((entry) => entry.id === message.id);
        if (!category) {
          return;
        }
        if (collection.categories.length <= 1) {
          void vscode.window.showWarningMessage('todooo：至少需保留一個分類。');
          return;
        }
        const affected = collection.items.filter((item) => item.categoryId === message.id).length;
        const hint = affected > 0 ? `，${affected} 個 TODO 會改為「未分類」（或第一個分類）` : '';
        if (await confirm(`刪除分類「${category.name}」${hint}？`)) {
          await this.commitOrWarn(removeCategory(collection, message.id, now), '至少需保留一個分類。');
        }
        return;
      }
      case 'createTag':
        await this.commitOrWarn(addTag(collection, createId('tag'), message.name, message.color, now), '標籤名稱不可為空，也不可與既有標籤重複。');
        return;
      case 'updateTag':
        await this.commitOrWarn(
          updateTag(collection, message.id, { name: message.name, color: message.color }, now),
          '標籤名稱不可為空，也不可與既有標籤重複。',
        );
        return;
      case 'deleteTag': {
        const tag = collection.tags.find((entry) => entry.id === message.id);
        if (!tag) {
          return;
        }
        const affected = collection.items.filter((item) => item.tagIds.includes(message.id)).length;
        const hint = affected > 0 ? `，會從 ${affected} 個 TODO 移除` : '';
        if (await confirm(`刪除標籤「${tag.name}」${hint}？`)) {
          await this.commitOrWarn(removeTag(collection, message.id, now), '找不到這個標籤。');
        }
        return;
      }
      case 'setRatio':
        await this.context.globalState.update(RATIO_KEY, clampRatio(message.ratio));
        return;
    }
  }

  /** 純函式回 undefined 代表操作不允許；提示原因並把目前狀態重送，讓 webview 的畫面退回原樣。 */
  private async commitOrWarn(next: Collection | undefined, reason: string): Promise<void> {
    if (next) {
      await this.commit(next);
    } else {
      void vscode.window.showWarningMessage(`todooo：${reason}`);
      this.postState();
    }
  }

  /**
   * 讓使用者挑資料夾，把這個 Collection 的檔案搬過去，再把對照表寫進使用者設定。
   * 設定層級固定是 Global：保存位置跟著使用者走，開哪個工作區都一樣。
   */
  private async relocate(target: Collection): Promise<void> {
    const current = this.store.folderFor(target.id);
    const defaultDir = collectionsDir();
    type Choice = vscode.QuickPickItem & { action: 'choose' | 'reset' };
    const choices: Choice[] = [
      { label: '$(folder-opened) 選擇資料夾…', description: '把這個 Collection 的 JSON 搬到指定的資料夾', action: 'choose' },
    ];
    if (this.store.hasCustomFolder(target.id)) {
      choices.push({ label: '$(home) 改回預設資料夾', description: collapseHome(defaultDir), action: 'reset' });
    }
    const picked = await vscode.window.showQuickPick(choices, {
      title: `「${target.name}」的保存位置`,
      placeHolder: `目前保存在 ${collapseHome(current)}`,
    });
    if (!picked) {
      return;
    }
    let folder: string | undefined;
    if (picked.action === 'choose') {
      const uris = await vscode.window.showOpenDialog({
        title: `「${target.name}」要保存到哪個資料夾`,
        openLabel: '保存到這個資料夾',
        defaultUri: vscode.Uri.file(current),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!uris || uris.length === 0) {
        return;
      }
      folder = uris[0].fsPath;
      if (path.resolve(folder) === path.resolve(defaultDir)) {
        folder = undefined;
      }
    }
    const previous = this.store.hasCustomFolder(target.id) ? this.store.folderFor(target.id) : undefined;
    const folders = await this.store.relocate(target, folder);
    try {
      await vscode.workspace.getConfiguration().update(FOLDERS_SETTING, storedFolders(folders), vscode.ConfigurationTarget.Global);
    } catch (error) {
      // 設定寫不進去（例如使用者設定檔有未存的變更）就把檔案搬回原處：設定沒指向新位置，留在那裡這份 Collection 會從面板消失。
      await new CollectionStore(defaultDir, folders).relocate(target, previous);
      throw new Error(`${error instanceof Error ? error.message : String(error)}（檔案已搬回原處）`);
    }
    this.store = new CollectionStore(defaultDir, folders);
    // 新 store 還沒記任何版本號，重讀一次讓後續寫入有得比。
    await this.reload();
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'styles.css'));
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>todooo</title>
</head>
<body>
  <header id="bar">
    <div class="collection">
      <select id="collection" title="切換 Collection"></select>
      <button type="button" id="col-add" title="新增 Collection">＋</button>
      <button type="button" id="col-rename" title="重新命名 Collection">✎</button>
      <button type="button" id="col-delete" title="刪除 Collection">🗑</button>
      <button type="button" id="col-folder" title="設定保存位置">📁</button>
    </div>
    <select id="filter" title="依狀態篩選左側列表"></select>
    <input id="search" type="search" placeholder="搜尋標題或內容" title="關鍵字搜尋，標題或內容含有就算">
    <button type="button" id="refresh" title="刷新：重新讀取磁碟上的 Collection 與最後一次變更的畫面狀態">↻</button>
  </header>
  <main id="main">
    <section id="left">
      <div class="toolbar">
        <button type="button" id="item-add" class="primary">＋ 新增 TODO</button>
        <span id="count"></span>
      </div>
      <ul id="items"></ul>
    </section>
    <div id="splitter" title="拖曳調整左右比例"></div>
    <section id="right">
      <p id="placeholder" class="placeholder">點擊左側的 TODO 項目，這裡會顯示細節。</p>
      <div id="detail" hidden>
        <div class="detail-bar">
          <div class="detail-actions">
            <button type="button" id="expand" title="展開細節，隱藏左側列表">展開</button>
            <button type="button" id="child-add" title="在這個 TODO 底下新增子項目">＋ 子項目</button>
            <span id="parent-title" class="muted" hidden></span>
          </div>
          <button type="button" id="item-delete" class="danger" title="刪除這個 TODO">刪除</button>
        </div>
        <label class="field">
          <span class="label">標題 <span id="title-count" class="muted"></span></span>
          <input id="item-title" type="text" maxlength="120" placeholder="標題（120 字內）">
        </label>
        <div class="row">
          <label class="field">
            <span class="label">狀態</span>
            <select id="item-status"></select>
          </label>
          <label class="field">
            <span class="label">分類 <button type="button" id="manage-categories" class="link">管理</button></span>
            <select id="item-category"></select>
          </label>
        </div>
        <label class="field" id="conclusion-field" hidden>
          <span class="label">結論 <span id="conclusion-count" class="muted"></span></span>
          <input id="item-conclusion" type="text" maxlength="512" placeholder="結論（512 字內）">
        </label>
        <div class="field" id="tags-field" hidden>
          <span class="label">標籤 <button type="button" id="manage-tags" class="link">管理</button></span>
          <button type="button" id="tags-toggle" class="multiselect-toggle" aria-haspopup="listbox" aria-expanded="false" title="選擇標籤（可多選）">
            <span id="tags-value" class="multiselect-value"></span>
            <span class="multiselect-arrow" aria-hidden="true">▾</span>
          </button>
        </div>
        <div id="manage" hidden></div>
        <div class="row">
          <label class="field">
            <span class="label">創建時間</span>
            <input id="item-created" type="datetime-local">
          </label>
          <div class="field">
            <span class="label">完成時間</span>
            <span id="item-completed" class="readonly"></span>
          </div>
        </div>
        <label class="field grow">
          <span class="label">內容</span>
          <textarea id="item-content" placeholder="內容"></textarea>
        </label>
      </div>
    </section>
  </main>
  <div id="tags-menu" class="multiselect-menu" role="listbox" aria-label="標籤" hidden></div>
  <div id="tooltip" class="tooltip" role="tooltip" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** 資料夾根：底下放 `collections/` 與 `ui-state.json`。 */
function dataDir(): string {
  const configured = vscode.workspace.getConfiguration().get<string>(DATA_FOLDER_SETTING, '').trim();
  return configured ? expandHome(configured) : path.join(os.homedir(), '.todooo');
}

function collectionsDir(): string {
  return path.join(dataDir(), 'collections');
}

function reportError(error: unknown): void {
  void vscode.window.showErrorMessage(`todooo：${error instanceof Error ? error.message : String(error)}`);
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** 顯示與寫進設定時把家目錄縮成 `~`，換機器時設定檔比較好搬。 */
function collapseHome(value: string): string {
  const home = os.homedir();
  if (value === home) {
    return '~';
  }
  return value.startsWith(`${home}${path.sep}`) ? `~/${value.slice(home.length + 1)}` : value;
}

/** 讀設定裡個別 Collection 的保存資料夾；鍵不是合法 id、值不是字串的都略過。 */
function collectionFolders(): CollectionFolders {
  const raw = vscode.workspace.getConfiguration().get<unknown>(FOLDERS_SETTING);
  const folders: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isSafeIdSegment(id) && typeof value === 'string' && value.trim()) {
        folders[id] = expandHome(value.trim());
      }
    }
  }
  return folders;
}

function storedFolders(folders: CollectionFolders): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const [id, folder] of Object.entries(folders)) {
    stored[id] = collapseHome(folder);
  }
  return stored;
}

async function askName(prompt: string, value?: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (text) => {
      const clean = text.trim();
      if (!clean) {
        return '名稱不可為空';
      }
      return clean.length > NAME_MAX ? `名稱最多 ${NAME_MAX} 字` : undefined;
    },
  });
  return input?.trim();
}

async function confirm(message: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(`todooo：${message}`, { modal: true }, '刪除');
  return answer === '刪除';
}
