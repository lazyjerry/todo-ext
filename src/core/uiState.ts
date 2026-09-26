/**
 * 畫面狀態：開著的 Collection、選到的 TODO、狀態篩選、關鍵字、是否展開。
 * 存成資料夾裡的 `ui-state.json`，所有視窗與 profile 共用，最後一次變更的視窗說了算。
 * 這不是資料，不做版本比對；缺欄位或寫壞的一律退回預設值。純函式，不碰檔案系統。
 */

import type { FilterKey } from './filter';
import { isFilterKey } from './filter';

export const QUERY_MAX = 200;

/** webview 自己管的那部分；開著的 Collection 由主機管，不在這裡。 */
export interface ViewState {
  itemId: string | null;
  filter: FilterKey;
  query: string;
  expanded: boolean;
}

export interface UiState extends ViewState {
  collectionId: string | null;
  /** 最後一次變更的時間，ISO 8601；只供人看，沒有比對用途。 */
  updatedAt: string;
}

export const DEFAULT_VIEW: ViewState = { itemId: null, filter: 'all', query: '', expanded: false };

export function isViewState(value: unknown): value is ViewState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const view = value as Record<string, unknown>;
  return (
    (view.itemId === null || typeof view.itemId === 'string') &&
    isFilterKey(view.filter) &&
    typeof view.query === 'string' &&
    view.query.length <= QUERY_MAX &&
    typeof view.expanded === 'boolean'
  );
}

export function viewOf(state: UiState): ViewState {
  return { itemId: state.itemId, filter: state.filter, query: state.query, expanded: state.expanded };
}

/** 逐欄檢查，認不得的退回預設；整份不是物件就整份預設。 */
export function parseUiState(raw: unknown): UiState {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    collectionId: typeof data.collectionId === 'string' ? data.collectionId : null,
    itemId: typeof data.itemId === 'string' ? data.itemId : null,
    filter: isFilterKey(data.filter) ? data.filter : DEFAULT_VIEW.filter,
    query: typeof data.query === 'string' ? data.query.slice(0, QUERY_MAX) : '',
    expanded: data.expanded === true,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
  };
}
