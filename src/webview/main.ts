import type { FilterKey } from '../core/filter';
import { FILTERS, filterItems, isFilterKey } from '../core/filter';
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
  colFolder: $<HTMLButtonElement>('col-folder'),
  filter: $<HTMLSelectElement>('filter'),
  search: $<HTMLInputElement>('search'),
  main: $<HTMLElement>('main'),
  left: $<HTMLElement>('left'),
  right: $<HTMLElement>('right'),
  splitter: $<HTMLElement>('splitter'),
  itemAdd: $<HTMLButtonElement>('item-add'),
  count: $<HTMLElement>('count'),
  items: $<HTMLUListElement>('items'),
  placeholder: $<HTMLElement>('placeholder'),
  detail: $<HTMLElement>('detail'),
  expand: $<HTMLButtonElement>('expand'),
  childAdd: $<HTMLButtonElement>('child-add'),
  parentTitle: $<HTMLElement>('parent-title'),
  itemDelete: $<HTMLButtonElement>('item-delete'),
  itemTitle: $<HTMLInputElement>('item-title'),
  titleCount: $<HTMLElement>('title-count'),
  itemStatus: $<HTMLSelectElement>('item-status'),
  itemCategory: $<HTMLSelectElement>('item-category'),
  manageCategories: $<HTMLButtonElement>('manage-categories'),
  manageTags: $<HTMLButtonElement>('manage-tags'),
  tagsField: $<HTMLElement>('tags-field'),
  tagsToggle: $<HTMLButtonElement>('tags-toggle'),
  tagsValue: $<HTMLElement>('tags-value'),
  tagsMenu: $<HTMLElement>('tags-menu'),
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
/** 分類與標籤共用一個管理區，兩個「管理」連結都開同一塊。 */
let manageOpen = false;
let tagsMenuOpen = false;
/** 列表篩選只在畫面端：不經過主機、不存檔。 */
let filter: FilterKey = 'all';
let query = '';
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
    manageOpen = false;
    closeTagsMenu();
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
  // 拖曳中不重畫列表，免得正在拖的那一列被換掉；放開後補畫。
  if (dragId) {
    renderAfterDrag = true;
  } else {
    renderList(collection);
  }
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
  els.colFolder.title = `保存位置：${current.folder}${current.customFolder ? '' : '（預設）'}\n點一下更改`;
  els.colFolder.classList.toggle('custom', current.customFolder);
}

