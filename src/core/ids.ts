import { randomBytes } from 'node:crypto';

/** 所有 id 都長這樣：`前綴_16 個 hex`。會拿來組檔名，格式固定才擋得住路徑穿越。 */
const SAFE_ID = /^[a-z]{1,8}_[0-9a-f]{16}$/;

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function isSafeIdSegment(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}
