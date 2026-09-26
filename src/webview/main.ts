import type { Collection, ItemPatch, Tag, TagColor, TodoItem } from '../core/model';
import { STATUSES, TAG_COLORS, TITLE_MAX } from '../core/model';
import type { ClientMessage, HostMessage } from '../shared/protocol';
import { clampRatio } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void };

type StateMessage = Extract<HostMessage, { type: 'state' }>;

const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  collection: $<HTMLSelectElement>('collection'),
  colAdd: $<HTMLButtonElement>('col-add'),
  colRename: $<HTMLButtonElement>('col-rename'),
  colDelete: $<HTMLButtonElement>('col-delete'),
  title: $<HTMLInputElement>('title'),
  main: $<HTMLElement>('main'),
  left: $<HTMLElement>('left'),
  splitter: $<HTMLElement>('splitter'),
  itemAdd: $<HTMLButtonElement>('item-add'),
  count: $<HTMLElement>('count'),
  items: $<HTMLUListElement>('items'),
  placeholder: $<HTMLElement>('placeholder'),
  detail: $<HTMLElement>('detail'),
  expand: $<HTMLButtonElement>('expand'),
  itemDelete: $<HTMLButtonElement>('item-delete'),
  itemTitle: $<HTMLInputElement>('item-title'),
  titleCount: $<HTMLElement>('title-count'),
  itemStatus: $<HTMLSelectElement>('item-status'),
  itemCategory: $<HTMLSelectElement>('item-category'),
  manageCategories: $<HTMLButtonElement>('manage-categories'),
  manageTags: $<HTMLButtonElement>('manage-tags'),
  itemTags: $<HTMLElement>('item-tags'),
  manage: $<HTMLElement>('manage'),
  itemCreated: $<HTMLInputElement>('item-created'),
  itemCompleted: $<HTMLElement>('item-completed'),
  itemContent: $<HTMLTextAreaElement>('item-content'),
};

const STATUS_LABEL: Record<string, string> = {};
STATUSES.forEach((status, index) => {
  STATUS_LABEL[status] = `st-${index}`;
});

const COLOR_LABEL: Record<TagColor, string> = {
  gray: '灰',
  brown: '棕',
  orange: '橙',
  yellow: '黃',
  green: '綠',
  blue: '藍',
  purple: '紫',
  pink: '粉',
  red: '紅',
};

let state: StateMessage | null = null;
let selectedItemId: string | null = null;
let expanded = false;
let manageMode: 'categories' | 'tags' | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const post = (message: ClientMessage): void => vscode.postMessage(message);

/** 打字類欄位合併 300ms 再送；失焦時立刻送。 */
function debounce(key: string, run: () => void, delay = 300): void {
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      run();
    }, delay),
  );
}

function flush(key: string): void {
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    timers.delete(key);
  }
}

function isFocused(element: Element): boolean {
  return document.activeElement === element;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// ---------- 日期 ----------

const pad = (n: number): string => String(n).padStart(2, '0');

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local 要的是本機時間、沒有時區的字串。 */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// ---------- 畫面 ----------

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'empty') {
    state = null;
    els.items.replaceChildren(el('li', { className: 'placeholder', textContent: message.reason }));
    return;
  }
  state = message;
  if (message.focusItemId) {
    selectedItemId = message.focusItemId;
    manageMode = null;
  }
  render();
  if (message.focusItemId) {
    els.itemTitle.focus();
  }
});

function render(): void {
  if (!state) {
    return;
  }
  const { collection } = state;
  applyRatio(state.ratio);
  renderHeader(state);
  renderList(collection);
  renderDetail(collection);
}

function renderHeader(current: StateMessage): void {
  els.collection.replaceChildren(
    ...current.collections.map((summary) =>
      el('option', { value: summary.id, textContent: summary.name, selected: summary.id === current.collection.id }),
    ),
  );
  els.colDelete.disabled = current.collections.length <= 1;
  els.colDelete.title = els.colDelete.disabled ? '至少需保留一個 Collection' : '刪除 Collection';
  if (!isFocused(els.title)) {
    els.title.value = current.collection.title;
  }
}

