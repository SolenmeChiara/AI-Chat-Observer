/**
 * 正文里的思考标签剥离器。
 *
 * 背景：Claude 3 Opus / DeepSeek 中转 / 各种没有 API 级思考通道的模型，习惯把草稿写成
 * `<thinking>…</thinking>` 塞进正文。原样落进 message.text 会连环出事：
 *   - 别的 agent 拼上下文时读到标签，开始模仿这个格式；
 *   - 草稿里随手写的 `{{SEARCH: …}}` / `{{PASS}}` 被命令正则当真执行；
 *   - 界面上尖括号裸露、归档总结把草稿也吸进去。
 * 所以在流式消费的最上游把它剥出来，转成 `{ reasoning }` 片段 —— App 会累进
 * message.reasoningText，ChatBubble 折叠展示给用户，而 services/shared.ts 拼给其他
 * agent 的上下文从不带 reasoningText。结论就是：对其他 agent 隐藏，对用户折叠展示。
 *
 * 识别的标签名：think / thinking / antThinking，大小写不敏感。必须是 `<name>` `</name>`
 * 这种严格形状 —— 标签名与尖括号之间不允许空格，也不处理属性。因此 `<thinker>`、
 * `<br>`、`a < b` 都不会误伤（前两者作为普通标签原样留在正文里）。
 *
 * 【已知取舍】markdown 代码围栏里的思考标签同样会被当成思考剥掉。解析器不跟踪 ``` 状态：
 * 要正确处理就得实现一个 markdown 词法器，而「聊天里贴一段带 <thinking> 的代码」远比
 * 「模型真的在写草稿」罕见，剥错的代价（思维链里多一段代码）也远小于漏剥的代价（草稿
 * 里的命令被执行）。有需要再补。
 */

import type { StreamChunk } from '../types';

/** 一个解析片段：正文或思考，二选一（不会同时有）。 */
export interface ThinkPiece {
  text?: string;
  reasoning?: string;
}

/** 全部小写，比较时把候选也 toLowerCase。 */
const TAG_NAMES = ['think', 'thinking', 'antthinking'];

/** 最长标签名长度（'antthinking' = 11）。缓冲的尾巴最长 = 它 + 2（`</antThinking`）。 */
const MAX_TAG_NAME_LEN = Math.max(...TAG_NAMES.map(n => n.length));

/** 完整标签：`<name>` 或 `</name>`。 */
const FULL_TAG_RE = /^<(\/?)([A-Za-z]+)>/;

/**
 * 这一段「以 `<` 开头、还没写完」的尾巴，有没有可能被后续 chunk 补成一个我们认识的标签？
 * 有 → 必须缓冲住不能吐出（否则 `<thi` + `nking>` 这种切法就漏了）；
 * 没有 → `<` 就是个普通字符，立刻当正文吐出去。
 */
function isViableTagPrefix(s: string): boolean {
  const m = /^<(\/?)([A-Za-z]*)$/.exec(s);
  if (!m) return false;
  const partial = m[2].toLowerCase();
  return TAG_NAMES.some(n => n.startsWith(partial));
}

/**
 * 「本流有没有真的从正文里剥出过标签思考」的回执。给 App.tsx 的 thought-only 续写腿用：
 * 那条腿只认标签剥出来的思考，**不认**原生思考通道（DeepSeek reasoning_content /
 * OpenRouter delta.reasoning / Anthropic thinking）—— 原生思考模型在思考阶段就被
 * max_tokens 截断、content 为空是个老场景，正确处理是 PASS，再问一腿只会重复同样的
 * 失败并双倍花钱。标签思考则相反：模型确实想完了，只是把发言写丢了。
 */
export interface ThinkTagStripReport {
  stripped: boolean;
}

export interface ThinkTagStreamParser {
  /** 喂一段流式文本，返回这一段能确定下来的片段（可能为空数组）。 */
  push(text: string): ThinkPiece[];
  /** 流结束：把缓冲的尾巴按当前状态全部吐出（未闭合的思考块 → 全部算 reasoning）。 */
  flush(): ThinkPiece[];
}

/**
 * 流式解析器。核心是「可能是标签前缀的尾巴」缓冲策略：任何时刻只有以 `<` 开头、
 * 且还能被补成合法标签的那一小段会被留在缓冲里，长度上界 MAX_TAG_NAME_LEN + 2，
 * 所以哪怕一个字符一个 chunk 也不会无限膨胀。
 *
 * 边界语义（都有单测）：
 *   - 思考块内又出现开标签 → 忽略（不嵌套，不改状态，标签本身丢弃）；
 *   - 思考块外出现闭标签 → 当普通正文原样保留（不吞用户内容）；
 *   - 开标签后没有闭标签（被 maxTokens 截断）→ 之后的全部内容都是 reasoning；
 *   - 不做任何 trim：正文首尾空白交给 App 现有的 trimStart / trim 处理。
 */
