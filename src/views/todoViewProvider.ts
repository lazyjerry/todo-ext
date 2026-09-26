import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { createId } from '../core/ids';
import type { Collection } from '../core/model';
import {
  addCategory,
  addTag,
  applyItemPatch,
  createCollection,
  createItem,
  DEFAULT_COLLECTION_NAME,
  NAME_MAX,
  removeCategory,
  removeItem,
  removeTag,
  renameCategory,
  renameCollection,
  setCollectionTitle,
  updateTag,
  withItem,
} from '../core/model';
import { CollectionStore } from '../core/store';
import type { ClientMessage, HostMessage } from '../shared/protocol';
import { clampRatio, isClientMessage } from '../shared/protocol';

const SELECTED_KEY = 'todooo.selectedCollection';
const RATIO_KEY = 'todooo.ratio';
const DATA_FOLDER_SETTING = 'todooo.dataFolder';

/**
 * 底部 Panel 裡的 view。收起再打開時 webview 保留（retainContextWhenHidden），
 * 資料狀態一律留在 provider 上，view 被 VS Code 回收重建也照樣接得回來。
 */
export class TodoViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'todooo.panel';

  private view: vscode.WebviewView | undefined;
  private store: CollectionStore;
  private collections: Collection[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  /** 序列化所有會改資料的操作，避免兩則訊息交錯寫同一份檔案。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new CollectionStore(collectionsDir());
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(DATA_FOLDER_SETTING)) {
          this.store = new CollectionStore(collectionsDir());
          this.enqueue(() => this.reload());
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
    // 面板收起再打開時重讀磁碟：別的視窗可能改過。
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.enqueue(() => this.reload());
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
    this.queue = this.queue.then(task).catch((error: unknown) => {
      void vscode.window.showErrorMessage(`todooo：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private get selectedId(): string | undefined {
    const stored = this.context.globalState.get<unknown>(SELECTED_KEY);
    return typeof stored === 'string' ? stored : undefined;
  }

  private get ratio(): number {
    return clampRatio(this.context.globalState.get<unknown>(RATIO_KEY));
  }

  private get selected(): Collection | undefined {
    return this.collections.find((collection) => collection.id === this.selectedId) ?? this.collections[0];
  }

  /** 重讀全部 Collection；一份都沒有就建預設的那份，面板永遠至少有一個 Collection。 */
  private async reload(focusItemId?: string): Promise<void> {
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
    const selected = this.selected!;
    if (selected.id !== this.selectedId) {
      await this.context.globalState.update(SELECTED_KEY, selected.id);
    }
    this.postState(focusItemId);
  }

  private postState(focusItemId?: string): void {
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
      focusItemId,
    });
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** 把改好的 Collection 寫回磁碟並更新記憶體中的那份，再把整個狀態送給 webview。 */
  private async commit(collection: Collection, focusItemId?: string): Promise<void> {
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

  private async select(id: string): Promise<void> {
    await this.context.globalState.update(SELECTED_KEY, id);
    this.postState();
  }

  private async handle(message: ClientMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.reload();
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
        await this.store.remove(target.id);
        this.collections = this.collections.filter((entry) => entry.id !== target.id);
        await this.select(this.collections[0].id);
        return;
      }
      case 'setTitle':
        await this.commit(setCollectionTitle(collection, message.title, now));
        return;
      case 'createItem': {
        const item = createItem(createId('todo'), collection, now);
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
      case 'deleteItem': {
        const item = collection.items.find((entry) => entry.id === message.id);
        if (!item) {
          return;
        }
        if (await confirm(`刪除 TODO「${item.title || '（無標題）'}」？此動作無法復原。`)) {
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
    </div>
    <input id="title" type="text" maxlength="120" placeholder="大標題" title="大標題，預設為建立當天的日期">
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
          <button type="button" id="expand" title="展開細節，隱藏左側列表">展開</button>
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
        <div class="field">
          <span class="label">標籤 <button type="button" id="manage-tags" class="link">管理</button></span>
          <div id="item-tags" class="chips"></div>
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function collectionsDir(): string {
  const configured = vscode.workspace.getConfiguration().get<string>(DATA_FOLDER_SETTING, '').trim();
  const base = configured ? expandHome(configured) : path.join(os.homedir(), '.todooo');
  return path.join(base, 'collections');
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