function sortedItems(collection: Collection): TodoItem[] {
  return [...collection.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function renderList(collection: Collection): void {
  const items = sortedItems(collection);
  els.count.textContent = `${items.length} 項`;
  if (!items.some((item) => item.id === selectedItemId)) {
    selectedItemId = null;
  }
  const categoryName = new Map(collection.categories.map((category) => [category.id, category.name]));
  const tagById = new Map(collection.tags.map((tag) => [tag.id, tag]));
  els.items.replaceChildren(
    ...items.map((item) => {
      const meta = el('div', { className: 'meta' });
      meta.append(el('span', { className: 'category', textContent: categoryName.get(item.categoryId) ?? '' }));
      for (const tagId of item.tagIds) {
        const tag = tagById.get(tagId);
        if (tag) {
          meta.append(chip(tag));
        }
      }
      meta.append(el('span', { className: 'muted date', textContent: formatDateTime(item.createdAt) }));
      const row = el(
        'li',
        { className: `item${item.id === selectedItemId ? ' selected' : ''}` },
        el('div', { className: 'line' }, statusPill(item.status), el('span', { className: 'item-title', textContent: item.title || '（無標題）' })),
        meta,
      );
      row.dataset.id = item.id;
      row.addEventListener('click', () => {
        selectedItemId = item.id;
        manageMode = null;
        render();
      });
      return row;
    }),
  );
  if (items.length === 0) {
    els.items.append(el('li', { className: 'placeholder', textContent: '還沒有 TODO，按上方「新增 TODO」開始。' }));
  }
}

function statusPill(status: string): HTMLElement {
  return el('span', { className: `status ${STATUS_LABEL[status] ?? ''}`, textContent: status });
}

function chip(tag: Tag, extra = ''): HTMLElement {
  return el('span', { className: `tag c-${tag.color}${extra}`, textContent: tag.name });
}

function currentItem(): TodoItem | undefined {
  return state?.collection.items.find((item) => item.id === selectedItemId);
}

function renderDetail(collection: Collection): void {
  const item = currentItem();
  els.placeholder.hidden = !!item;
  els.detail.hidden = !item;
  document.body.classList.toggle('expanded', expanded && !!item);
  els.expand.textContent = expanded ? '收合' : '展開';
  if (!item) {
    if (expanded) {
      expanded = false;
      document.body.classList.remove('expanded');
    }
    return;
  }

  if (!isFocused(els.itemTitle)) {
    els.itemTitle.value = item.title;
  }
  updateTitleCount();

  els.itemStatus.replaceChildren(...STATUSES.map((status) => el('option', { value: status, textContent: status, selected: status === item.status })));
  els.itemStatus.className = STATUS_LABEL[item.status] ?? '';

  els.itemCategory.replaceChildren(
    ...collection.categories.map((category) => el('option', { value: category.id, textContent: category.name, selected: category.id === item.categoryId })),
  );

  els.itemTags.replaceChildren(
    ...collection.tags.map((tag) => {
      const selected = item.tagIds.includes(tag.id);
      const button = el('button', { type: 'button', className: `tag c-${tag.color}${selected ? ' on' : ' off'}`, textContent: tag.name });
      button.title = selected ? '點一下移除這個標籤' : '點一下加上這個標籤';
      button.setAttribute('aria-pressed', String(selected));
      button.addEventListener('click', () => {
        const tagIds = selected ? item.tagIds.filter((tagId) => tagId !== tag.id) : [...item.tagIds, tag.id];
        post({ type: 'updateItem', id: item.id, patch: { tagIds } });
      });
      return button;
    }),
  );
  if (collection.tags.length === 0) {
    els.itemTags.append(el('span', { className: 'muted', textContent: '還沒有標籤，按「管理」新增。' }));
  }

  renderManage(collection);

  if (!isFocused(els.itemCreated)) {
    els.itemCreated.value = toLocalInput(item.createdAt);
  }
  els.itemCompleted.textContent = item.completedAt ? formatDateTime(item.completedAt) : '—';

  if (!isFocused(els.itemContent)) {
    els.itemContent.value = item.content;
  }
}

function updateTitleCount(): void {
  els.titleCount.textContent = `${els.itemTitle.value.length} / ${TITLE_MAX}`;
}

/** 分類與標籤的管理區：每列一個名稱輸入框，改了就送；最後一列用來新增。 */
function renderManage(collection: Collection): void {
  els.manage.hidden = manageMode === null;
  els.manageCategories.classList.toggle('active', manageMode === 'categories');
  els.manageTags.classList.toggle('active', manageMode === 'tags');
  if (manageMode === null) {
    els.manage.replaceChildren();
    return;
  }
  // 使用者正在管理區裡打字時不重畫，免得輸入框被換掉。
  if (els.manage.contains(document.activeElement)) {
    return;
  }
  const rows: HTMLElement[] = [];
  if (manageMode === 'categories') {
    rows.push(el('div', { className: 'manage-title', textContent: '分類（一次只能選一個，至少保留一個）' }));
    for (const category of collection.categories) {
      const name = el('input', { type: 'text', value: category.name, maxLength: 60 });
      name.addEventListener('change', () => {
        if (name.value.trim() !== category.name) {
          post({ type: 'renameCategory', id: category.id, name: name.value });
        }
        name.blur();
      });
      const remove = el('button', { type: 'button', className: 'danger', textContent: '刪除', disabled: collection.categories.length <= 1 });
      remove.addEventListener('click', () => post({ type: 'deleteCategory', id: category.id }));
      rows.push(el('div', { className: 'manage-row' }, name, remove));
    }
    const newName = el('input', { type: 'text', placeholder: '新分類名稱', maxLength: 60 });
    const add = el('button', { type: 'button', className: 'primary', textContent: '新增' });
    const submit = () => {
      if (newName.value.trim()) {
        post({ type: 'createCategory', name: newName.value });
        newName.value = '';
        newName.blur();
      }
    };
    add.addEventListener('click', submit);
    newName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    rows.push(el('div', { className: 'manage-row' }, newName, add));
  } else {
    rows.push(el('div', { className: 'manage-title', textContent: '標籤（可多選，顏色與文字自訂）' }));
    for (const tag of collection.tags) {
      const color = colorSelect(tag.color);
      color.addEventListener('change', () => post({ type: 'updateTag', id: tag.id, color: color.value as TagColor }));
      const name = el('input', { type: 'text', value: tag.name, maxLength: 60 });
      name.addEventListener('change', () => {
        if (name.value.trim() !== tag.name) {
          post({ type: 'updateTag', id: tag.id, name: name.value });
        }
        name.blur();
      });
      const remove = el('button', { type: 'button', className: 'danger', textContent: '刪除' });
      remove.addEventListener('click', () => post({ type: 'deleteTag', id: tag.id }));
      rows.push(el('div', { className: 'manage-row' }, chip(tag, ' preview'), color, name, remove));
    }
    const newColor = colorSelect('blue');
    const newName = el('input', { type: 'text', placeholder: '新標籤名稱', maxLength: 60 });
    const add = el('button', { type: 'button', className: 'primary', textContent: '新增' });
    const submit = () => {
      if (newName.value.trim()) {
        post({ type: 'createTag', name: newName.value, color: newColor.value as TagColor });
        newName.value = '';
        newName.blur();
      }
    };
    add.addEventListener('click', submit);
    newName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    rows.push(el('div', { className: 'manage-row' }, el('span', { className: 'tag c-blue preview', textContent: '新' }), newColor, newName, add));
  }
  els.manage.replaceChildren(...rows);
}

function colorSelect(current: TagColor): HTMLSelectElement {
  const select = el('select', { className: `color c-${current}` });
  select.title = '標籤顏色';
  for (const color of TAG_COLORS) {
    select.append(el('option', { value: color, textContent: COLOR_LABEL[color], selected: color === current }));
  }
  select.addEventListener('change', () => {
    select.className = `color c-${select.value}`;
  });
  return select;
}

// ---------- 左右比例 ----------

function applyRatio(ratio: number): void {
  els.main.style.setProperty('--ratio', String(clampRatio(ratio)));
}

els.splitter.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  els.splitter.setPointerCapture(event.pointerId);
  document.body.classList.add('dragging');
  let ratio = state?.ratio ?? 0.6;
  const move = (moveEvent: PointerEvent) => {
    const rect = els.main.getBoundingClientRect();
    if (rect.width > 0) {
      ratio = clampRatio((moveEvent.clientX - rect.left) / rect.width);
      applyRatio(ratio);
    }
  };
  const up = () => {
    els.splitter.removeEventListener('pointermove', move);
    els.splitter.removeEventListener('pointerup', up);
    els.splitter.removeEventListener('pointercancel', up);
    document.body.classList.remove('dragging');
    if (state) {
      state.ratio = ratio;
    }
    post({ type: 'setRatio', ratio });
  };
  els.splitter.addEventListener('pointermove', move);
  els.splitter.addEventListener('pointerup', up);
  els.splitter.addEventListener('pointercancel', up);
});

