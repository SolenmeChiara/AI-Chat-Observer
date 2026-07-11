// 字符串安全工具。
// JS 的 substring/slice 按 UTF-16 编码单元切割,而 emoji 等增补平面字符占两个
// 编码单元(代理对)。切在中间会留下孤立代理(lone surrogate):JSON.stringify
// 会把它转义成 \uD8xx 序列,Anthropic 后端解析请求体时直接报
// 400 "no low surrogate in string"(OpenAI/Gemini 后端会静默替换,所以只有
// Anthropic 家的模型炸)。所有进请求体的截断必须走 safeTruncate。

/** 截断到最多 n 个 UTF-16 编码单元,但不劈开代理对。 */
export function safeTruncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  // 末位是高代理(它的低代理搭档被切掉了)则回退一位
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** 把字符串里的孤立代理替换为 U+FFFD(�),保证序列化后是合法 Unicode。 */
export function toWellFormed(s: string): string {
  const native = (s as any).toWellFormed;
  if (typeof native === 'function') return native.call(s);
  // 旧环境 fallback:孤立高代理(后面不跟低代理)/ 孤立低代理(前面不是高代理)
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�'
  );
}

/** JSON.stringify,但对所有字符串值先做 toWellFormed 清洗。API 请求体序列化用这个。 */
export function wellFormedStringify(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'string' ? toWellFormed(value) : value
  );
}
