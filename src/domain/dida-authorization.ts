import { stableHash } from "./stable";

const BINDING_DOMAIN = "helix:dida-contract-authorization:v1";

/** 只保存域分离后的 SHA-256 指纹，不持久化 API 口令本身。 */
export function didaAuthorizationBinding(token: string): string {
  const normalized = token.trim();
  if (!normalized) throw new Error("无法为空的滴答授权生成能力绑定");
  return stableHash({ domain: BINDING_DOMAIN, token: normalized });
}
