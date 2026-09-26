/**
 * 資料模型與純函式。這裡不碰 vscode、不碰檔案系統，
 * 每個操作都回傳新的 Collection（或 undefined 表示不允許），方便單元測試。
 */

export const STATUSES = ['未完成', '已完成', '待測試', '待回覆', '失敗', '擱置'] as const;
export type Status = (typeof STATUSES)[number];

/** 切到這兩個狀態時記下完成時間。 */
export const DONE_STATUSES: ReadonlySet<Status> = new Set<Status>(['已完成', '失敗']);

/** 自訂標籤的顏色，對齊 Notion 的九色。 */
export const TAG_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const TITLE_MAX = 120;
export const NAME_MAX = 60;
export const DEFAULT_CATEGORY_NAME = '未分類';
export const DEFAULT_COLLECTION_NAME = '預設';
export const COLLECTION_VERSION = 1;

export interface Category {
  id: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
}

export interface TodoItem {
  id: string;
  /** 120 字內；允許空字串，畫面顯示成「（無標題）」。 */
  title: string;
  content: string;
  status: Status;
  categoryId: string;
  tagIds: string[];
  /** 子項目掛在哪個頂層項目底下；頂層項目為 null。只有兩層，子項目底下不能再放子項目。 */
  parentId: string | null;
  /** ISO 8601。 */
  createdAt: string;
  /** 狀態切成已完成／失敗時記下；切回其他狀態就清掉。 */
  completedAt: string | null;
  updatedAt: string;
}

export interface Collection {
  version: typeof COLLECTION_VERSION;
  id: string;
  name: string;
  /** 建立當天的日期。畫面已不顯示，欄位留著讓既有檔案照舊。 */
  title: string;
  categories: Category[];
  tags: Tag[];
  items: TodoItem[];
  createdAt: string;
  updatedAt: string;
}

export type ItemPatch = Partial<Pick<TodoItem, 'title' | 'content' | 'status' | 'categoryId' | 'tagIds' | 'createdAt'>>;

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
}

/** 本機時區的 YYYY-MM-DD。 */
export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function cleanName(name: string, max = NAME_MAX): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, max);
}

function hasName(list: readonly { id: string; name: string }[], name: string, exceptId?: string): boolean {
  return list.some((entry) => entry.id !== exceptId && entry.name === name);
}

function touch(collection: Collection, now: Date): Collection {
  return { ...collection, updatedAt: now.toISOString() };
}

// ---------- Collection ----------

export function createCollection(id: string, categoryId: string, name: string, now: Date): Collection {
  const iso = now.toISOString();
  return {
    version: COLLECTION_VERSION,
    id,
    name: cleanName(name) || DEFAULT_COLLECTION_NAME,
    title: formatDate(now),
    categories: [{ id: categoryId, name: DEFAULT_CATEGORY_NAME }],
    tags: [],
    items: [],
    createdAt: iso,
    updatedAt: iso,
  };
}

export function renameCollection(collection: Collection, name: string, now: Date): Collection | undefined {
  const clean = cleanName(name);
  if (!clean) {
    return undefined;
  }
  return touch({ ...collection, name: clean }, now);
}

// ---------- Item ----------

/** 新項目掛在「未分類」下；使用者把它刪了才退回第一個分類。 */
export function defaultCategoryId(collection: Collection): string {
  const fallback = collection.categories.find((category) => category.name === DEFAULT_CATEGORY_NAME) ?? collection.categories[0];
  return fallback.id;
}

/** parentId 指向的不是頂層項目時退回頂層，不讓資料出現第三層。 */
export function createItem(id: string, collection: Collection, now: Date, parentId: string | null = null): TodoItem {
  const iso = now.toISOString();
  const parent = parentId === null ? undefined : collection.items.find((entry) => entry.id === parentId && entry.parentId === null);
  return {
    id,
    title: '',
    content: '',
    status: '未完成',
    categoryId: defaultCategoryId(collection),
    tagIds: [],
    parentId: parent ? parent.id : null,
    createdAt: iso,
    completedAt: null,
    updatedAt: iso,
  };
}

