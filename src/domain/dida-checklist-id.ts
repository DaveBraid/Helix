export const DIDA_CHECKLIST_CLIENT_ID_MIN = 1_000_000_000_000;
export const DIDA_CHECKLIST_CLIENT_ID_MAX = 9_999_999_999_999;

/** DidaSync 风格的毫秒客户端 ID；拒绝前导零和 13 位范围外的伪装值。 */
export function isDidaChecklistClientId(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{13}$/u.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= DIDA_CHECKLIST_CLIENT_ID_MIN &&
    numeric <= DIDA_CHECKLIST_CLIENT_ID_MAX;
}
