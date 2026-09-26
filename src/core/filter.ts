/**
 * 左欄列表的狀態篩選與關鍵字搜尋。純函式、只在 webview 端用，
 * 不改資料也不經過主機；拆出來是為了能單元測試。
 */

import type { Status, TodoItem } from './model';

export const FILTERS = [
  { key: 'all', label: '全部', statuses: null },
  { key: 'open', label: '僅顯示未完成', statuses: ['未完成'] },
  { key: 'closed', label: '結束（已完成、失敗、擱置）', statuses: ['已完成', '失敗', '擱置'] },
  { key: 'done', label: '已完成', statuses: ['已完成'] },
  { key: 'other', label: '其他（待測試、待回覆）', statuses: ['待測試', '待回覆'] },
] as const satisfies readonly { key: string; label: string; statuses: readonly Status[] | null }[];

export type FilterKey = (typeof FILTERS)[number]['key'];

export function isFilterKey(value: unknown): value is FilterKey {
  return FILTERS.some((filter) => filter.key === value);
}

export interface VisibleItem {
  item: TodoItem;
  /** 本身不符合條件，只因為有子項目符合才留下來當脈絡；畫面淡化。 */
  context: boolean;
}

function matchesStatus(item: TodoItem, filter: FilterKey): boolean {
  const statuses = FILTERS.find((entry) => entry.key === filter)?.statuses ?? null;
  return statuses === null || (statuses as readonly Status[]).includes(item.status);
}

/** 關鍵字不分大小寫，標題或內容含有就算；空白關鍵字等於不篩。 */
function matchesQuery(item: TodoItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return item.title.toLocaleLowerCase().includes(needle) || item.content.toLocaleLowerCase().includes(needle);
}

/**
 * 篩出要畫的項目，順序沿用 items（頂層後緊接子項目）。
 * 子項目符合但父項目不符合時，父項目仍顯示（標成 context），子項目才有地方掛。
 */
export function filterItems(items: readonly TodoItem[], filter: FilterKey, query: string): VisibleItem[] {
  const matched = new Set(items.filter((item) => matchesStatus(item, filter) && matchesQuery(item, query)).map((item) => item.id));
  const parentsOfMatched = new Set(
    items.filter((item) => item.parentId !== null && matched.has(item.id)).map((item) => item.parentId as string),
  );
  return items.flatMap((item): VisibleItem[] => {
    if (matched.has(item.id)) {
      return [{ item, context: false }];
    }
    if (item.parentId === null && parentsOfMatched.has(item.id)) {
      return [{ item, context: true }];
    }
    return [];
  });
}
