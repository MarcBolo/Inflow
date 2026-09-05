/**
 * 格式渲染引擎 - 模板 DSL 求值
 *
 * 支持记号：
 * - {episode} / {scene}：场景编号（由调用方 getSceneNumber 提供，形如 1.2，拆分为 episode/scene）
 * - {scenetype}：内景 / 外景（跟随设置 defaultSceneType）
 * - {date} {time} {datetime}：时间戳；{selection}：当前选区文本
 * - $0：插入后光标落点；${0:默认词}：落点并选中默认词（可立即输入覆盖）
 * - \{ \$ \\：字面量转义
 *
 * 落点规则：模板含 $0 时不追加尾部空格；不含 $0 时沿用旧行为（末尾补一个空格，
 * 由 TextInserter.ensureTrailingSpace 的语义，仅追加一次），调用方把光标放文本尾。
 */
import type { FormatRenderResult } from './types';

export interface FormatRenderCtx {
  /** 内景 / 外景（决定 {scenetype} 取值） */
  sceneType: 'int' | 'ext';
  /** 返回下一个场景编号（形如 1.2）；缺省时 {episode}/{scene} 回退为 1 */
  getSceneNumber?: () => string;
  /** 当前选区文本（{selection}） */
  selection?: string;
  now?: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 求一段已渲染文本内的相对偏移 → (行, 列)（多行模板落点用） */
export function offsetToLineCh(text: string, offset: number): { line: number; ch: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  const parts = text.split('\n');
  let rem = safe;
  for (let i = 0; i < parts.length; i++) {
    const len = parts[i].length;
    if (rem <= len) return { line: i, ch: rem };
    rem -= len + 1;
  }
  const last = parts.length - 1;
  return { line: last, ch: parts[last]?.length ?? 0 };
}

/** 模板末尾补空格（等价旧 TextInserter.ensureTrailingSpace，仅一次） */
function ensureTrailingSpace(text: string): string {
  if (!text) return text;
  return /\s$/.test(text) ? text : text + ' ';
}

/** 渲染模板。未知变量保留原文并 console.warn（绝不抛错中断插入）。 */
export function renderFormatTemplate(
  template: string,
  ctx: FormatRenderCtx,
): FormatRenderResult {
  const out: string[] = [];
  let cursorOffset: number | null = null;
  let selectFrom: number | null = null;
  let selectTo: number | null = null;

  // 场景编号懒求值（模板里真正出现 {episode}/{scene} 才扫描文档）
  let sceneNoCache: string | null = null;
  const sceneNo = (): string => {
    if (sceneNoCache === null) {
      sceneNoCache = ctx.getSceneNumber ? ctx.getSceneNumber() : '1.1';
    }
    return sceneNoCache;
  };

  const now = ctx.now || new Date();
  const stamp = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    datetime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(
      now.getHours(),
    )}:${pad(now.getMinutes())}`,
  };

  const valueOf = (name: string): { found: boolean; value: string } => {
    switch (name) {
      case 'episode': {
        const [e] = sceneNo().split('.');
        return { found: true, value: e || '1' };
      }
      case 'scene': {
        const [, s] = sceneNo().split('.');
        return { found: true, value: s || '1' };
      }
      case 'scenetype':
        return { found: true, value: ctx.sceneType === 'ext' ? '外景' : '内景' };
      case 'date':
        return { found: true, value: stamp.date };
      case 'time':
        return { found: true, value: stamp.time };
      case 'datetime':
        return { found: true, value: stamp.datetime };
      case 'selection':
        return { found: true, value: ctx.selection ?? '' };
      default:
        return { found: false, value: '' };
    }
  };

  let hasCursorMarker = false;
  let i = 0;
  const t = template || '';
  while (i < t.length) {
    const c = t[i];
    // 转义：\{ \} \$ \\ 输出字面量
    if (c === '\\' && i + 1 < t.length && '{}.$\\'.includes(t[i + 1])) {
      out.push(t[i + 1]);
      i += 2;
      continue;
    }
    if (c === '$') {
      // ${0:默认词}
      if (t.startsWith('${0:', i)) {
        const close = t.indexOf('}', i + 4);
        if (close >= 0) {
          const def = t.slice(i + 4, close);
          const at = out.join('').length;
          if (!hasCursorMarker) {
            hasCursorMarker = true;
            cursorOffset = at + def.length;
            selectFrom = at;
            selectTo = at + def.length;
          }
          out.push(def);
          i = close + 1;
          continue;
        }
      }
      // $0 → 光标落点（首次）
      if (t[i + 1] === '0') {
        if (!hasCursorMarker) {
          hasCursorMarker = true;
          cursorOffset = out.join('').length;
        }
        i += 2;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (c === '{') {
      const close = t.indexOf('}', i + 1);
      if (close >= 0) {
        const name = t.slice(i + 1, close);
        const v = valueOf(name);
        if (v.found) {
          out.push(v.value);
          i = close + 1;
          continue;
        }
        // 未知变量：保留原文，避免用户模板里的普通花括号被吞
        if (cursorOffset === null) {
          console.warn(`[InFlow] 未知模板变量 {${name}}，已按原样输出`);
        }
        out.push(t.slice(i, close + 1));
        i = close + 1;
        continue;
      }
    }
    out.push(c);
    i += 1;
  }

  let text = out.join('');
  // 无光标标记的模板沿用旧收尾语义（末尾空格、光标停末尾）
  if (!hasCursorMarker) {
    text = ensureTrailingSpace(text);
  }

  return {
    text,
    cursorOffset,
    selectFrom,
    selectTo,
  };
}