// ---------- 事件 ----------

els.collection.addEventListener('change', () => {
  selectedItemId = null;
  manageMode = null;
  post({ type: 'selectCollection', id: els.collection.value });
});
els.colAdd.addEventListener('click', () => post({ type: 'createCollection' }));
els.colRename.addEventListener('click', () => {
  if (state) {
    post({ type: 'renameCollection', id: state.collection.id });
  }
});
els.colDelete.addEventListener('click', () => {
  if (state) {
    post({ type: 'deleteCollection', id: state.collection.id });
  }
});

els.title.addEventListener('input', () => debounce('title', () => post({ type: 'setTitle', title: els.title.value })));
els.title.addEventListener('blur', () => {
  flush('title');
  if (state && els.title.value.trim() !== state.collection.title) {
    post({ type: 'setTitle', title: els.title.value });
  }
});

els.itemAdd.addEventListener('click', () => post({ type: 'createItem' }));
els.itemDelete.addEventListener('click', () => {
  if (selectedItemId) {
    post({ type: 'deleteItem', id: selectedItemId });
  }
});
els.expand.addEventListener('click', () => {
  expanded = !expanded;
  render();
});

function patchCurrent(patch: ItemPatch): void {
  if (selectedItemId) {
    post({ type: 'updateItem', id: selectedItemId, patch });
  }
}