export function createThinkTagStreamParser(): ThinkTagStreamParser {
  let inThink = false;
  let buf = '';

  const emit = (out: ThinkPiece[], s: string): void => {
    if (!s) return;
    const last = out[out.length - 1];
    if (inThink) {
      if (last && last.reasoning !== undefined) last.reasoning += s;
      else out.push({ reasoning: s });
    } else {
      if (last && last.text !== undefined) last.text += s;
      else out.push({ text: s });
    }
  };

  /** 把缓冲区能确定的部分消费掉。final=true 时不再等待后续输入，全部消费。 */
  const drain = (final: boolean): ThinkPiece[] => {
    const out: ThinkPiece[] = [];
    let i = 0;
    while (i < buf.length) {
      const lt = buf.indexOf('<', i);
      if (lt < 0) {
        emit(out, buf.slice(i));
        i = buf.length;
        break;
      }
      if (lt > i) {
        emit(out, buf.slice(i, lt));
        i = lt;
      }
      const rest = buf.slice(i);
      const m = FULL_TAG_RE.exec(rest);
      if (m) {
        const isClose = m[1] === '/';
        const name = m[2].toLowerCase();
        if (TAG_NAMES.includes(name)) {
          if (!isClose) {
            // 已经在思考块里又来一个开标签：忽略（丢弃标签本身，状态不变）
            if (!inThink) inThink = true;
          } else if (inThink) {
            inThink = false;
          } else {
            // 思考块外的孤立闭标签：不吞，原样当正文
            emit(out, m[0]);
          }
        } else {
          // 是个完整标签但不是我们认识的（<br> / <thinker> / …）→ 原样保留
          emit(out, m[0]);
        }
        i += m[0].length;
        continue;
      }
      // 这里没有完整标签。还有可能被后面的 chunk 补全吗？
      if (!final && isViableTagPrefix(rest)) break; // 缓冲住，等下一个 chunk
      emit(out, '<');
      i += 1;
    }
    buf = buf.slice(i);
    return out;
  };

  return {
    push(text: string): ThinkPiece[] {
      if (!text) return [];
      buf += text;
      return drain(false);
    },
    flush(): ThinkPiece[] {
      if (!buf) return [];
      const out = drain(true);
      buf = '';
      return out;
    },
  };
}

/**
 * 非流式版本：语义严格等于 push 一次 + flush。历史清洗按钮用它。
 * 返回的 text 不做 trim（调用方按需处理）。
 */
export function extractThinkTags(text: string): { text: string; reasoning: string } {
  const parser = createThinkTagStreamParser();
  const pieces = [...parser.push(text), ...parser.flush()];
  let outText = '';
  let outReasoning = '';
  for (const p of pieces) {
    if (p.text !== undefined) outText += p.text;
    if (p.reasoning !== undefined) outReasoning += p.reasoning;
  }
  return { text: outText, reasoning: outReasoning };
}

/** 正文里是否含有一个（我们认识的）思考开标签 —— 清洗按钮用来数命中条数。 */
export function hasThinkTag(text: string): boolean {
  if (!text) return false;
  return new RegExp(`<(?:${TAG_NAMES.join('|')})>`, 'i').test(text);
}

/** rest 里除 text 外还有没有值得下发的东西。纯 `{isComplete:false}` 空壳不必占一个 chunk。 */
function hasNonTextPayload(c: Omit<StreamChunk, 'text'>): boolean {
  return c.isComplete === true
    || c.reasoning !== undefined
    || c.reasoningSignature !== undefined
    || c.image !== undefined
    || c.revisedPrompt !== undefined
    || c.usage !== undefined
    || (c.toolCalls !== undefined && c.toolCalls.length > 0);
}

/**
 * 把任意一条 StreamChunk 流套上思考标签解析：chunk.text 过解析器，先按顺序吐出
 * {reasoning}/{text} 片段，再把原 chunk 去掉 text 后的其余字段（reasoning /
 * reasoningSignature / image / revisedPrompt / usage / toolCalls / isComplete）原样下发。
 * 流结束时 flush 一次，把截断在半截的思考尾巴补出来。
 *
 * 传入 report 时，只要真的剥出过一段标签思考就把 report.stripped 置 true —— 调用方靠它
 * 把「标签里剥出来的思考」和「原生思考通道来的 reasoning」区分开（见 ThinkTagStripReport）。
 *
 * ⚠️ 门禁：带 signature 的 reasoningText 会被 anthropicService / geminiService 回填成
 * thinking block（见 anthropicService.ts:176-181、geminiService.ts:192-197）。把标签里
 * 剥出来的普通文字混进那份 reasoningText，重建出来的块与签名对不上会被上游 400 拒绝。
 * 所以对「原生思考通道已开」的路径不要套这个包装器 —— 调用点自己判断（App.tsx）。
 */
export async function* withThinkTagParsing(
  stream: AsyncGenerator<StreamChunk>,
  report?: ThinkTagStripReport
): AsyncGenerator<StreamChunk> {
  const parser = createThinkTagStreamParser();
  for await (const chunk of stream) {
    if (typeof chunk.text === 'string' && chunk.text.length > 0) {
      const { text, ...rest } = chunk;
      for (const piece of parser.push(text)) {
        if (piece.reasoning !== undefined) { if (report) report.stripped = true; yield { reasoning: piece.reasoning, isComplete: false }; }
        else if (piece.text !== undefined) yield { text: piece.text, isComplete: false };
      }
      if (hasNonTextPayload(rest)) yield rest;
    } else {
      yield chunk;
    }
  }
  for (const piece of parser.flush()) {
    if (piece.reasoning !== undefined) { if (report) report.stripped = true; yield { reasoning: piece.reasoning, isComplete: false }; }
    else if (piece.text !== undefined) yield { text: piece.text, isComplete: false };
  }
}
