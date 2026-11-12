/**
 * 网关接口里的对象字段有时是 JSON 字符串（线上 /model/history 的 requestBody 就是，见 test/predictions.test.ts
 * 的 liveShaped），有时是对象：两种都当对象读，读不出来就当没有。
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