els.itemTitle.addEventListener('input', () => {
  updateTitleCount();
  const id = selectedItemId;
  const title = els.itemTitle.value;
  debounce(`title:${id}`, () => {
    if (id) {
      post({ type: 'updateItem', id, patch: { title } });
    }
  });
});
els.itemTitle.addEventListener('blur', () => {
  flush(`title:${selectedItemId}`);
  const item = currentItem();
  if (item && els.itemTitle.value.trim() !== item.title) {
    patchCurrent({ title: els.itemTitle.value });
  }
});
els.itemTitle.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.itemContent.focus();
  }
});

els.itemContent.addEventListener('input', () => {
  const id = selectedItemId;
  const content = els.itemContent.value;
  debounce(`content:${id}`, () => {
    if (id) {
      post({ type: 'updateItem', id, patch: { content } });
    }
  });
});
els.itemContent.addEventListener('blur', () => {
  flush(`content:${selectedItemId}`);
  const item = currentItem();
  if (item && els.itemContent.value !== item.content) {
    patchCurrent({ content: els.itemContent.value });
  }
});

els.itemStatus.addEventListener('change', () => patchCurrent({ status: els.itemStatus.value as TodoItem['status'] }));
els.itemCategory.addEventListener('change', () => patchCurrent({ categoryId: els.itemCategory.value }));
els.itemCreated.addEventListener('change', () => {
  const iso = fromLocalInput(els.itemCreated.value);
  if (iso) {
    patchCurrent({ createdAt: iso });
  } else if (state) {
    // 清空欄位不算改：退回原值，創建時間不可為空。
    renderDetail(state.collection);
  }
});

els.manageCategories.addEventListener('click', () => {
  manageMode = manageMode === 'categories' ? null : 'categories';
  if (state) {
    renderManage(state.collection);
  }
});
els.manageTags.addEventListener('click', () => {
  manageMode = manageMode === 'tags' ? null : 'tags';
  if (state) {
    renderManage(state.collection);
  }
});

post({ type: 'ready' });
