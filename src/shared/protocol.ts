import type { Collection, ItemPatch, TagColor } from '../core/model';
import { isStatus, isTagColor } from '../core/model';
import type { ViewState } from '../core/uiState';
import { isViewState } from '../core/uiState';

export interface CollectionSummary {
  id: string;
  name: string;
}

export type HostMessage =
  | {
      type: 'state';
      collections: CollectionSummary[];
      collection: Collection;
      /** 左欄佔整個面板寬度的比例。 */
      ratio: number;
      /** 目前這個 Collection 的保存資料夾（顯示用，家目錄縮成 `~`）。 */
      folder: string;
      /** 是否另設了保存位置，不在預設資料夾。 */
      customFolder: boolean;
      /** 剛新增的項目：webview 要選到它並把游標放到標題。 */
      focusItemId?: string;
      /** 開面板或按刷新時帶上：webview 要切到這個畫面狀態。平常的狀態更新不帶，畫面照舊。 */
      view?: ViewState;
    }
  | { type: 'empty'; reason: string };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'setView'; view: ViewState }
  | { type: 'selectCollection'; id: string }
  | { type: 'createCollection' }
  | { type: 'renameCollection'; id: string }
  | { type: 'deleteCollection'; id: string }
  | { type: 'setCollectionFolder'; id: string }
  | { type: 'createItem'; parentId?: string }
  | { type: 'updateItem'; id: string; patch: ItemPatch }
  | { type: 'moveItem'; id: string; parentId: string | null; index: number }
  | { type: 'deleteItem'; id: string }
  | { type: 'createCategory'; name: string }
  | { type: 'renameCategory'; id: string; name: string }
  | { type: 'deleteCategory'; id: string }
  | { type: 'createTag'; name: string; color: TagColor }
  | { type: 'updateTag'; id: string; name?: string; color?: TagColor }
  | { type: 'deleteTag'; id: string }
  | { type: 'setRatio'; ratio: number };

const isStr = (value: unknown): value is string => typeof value === 'string';

function isItemPatch(value: unknown): value is ItemPatch {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const patch = value as Record<string, unknown>;
  const allowed = ['title', 'content', 'status', 'categoryId', 'tagIds', 'createdAt'];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      return false;
    }
  }
  return (
    (patch.title === undefined || isStr(patch.title)) &&
    (patch.content === undefined || isStr(patch.content)) &&
    (patch.status === undefined || isStatus(patch.status)) &&
    (patch.categoryId === undefined || isStr(patch.categoryId)) &&
    (patch.tagIds === undefined || (Array.isArray(patch.tagIds) && patch.tagIds.every(isStr))) &&
    (patch.createdAt === undefined || isStr(patch.createdAt))
  );
}

/** webview 送來的東西一律當不可信：型別逐欄檢查，指令名稱只認清單上的。 */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
    case 'refresh':
    case 'createCollection':
      return true;
    case 'setView':
      return isViewState(msg.view);
    case 'createItem':
      return msg.parentId === undefined || isStr(msg.parentId);
    case 'selectCollection':
    case 'renameCollection':
    case 'deleteCollection':
    case 'setCollectionFolder':
    case 'deleteItem':
    case 'deleteCategory':
    case 'deleteTag':
      return isStr(msg.id);
    case 'updateItem':
      return isStr(msg.id) && isItemPatch(msg.patch);
    case 'moveItem':
      return isStr(msg.id) && (msg.parentId === null || isStr(msg.parentId)) && Number.isInteger(msg.index) && (msg.index as number) >= 0;
    case 'createCategory':
      return isStr(msg.name);
    case 'renameCategory':
      return isStr(msg.id) && isStr(msg.name);
    case 'createTag':
      return isStr(msg.name) && isTagColor(msg.color);
    case 'updateTag':
      return isStr(msg.id) && (msg.name === undefined || isStr(msg.name)) && (msg.color === undefined || isTagColor(msg.color));
    case 'setRatio':
      return typeof msg.ratio === 'number' && Number.isFinite(msg.ratio);
    default:
      return false;
  }
}

export const RATIO_MIN = 0.2;
export const RATIO_MAX = 0.8;
export const RATIO_DEFAULT = 0.6;

export function clampRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return RATIO_DEFAULT;
  }
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, Math.round(value * 100) / 100));
}