/** 套用局部修改；不合法的欄位值保留原值，不整筆拒絕。 */
export function applyItemPatch(collection: Collection, item: TodoItem, patch: ItemPatch, now: Date): TodoItem {
  const next: TodoItem = { ...item, tagIds: [...item.tagIds] };
  if (typeof patch.title === 'string') {
    next.title = patch.title.replace(/[\r\n]+/g, ' ').trim().slice(0, TITLE_MAX);
  }
  if (typeof patch.content === 'string') {
    next.content = patch.content;
  }
  if (patch.categoryId !== undefined && collection.categories.some((category) => category.id === patch.categoryId)) {
    next.categoryId = patch.categoryId;
  }
  if (Array.isArray(patch.tagIds)) {
    const known = new Set(collection.tags.map((tag) => tag.id));
    next.tagIds = [...new Set(patch.tagIds.filter((tagId) => known.has(tagId)))];
  }
  if (typeof patch.createdAt === 'string' && !Number.isNaN(Date.parse(patch.createdAt))) {
    next.createdAt = new Date(patch.createdAt).toISOString();
  }
  if (isStatus(patch.status) && patch.status !== item.status) {
    const wasDone = DONE_STATUSES.has(item.status);
    const isDone = DONE_STATUSES.has(patch.status);
    next.status = patch.status;
    if (isDone && !wasDone) {
      next.completedAt = now.toISOString();
    } else if (!isDone) {
      next.completedAt = null;
    }
    // 已完成 ↔ 失敗 之間切換保留原本的完成時間。
  }
  next.updatedAt = now.toISOString();
  return next;
}

/** 新的頂層項目插到最前面；新的子項目接在父項目既有子項目的最後面（子項目通常是照步驟寫的）。 */
export function withItem(collection: Collection, item: TodoItem, now: Date): Collection {
  const index = collection.items.findIndex((entry) => entry.id === item.id);
  let items: TodoItem[];
  if (index >= 0) {
    items = collection.items.map((entry) => (entry.id === item.id ? item : entry));
  } else if (item.parentId === null) {
    items = [item, ...collection.items];
  } else {
    items = [...collection.items, item];
  }
  return touch({ ...collection, items: canonicalOrder(items) }, now);
}

/** 刪父項目時子項目一起刪。 */
export function removeItem(collection: Collection, itemId: string, now: Date): Collection {
  return touch({ ...collection, items: collection.items.filter((item) => item.id !== itemId && item.parentId !== itemId) }, now);
}

// ---------- 順序與父子 ----------

/**
 * items 陣列的順序就是畫面順序：頂層項目依序排列，每個頂層項目後面緊接著它的子項目。
 * 所有會動到 items 的操作最後都經過這裡，陣列永遠維持這個形狀，畫面端不必再排序。
 * 父項目不存在、或父項目本身是子項目（第三層）的，升成頂層，不丟資料。
 */
export function canonicalOrder(items: readonly TodoItem[]): TodoItem[] {
  const topIds = new Set(items.filter((item) => item.parentId === null).map((item) => item.id));
  const tops: TodoItem[] = [];
  const children = new Map<string, TodoItem[]>();
  for (const item of items) {
    if (item.parentId !== null && topIds.has(item.parentId)) {
      const list = children.get(item.parentId) ?? [];
      list.push(item);
      children.set(item.parentId, list);
    } else {
      tops.push(item.parentId === null ? item : { ...item, parentId: null });
    }
  }
  return tops.flatMap((item) => [item, ...(children.get(item.id) ?? [])]);
}

export function childrenOf(collection: Collection, parentId: string): TodoItem[] {
  return collection.items.filter((item) => item.parentId === parentId);
}