/** items 的陣列順序就是畫面順序（頂層項目後面緊接子項目），這裡照著畫，不另外排序；篩選只決定哪些列要畫。 */
function renderList(collection: Collection): void {
  const items = collection.items;
  const visible = filterItems(items, filter, query);
  const filtering = filter !== 'all' || query.trim() !== '';
  els.count.textContent = filtering ? `${visible.length} / ${items.length} 項` : `${items.length} 項`;
  if (!items.some((item) => item.id === selectedItemId)) {
    selectedItemId = null;
  }
  const categoryName = new Map(collection.categories.map((category) => [category.id, category.name]));
  const tagById = new Map(collection.tags.map((tag) => [tag.id, tag]));
  const parents = new Set(items.map((item) => item.parentId).filter((parentId): parentId is string => parentId !== null));
  els.items.replaceChildren(
    ...visible.map(({ item, context }) => {
      const line = el(
        'div',
        { className: 'line' },
        statusPill(item.status),
        el('span', { className: 'item-title', textContent: item.title || '（無標題）' }),
        el('span', { className: 'category', textContent: categoryName.get(item.categoryId) ?? '' }),
        el('span', { className: 'muted date', textContent: formatDateTime(item.createdAt) }),
      );
      const classes = ['item', item.parentId === null ? 'depth-0' : 'depth-1'];
      if (item.id === selectedItemId) {
        classes.push('selected');
      }
      if (parents.has(item.id)) {
        classes.push('parent');
      }
      if (context) {
        classes.push('context');
      }
      const row = el('li', { className: classes.join(' '), draggable: true }, line);
      const tags = item.tagIds.map((tagId) => tagById.get(tagId)).filter((tag): tag is Tag => !!tag);
      if (tags.length > 0) {
        row.append(el('div', { className: 'tags' }, ...tags.map((tag) => chip(tag))));
      }
      row.dataset.id = item.id;
      row.dataset.parent = item.parentId ?? '';
      row.addEventListener('click', () => {
        selectedItemId = item.id;
        manageOpen = false;
        closeTagsMenu();
        render();
      });
      row.addEventListener('dragstart', (event) => startDrag(item.id, event));
      row.addEventListener('dragend', finishDrag);
      return row;
    }),
  );
  if (items.length === 0) {
    els.items.append(el('li', { className: 'placeholder', textContent: '還沒有 TODO，按上方「新增 TODO」開始。' }));
  } else if (visible.length === 0) {
    els.items.append(el('li', { className: 'placeholder', textContent: '沒有符合篩選條件的 TODO。' }));
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
    closeTagsMenu();
    return;
  }

  const parent = item.parentId === null ? undefined : collection.items.find((entry) => entry.id === item.parentId);
  els.parentTitle.hidden = !parent;
  els.parentTitle.textContent = parent ? `上層：${parent.title || '（無標題）'}` : '';
  els.childAdd.disabled = !!parent;
  els.childAdd.title = parent ? '子項目底下不能再放子項目' : '在這個 TODO 底下新增子項目';

  if (!isFocused(els.itemTitle)) {
    els.itemTitle.value = item.title;
  }
  updateTitleCount();

  els.itemStatus.replaceChildren(...STATUSES.map((status) => el('option', { value: status, textContent: status, selected: status === item.status })));
  els.itemStatus.className = STATUS_LABEL[item.status] ?? '';

  els.itemCategory.replaceChildren(
    ...collection.categories.map((category) => el('option', { value: category.id, textContent: category.name, selected: category.id === item.categoryId })),
  );

  renderTags(collection, item);
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

// ---------- 標籤多選下拉 ----------

/** Collection 沒有標籤時整個欄位不顯示；要建標籤走「分類」旁的「管理」。 */
function renderTags(collection: Collection, item: TodoItem): void {
  els.tagsField.hidden = collection.tags.length === 0;
  if (collection.tags.length === 0) {
    closeTagsMenu();
    return;
  }
  const selected = collection.tags.filter((tag) => item.tagIds.includes(tag.id));
  els.tagsValue.replaceChildren(...selected.map((tag) => chip(tag)));
  if (selected.length === 0) {
    els.tagsValue.append(el('span', { className: 'muted', textContent: '選擇標籤' }));
  }
  fitChips(els.tagsValue);
  els.tagsToggle.setAttribute('aria-expanded', String(tagsMenuOpen));
  if (tagsMenuOpen) {
    renderTagsMenu(collection, item);
  }
}

/** 欄位固定一行：只留塞得下的標籤，其餘收成「+N」。 */
function fitChips(container: HTMLElement): void {
  const chips = Array.from(container.children) as HTMLElement[];
  const overflowing = () => container.scrollWidth > container.clientWidth;
  if (container.clientWidth === 0 || chips.length <= 1 || !overflowing()) {
    return;
  }
  const more = el('span', { className: 'tag more' });
  container.append(more);
  let hidden = 0;
  for (let index = chips.length - 1; index > 0 && overflowing(); index -= 1) {
    chips[index].hidden = true;
    hidden += 1;
    more.textContent = `+${hidden}`;
  }
}

function renderTagsMenu(collection: Collection, item: TodoItem): void {
  els.tagsMenu.replaceChildren(
    ...collection.tags.map((tag) => {
      const box = el('input', { type: 'checkbox', checked: item.tagIds.includes(tag.id) });
      box.addEventListener('change', () => {
        const tagIds = box.checked ? [...item.tagIds, tag.id] : item.tagIds.filter((tagId) => tagId !== tag.id);
        post({ type: 'updateItem', id: item.id, patch: { tagIds } });
      });
      return el('label', { className: 'multiselect-option' }, box, chip(tag));
    }),
  );
  els.tagsMenu.hidden = false;
  positionTagsMenu();
}

/** 選單用 fixed 定位貼在按鈕下方，不被右欄的捲動範圍裁掉；下方不夠高就往上開。 */
function positionTagsMenu(): void {
  const rect = els.tagsToggle.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 8;
  const above = rect.top - 8;
  const menu = els.tagsMenu.style;
  menu.left = `${rect.left}px`;
  menu.width = `${rect.width}px`;
  if (below >= 120 || below >= above) {
    menu.top = `${rect.bottom + 2}px`;
    menu.bottom = '';
    menu.maxHeight = `${Math.max(60, Math.min(220, below))}px`;
  } else {
    menu.top = '';
    menu.bottom = `${window.innerHeight - rect.top + 2}px`;
    menu.maxHeight = `${Math.max(60, Math.min(220, above))}px`;
  }
}

function closeTagsMenu(): void {
  tagsMenuOpen = false;
  els.tagsMenu.hidden = true;
  els.tagsMenu.replaceChildren();
  els.tagsToggle.setAttribute('aria-expanded', 'false');
}

els.tagsToggle.addEventListener('click', () => {
  tagsMenuOpen = !tagsMenuOpen;
  if (!tagsMenuOpen) {
    closeTagsMenu();
  }
  const item = currentItem();
  if (state && item) {
    renderTags(state.collection, item);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target as Node;
  if (tagsMenuOpen && !els.tagsMenu.contains(target) && !els.tagsToggle.contains(target)) {
    closeTagsMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && tagsMenuOpen) {
    closeTagsMenu();
    els.tagsToggle.focus();
  }
});

els.right.addEventListener('scroll', closeTagsMenu);
window.addEventListener('resize', closeTagsMenu);

// ---------- 分類與標籤管理區 ----------

/** 一個管理區兩段：分類在上、標籤在下。每列一個名稱輸入框，改了就送；最後一列用來新增。 */
function renderManage(collection: Collection): void {
  els.manage.hidden = !manageOpen;
  els.manageCategories.classList.toggle('active', manageOpen);
  els.manageTags.classList.toggle('active', manageOpen);
  if (!manageOpen) {
    els.manage.replaceChildren();
    return;
  }
  // 使用者正在管理區的輸入框裡打字時不重畫，免得輸入框被換掉。
  // 只認文字輸入框：Chromium 點按鈕也會給它焦點，若連按鈕、下拉都算，按「新增」「刪除」後畫面就不會刷新。
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && els.manage.contains(active)) {
    return;
  }
  els.manage.replaceChildren(...categoryRows(collection), ...tagRows(collection));
}

/** 輸入法組字中按 Enter 是在選字，不是送出；Chromium 這時也會發 key=Enter 的 keydown。 */
function isSubmitEnter(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229;
}

function submitOnEnter(input: HTMLInputElement, submit: () => void): void {
  input.addEventListener('keydown', (event) => {
    if (isSubmitEnter(event)) {
      event.preventDefault();
      submit();
    }
  });
}

function categoryRows(collection: Collection): HTMLElement[] {
  const rows: HTMLElement[] = [el('div', { className: 'manage-title', textContent: '分類（一次只能選一個，至少保留一個）' })];
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
  submitOnEnter(newName, submit);
  rows.push(el('div', { className: 'manage-row' }, newName, add));
  return rows;
}

function tagRows(collection: Collection): HTMLElement[] {
  const rows: HTMLElement[] = [el('div', { className: 'manage-title', textContent: '標籤（可多選，顏色與文字自訂）' })];
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
  submitOnEnter(newName, submit);
  rows.push(el('div', { className: 'manage-row' }, el('span', { className: 'tag c-blue preview', textContent: '新' }), newColor, newName, add));
  return rows;
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

// ---------- 拖曳排序 ----------

interface DropTarget {
  parentId: string | null;
  /** 在目標同層裡（不含被拖的那個）的位置。 */
  index: number;
  zone: 'before' | 'after' | 'into';
  row: HTMLElement;
}

let dragId: string | null = null;
let dropTarget: DropTarget | null = null;
let renderAfterDrag = false;

function startDrag(id: string, event: DragEvent): void {
  dragId = id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
  // 拖曳的殘影在 dragstart 當下截圖，淡化樣式晚一拍再加，殘影才不會跟著變淡。
  setTimeout(() => {
    for (const row of rowsOf(id)) {
      row.classList.add('dragging');
    }
  }, 0);
}

/** 這個項目的列，加上它的子項目的列：父項目拖動時整組一起淡化。 */
function rowsOf(id: string): HTMLElement[] {
  return Array.from(els.items.children).filter(
    (row): row is HTMLElement => row instanceof HTMLElement && (row.dataset.id === id || row.dataset.parent === id),
  );
}

function finishDrag(): void {
  dragId = null;
  dropTarget = null;
  clearIndicator();
  for (const row of Array.from(els.items.children)) {
    row.classList.remove('dragging');
  }
  if (renderAfterDrag) {
    renderAfterDrag = false;
    render();
  }
}

/**
 * 依滑鼠在目標列的高度算落點：頂層列分上／中／下三段（之前／變成子項目／之後），子項目列只分上下。
 * 帶著子項目的頂層項目只能留在頂層：只認頂層列的上下兩段，子項目列不當目標。
 */
function computeTarget(row: HTMLElement, clientY: number): DropTarget | null {
  if (!state || !dragId) {
    return null;
  }
  const items = state.collection.items;
  const target = items.find((entry) => entry.id === row.dataset.id);
  if (!target || target.id === dragId || target.parentId === dragId) {
    return null;
  }
  const heavy = items.some((entry) => entry.parentId === dragId);
  const rect = row.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  let zone: DropTarget['zone'];
  if (target.parentId === null && !heavy) {
    zone = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
  } else if (target.parentId === null) {
    zone = ratio < 0.5 ? 'before' : 'after';
  } else if (heavy) {
    return null;
  } else {
    zone = ratio < 0.5 ? 'before' : 'after';
  }
  if (zone === 'into') {
    const count = items.filter((entry) => entry.parentId === target.id && entry.id !== dragId).length;
    return { parentId: target.id, index: count, zone, row };
  }
  const siblings = items.filter((entry) => entry.parentId === target.parentId && entry.id !== dragId);
  const index = siblings.findIndex((entry) => entry.id === target.id) + (zone === 'after' ? 1 : 0);
  return { parentId: target.parentId, index, zone, row };
}

/** 放在列表最底下的空白處：接到頂層的最後面。 */
function endTarget(): DropTarget | null {
  if (!state || !dragId) {
    return null;
  }
  const rows = Array.from(els.items.children).filter((row): row is HTMLElement => row instanceof HTMLElement && !!row.dataset.id);
  const last = rows[rows.length - 1];
  if (!last) {
    return null;
  }
  const count = state.collection.items.filter((entry) => entry.parentId === null && entry.id !== dragId).length;
  return { parentId: null, index: count, zone: 'after', row: last };
}

function clearIndicator(): void {
  for (const row of Array.from(els.items.children)) {
    row.classList.remove('drop-before', 'drop-after', 'drop-into');
  }
}

function showIndicator(target: DropTarget | null): void {
  clearIndicator();
  if (!target) {
    return;
  }
  let row = target.row;
  // 頂層項目的「之後」是整組（含子項目）之後，線畫在它最後一個子項目底下。
  if (target.zone === 'after' && target.parentId === null) {
    let next = row.nextElementSibling;
    while (next instanceof HTMLElement && next.dataset.parent === target.row.dataset.id) {
      row = next;
      next = row.nextElementSibling;
    }
  }
  row.classList.add(`drop-${target.zone}`);
}

els.items.addEventListener('dragover', (event) => {
  if (!dragId) {
    return;
  }
  const element = event.target instanceof Element ? event.target : null;
  const row = element?.closest<HTMLElement>('li.item') ?? null;
  const target = row ? computeTarget(row, event.clientY) : endTarget();
  if (target?.row !== dropTarget?.row || target?.zone !== dropTarget?.zone || target?.index !== dropTarget?.index) {
    dropTarget = target;
    showIndicator(target);
  }
  if (target) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }
});

els.items.addEventListener('dragleave', (event) => {
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (!related || !els.items.contains(related)) {
    dropTarget = null;
    clearIndicator();
  }
});

els.items.addEventListener('drop', (event) => {
  if (!dragId || !dropTarget) {
    return;
  }
  event.preventDefault();
  post({ type: 'moveItem', id: dragId, parentId: dropTarget.parentId, index: dropTarget.index });
  finishDrag();
});

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
  manageOpen = false;
  closeTagsMenu();
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
els.colFolder.addEventListener('click', () => {
  if (state) {
    post({ type: 'setCollectionFolder', id: state.collection.id });
  }
});

els.filter.replaceChildren(...FILTERS.map((entry) => el('option', { value: entry.key, textContent: entry.label })));
els.filter.addEventListener('change', () => {
  filter = isFilterKey(els.filter.value) ? els.filter.value : 'all';
  if (state) {
    renderList(state.collection);
  }
});
els.search.addEventListener('input', () => {
  query = els.search.value;
  if (state) {
    renderList(state.collection);
  }
});

els.itemAdd.addEventListener('click', () => post({ type: 'createItem' }));
els.childAdd.addEventListener('click', () => {
  if (selectedItemId) {
    post({ type: 'createItem', parentId: selectedItemId });
  }
});
els.itemDelete.addEventListener('click', () => {
  if (selectedItemId) {
    post({ type: 'deleteItem', id: selectedItemId });
  }
});
els.expand.addEventListener('click', () => {
  expanded = !expanded;
  closeTagsMenu();
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
  if (isSubmitEnter(event)) {
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

function toggleManage(): void {
  manageOpen = !manageOpen;
  if (state) {
    renderManage(state.collection);
  }
}
els.manageCategories.addEventListener('click', toggleManage);
els.manageTags.addEventListener('click', toggleManage);

post({ type: 'ready' });