/**
 * 把項目搬到 parentId 底下（null 代表頂層）的第 index 個位置；index 以「不含自己的同層項目」計，超出範圍就放最後。
 * 只有兩層：帶著子項目的頂層項目不能變成別人的子項目，子項目也不能當父項目；不允許時回 undefined。
 * 父項目搬動時子項目跟著走，關係不變。
 */
export function moveItem(collection: Collection, itemId: string, parentId: string | null, index: number, now: Date): Collection | undefined {
  const item = collection.items.find((entry) => entry.id === itemId);
  if (!item) {
    return undefined;
  }
  if (parentId !== null) {
    const parent = collection.items.find((entry) => entry.id === parentId);
    const hasChildren = collection.items.some((entry) => entry.parentId === itemId);
    if (!parent || parent.parentId !== null || parent.id === itemId || hasChildren) {
      return undefined;
    }
  }
  const moved: TodoItem = parentId === item.parentId ? item : { ...item, parentId, updatedAt: now.toISOString() };
  const rest = collection.items.filter((entry) => entry.id !== itemId);
  const siblings = rest.filter((entry) => entry.parentId === parentId);
  const at = Math.max(0, Math.min(Math.floor(index), siblings.length));
  // 先排好同層的順序，其他項目原順序放前面；canonicalOrder 會把子項目接回各自的父項目後面。
  const reordered = [...siblings.slice(0, at), moved, ...siblings.slice(at)];
  const others = rest.filter((entry) => entry.parentId !== parentId);
  return touch({ ...collection, items: canonicalOrder([...others, ...reordered]) }, now);
}

// ---------- Category ----------

export function addCategory(collection: Collection, id: string, name: string, now: Date): Collection | undefined {
  const clean = cleanName(name);
  if (!clean || hasName(collection.categories, clean)) {
    return undefined;
  }
  return touch({ ...collection, categories: [...collection.categories, { id, name: clean }] }, now);
}

export function renameCategory(collection: Collection, id: string, name: string, now: Date): Collection | undefined {
  const clean = cleanName(name);
  if (!clean || hasName(collection.categories, clean, id) || !collection.categories.some((category) => category.id === id)) {
    return undefined;
  }
  const categories = collection.categories.map((category) => (category.id === id ? { ...category, name: clean } : category));
  return touch({ ...collection, categories }, now);
}

/** 至少留一個分類；被刪分類底下的項目改掛到「未分類」，沒有就掛第一個。 */
export function removeCategory(collection: Collection, id: string, now: Date): Collection | undefined {
  if (collection.categories.length <= 1 || !collection.categories.some((category) => category.id === id)) {
    return undefined;
  }
  const remaining = { ...collection, categories: collection.categories.filter((category) => category.id !== id) };
  const fallback = defaultCategoryId(remaining);
  const items = collection.items.map((item) => (item.categoryId === id ? { ...item, categoryId: fallback } : item));
  return touch({ ...remaining, items }, now);
}

// ---------- Tag ----------

export function addTag(collection: Collection, id: string, name: string, color: TagColor, now: Date): Collection | undefined {
  const clean = cleanName(name);
  if (!clean || hasName(collection.tags, clean)) {
    return undefined;
  }
  return touch({ ...collection, tags: [...collection.tags, { id, name: clean, color }] }, now);
}

export function updateTag(
  collection: Collection,
  id: string,
  patch: { name?: string; color?: TagColor },
  now: Date,
): Collection | undefined {
  const current = collection.tags.find((tag) => tag.id === id);
  if (!current) {
    return undefined;
  }
  const next = { ...current };
  if (typeof patch.name === 'string') {
    const clean = cleanName(patch.name);
    if (!clean || hasName(collection.tags, clean, id)) {
      return undefined;
    }
    next.name = clean;
  }
  if (patch.color !== undefined) {
    next.color = patch.color;
  }
  return touch({ ...collection, tags: collection.tags.map((tag) => (tag.id === id ? next : tag)) }, now);
}

export function removeTag(collection: Collection, id: string, now: Date): Collection | undefined {
  if (!collection.tags.some((tag) => tag.id === id)) {
    return undefined;
  }
  const items = collection.items.map((item) =>
    item.tagIds.includes(id) ? { ...item, tagIds: item.tagIds.filter((tagId) => tagId !== id) } : item,
  );
  return touch({ ...collection, tags: collection.tags.filter((tag) => tag.id !== id), items }, now);
}

// ---------- 讀檔驗證 ----------

/**
 * 把磁碟上的 JSON 整理成合法的 Collection。檔案是使用者可以手改、也可能被同步弄壞的，
 * 所以逐欄檢查：認不得的狀態退回未完成、指向不存在的分類退回未分類、多餘欄位丟掉。
 * 缺 id／name 這種救不回來的才回 undefined。
 */
export function parseCollection(raw: unknown, fallbackId: (prefix: string) => string): Collection | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.id !== 'string' || typeof data.name !== 'string') {
    return undefined;
  }
  const nowIso = new Date().toISOString();
  const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
  const iso = (value: unknown, fallback: string): string =>
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;

  const categories: Category[] = [];
  for (const entry of Array.isArray(data.categories) ? data.categories : []) {
    const category = entry as Record<string, unknown>;
    if (category && typeof category.id === 'string' && typeof category.name === 'string') {
      const name = cleanName(category.name);
      if (name && !hasName(categories, name)) {
        categories.push({ id: category.id, name });
      }
    }
  }
  if (categories.length === 0) {
    categories.push({ id: fallbackId('cat'), name: DEFAULT_CATEGORY_NAME });
  }

  const tags: Tag[] = [];
  for (const entry of Array.isArray(data.tags) ? data.tags : []) {
    const tag = entry as Record<string, unknown>;
    if (tag && typeof tag.id === 'string' && typeof tag.name === 'string') {
      const name = cleanName(tag.name);
      if (name && !hasName(tags, name)) {
        tags.push({ id: tag.id, name, color: isTagColor(tag.color) ? tag.color : 'gray' });
      }
    }
  }

  const base: Collection = {
    version: COLLECTION_VERSION,
    id: data.id,
    name: cleanName(data.name) || DEFAULT_COLLECTION_NAME,
    title: cleanName(str(data.title), TITLE_MAX),
    categories,
    tags,
    items: [],
    createdAt: iso(data.createdAt, nowIso),
    updatedAt: iso(data.updatedAt, nowIso),
  };

  const seen = new Set<string>();
  for (const entry of Array.isArray(data.items) ? data.items : []) {
    const item = entry as Record<string, unknown>;
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    const createdAt = iso(item.createdAt, nowIso);
    const blank: TodoItem = {
      id: item.id,
      title: '',
      content: '',
      status: '未完成',
      categoryId: defaultCategoryId(base),
      tagIds: [],
      parentId: typeof item.parentId === 'string' ? item.parentId : null,
      createdAt,
      completedAt: null,
      updatedAt: createdAt,
    };
    const patched = applyItemPatch(
      base,
      blank,
      {
        title: str(item.title),
        content: str(item.content),
        status: isStatus(item.status) ? item.status : '未完成',
        categoryId: str(item.categoryId),
        tagIds: Array.isArray(item.tagIds) ? item.tagIds.filter((tagId): tagId is string => typeof tagId === 'string') : [],
      },
      new Date(iso(item.updatedAt, createdAt)),
    );
    // 完成時間以檔案裡的為準；狀態不是完成類卻留著時間就清掉。
    patched.completedAt = DONE_STATUSES.has(patched.status) ? iso(item.completedAt, patched.updatedAt) : null;
    base.items.push(patched);
  }
  // 手改過的檔案可能有指向不存在父項目、或疊到第三層的項目，整理成兩層並排好順序。
  base.items = canonicalOrder(base.items);
  return base;
}
