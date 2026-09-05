/**
 * 文本插入器 - 统一处理不同类型输入元素的文本插入与读取
 */
import { EditorView } from '@codemirror/view';
import type { CMViewLike, EditorLike } from './types';

interface CursorScreenPos {
  x: number;
  y: number;
  height: number;
}

export class TextInserter {
  private static _mirror: HTMLPreElement | null = null;

  /**
   * 规则类模板插入后的收尾：不再追加换行，而是确保末尾留一个空格，方便接着输入内容。
   * - "## 1.1 内景."        → "## 1.1 内景. "
   * - "#### "（已有空格）    → "#### "（不重复加空格）
   * - "`[描述]`\n`[描述]`"   → 原样（自带换行的多行模板保持其结构）
   */
  static ensureTrailingSpace(text: string): string {
    if (!text) return text;
    return /\s$/.test(text) ? text : text + ' ';
  }

  /**
   * 选中补全项时，光标【前】有多少字符需要被覆盖（= 查询/触发词 + 其后连续非空白输入）。
   *
   * 传入的 prefixChar 由补全流程决定：
   * - 格式补全：触发符本身（`@` / `~`）
   * - 智能补全：实际命中的查询词，可能是多个字（如「主角」），
   *   由 SimpleScriptCompleter.resolveCompletion() 解析，与替换长度严格一致。
   *
   * - "…@" + "@"        → 1（只吃掉 @）
   * - "@@" + "@"        → 1（只吃掉最后一个 @）
   * - "主角" + "主角"    → 2（吃掉整个已输入前缀）
   * - "我说主角" + "主角" → 2（只吃掉「主角」，前面的正文不动）
   * - "@ 你好" + "@"     → 1（跨越空白即停止，绝不误删既有正文）
   * - 找不到前缀字符      → 0（退化为纯插入）
   */
  static calcReplaceLength(textBefore: string, prefixChar: string): number {
    if (!prefixChar || !textBefore) return 0;
    const idx = textBefore.lastIndexOf(prefixChar);
    if (idx < 0) return 0;
    const tail = textBefore.slice(idx + prefixChar.length);
    const m = /^[^\s]*/.exec(tail);
    return prefixChar.length + (m ? m[0].length : 0);
  }

  static isEditable(el: HTMLElement | null | undefined): boolean {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      return (
        type === 'text' ||
        type === 'search' ||
        type === '' ||
        type === 'url' ||
        type === 'email'
      );
    }
    if (tag === 'textarea') return true;
    if (el.isContentEditable) return true;
    if (el.closest('.cm-editor')) return true;
    return false;
  }

  static isInExcludedContainer(el: HTMLElement | null | undefined): boolean {
    if (!el) return true;
    if (el.closest('.blfc-plugin')) return true;
    if (el.closest('.modal-container')) return true;
    if (el.closest('.blfc-edge-strips')) return true;
    if (el.closest('.suggestion-container')) return true;
    if (el.closest('.notice-container')) return true;
    return false;
  }

  static getTextBeforeCursor(el: HTMLElement): string {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const pos = cm.state.selection.main.head;
      const line = cm.state.doc.lineAt(pos);
      return line.text.substring(0, pos - line.from);
    }
    if (el.tagName && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      return inputEl.value.substring(0, inputEl.selectionStart || 0);
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.anchorNode && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.endContainer, range.endOffset);
      return preRange.toString();
    }
    return '';
  }

  static getCurrentLineText(el: HTMLElement): string {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const pos = cm.state.selection.main.head;
      const line = cm.state.doc.lineAt(pos);
      return line.text;
    }
    if (el.tagName && el.tagName.toLowerCase() === 'textarea') {
      const text = (el as HTMLTextAreaElement).value;
      const pos = (el as HTMLTextAreaElement).selectionStart || 0;
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      const lineEnd = text.indexOf('\n', pos);
      return text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
    }
    if (el.tagName && el.tagName.toLowerCase() === 'input') {
      return (el as HTMLInputElement).value || '';
    }
    return '';
  }

  static getOrCreateMirror(el: HTMLElement): HTMLPreElement {
    if (!TextInserter._mirror) {
      TextInserter._mirror = document.createElement('pre');
      TextInserter._mirror.style.cssText =
        'position:fixed;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;z-index:-1;';
      document.body.appendChild(TextInserter._mirror);
    }
    const mirror = TextInserter._mirror;
    const style = window.getComputedStyle(el);
    mirror.style.font = style.font;
    mirror.style.fontSize = style.fontSize;
    mirror.style.fontFamily = style.fontFamily;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.letterSpacing = style.letterSpacing;
    const elRect = el.getBoundingClientRect();
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    mirror.style.width = elRect.width - paddingLeft - paddingRight + 'px';
    mirror.style.padding = style.padding || '0';
    return mirror;
  }

  static getCursorScreenPosition(el: HTMLElement): CursorScreenPos {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const pos = cm.state.selection.main.head;
      const coords = cm.coordsAtPos(pos);
      if (coords) return { x: coords.left, y: coords.bottom, height: coords.bottom - coords.top };
    }
    if (el.tagName && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const mirror = TextInserter.getOrCreateMirror(el);
      const pos = inputEl.selectionStart || 0;
      const textBefore = inputEl.value.substring(0, pos);
      mirror.textContent = textBefore.replace(/\n$/, '\n\u00A0');
      const rect = el.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const lineHeight =
        parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
      return {
        x: rect.left + (mirrorRect.right - mirrorRect.left),
        y: rect.top + (mirrorRect.bottom - mirrorRect.top),
        height: lineHeight,
      };
    }
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom, height: 20 };
  }

  static getCodeMirrorView(el: HTMLElement | null | undefined): CMViewLike | null {
    if (!el || typeof el.closest !== 'function') return null;
    // 优先向上找 .cm-editor；找不到时再向下找
    // （Obsidian 中 editor.containerEl 可能是 .cm-editor 的祖先容器）
    const cmEl = (el.closest('.cm-editor') ||
      (typeof el.querySelector === 'function'
        ? el.querySelector('.cm-editor')
        : null)) as HTMLElement | null;
    if (!cmEl) return null;
    // 1) 官方支持路径：esbuild 将 @codemirror/view 设为 external，运行时由 Obsidian
    //    映射到其内部 CM6 模块；findFromDOM 读取 Obsidian 当前版本的内部标记属性
    //    （1.9.x 为 cmView，1.13.x 已改名 cmTile），跨版本稳定。
    //    注意不能直接读 (.cm-editor).cmView —— 该属性只挂在内容视图（.cm-content 等）
    //    上，.cm-editor 根节点在任何版本都没有它，直接读永远得 null。
    try {
      const view = EditorView.findFromDOM(cmEl) as unknown as CMViewLike | null;
      if (view) return view;
    } catch (e) {
      void e;
    }
    // 2) 兜底：findFromDOM 异常/为空时，尝试内部 ContentView 标记（旧版为 cmView）
    const marker = cmEl as HTMLElement & { cmView?: { view?: CMViewLike } };
    return marker.cmView?.view || null;
  }

  /** 将 CM6 EditorView 包装为 EditorLike 代理（用于场景编号 / 重编号等行级操作） */
  static createCMEditorProxy(cm: CMViewLike): EditorLike {
    return {
      getCursor: () => {
        const pos = cm.state.selection.main.head;
        const line = cm.state.doc.lineAt(pos);
        return { line: line.number - 1, ch: pos - line.from };
      },
      getLine: (n) => cm.state.doc.line(n + 1).text,
      lineCount: () => cm.state.doc.lines,
      setLine: (n, text) => {
        const line = cm.state.doc.line(n + 1);
        cm.dispatch({ changes: { from: line.from, to: line.to, insert: text } });
      },
      replaceRange: (text, pos) => {
        const line = cm.state.doc.line(pos.line + 1);
        const from = line.from + pos.ch;
        cm.dispatch({ changes: { from, insert: text } });
        cm.focus();
      },
      setSelection: (from, to) => {
        const lineFrom = cm.state.doc.line(from.line + 1);
        const lineTo = cm.state.doc.line(to.line + 1);
        cm.dispatch({
          selection: {
            anchor: lineFrom.from + from.ch,
            head: lineTo.from + to.ch,
          },
        });
        cm.focus();
      },
    };
  }

  static insertText(el: HTMLElement, text: string): void {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const from = cm.state.selection.main.head;
      cm.dispatch({
        changes: { from, insert: text },
        selection: { anchor: from + text.length },
      });
      cm.focus();
      return;
    }
    if (el.tagName && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = inputEl.selectionStart || 0;
      const end = inputEl.selectionEnd || start;
      inputEl.value = inputEl.value.substring(0, start) + text + inputEl.value.substring(end);
      const newPos = start + text.length;
      inputEl.selectionStart = newPos;
      inputEl.selectionEnd = newPos;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    document.execCommand('insertText', false, text);
  }

  /**
   * 删除光标【前】deleteBefore 个字符，再插入 text。
   * 用于选中补全项时把触发符（@ / ~ / 已输入的查询字）一并替换掉，
   * 避免触发符残留进文档（与 replaceRange 的“向后删除”方向相反）。
   */
  static replaceBeforeCursor(el: HTMLElement, text: string, deleteBefore: number): void {
    const n = Math.max(0, Math.floor(deleteBefore) || 0);
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const head = cm.state.selection.main.head;
      const from = Math.max(0, head - n);
      cm.dispatch({
        changes: { from, to: head, insert: text },
        selection: { anchor: from + text.length },
      });
      cm.focus();
      return;
    }
    if (el.tagName && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = inputEl.selectionStart || 0;
      const end = inputEl.selectionEnd || start;
      const from = Math.max(0, start - n);
      const tailStart = Math.max(end, start);
      const value = inputEl.value;
      inputEl.value = value.substring(0, from) + text + value.substring(tailStart);
      const newPos = from + text.length;
      inputEl.selectionStart = newPos;
      inputEl.selectionEnd = newPos;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contentEditable 兜底
    el.focus();
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (sel && range && range.startContainer.nodeType === Node.TEXT_NODE && n > 0) {
      const node = range.startContainer;
      const del = document.createRange();
      del.setStart(node, Math.max(0, range.startOffset - n));
      del.setEnd(node, range.startOffset);
      del.deleteContents();
      const textNode = document.createTextNode(text);
      del.insertNode(textNode);
      const after = document.createRange();
      after.setStartAfter(textNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      return;
    }
    if (sel && range) {
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      return;
    }
    for (let i = 0; i < n; i++) document.execCommand('delete');
    document.execCommand('insertText', false, text);
  }

  /**
   * 在 replaceBeforeCursor 基础上支持「插入后光标落到模板内相对位置」：
   * - cursorRel：相对 text 起点的光标偏移；null/undefined 时放文本尾（与旧行为一致）
   * - selectFrom/selectTo：相对 text 起点的选中区间（${0:默认词} 用，覆盖光标位置）
   * 仅 input/textarea 能精确到字符；contentEditable 兜底只做光标尾置。
   */
  static replaceBeforeCursorSmart(
    el: HTMLElement,
    text: string,
    deleteBefore: number,
    cursorRel: number | null,
    selectFrom?: number | null,
    selectTo?: number | null,
  ): void {
    const n = Math.max(0, Math.floor(deleteBefore) || 0);
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const head = cm.state.selection.main.head;
      const from = Math.max(0, head - n);
      const len = text.length;
      const anchor =
        from + (selectFrom != null ? selectFrom : cursorRel != null ? cursorRel : len);
      const focus =
        from +
        (selectFrom != null && selectTo != null
          ? selectTo
          : cursorRel != null
            ? cursorRel
            : len);
      cm.dispatch({
        changes: { from, to: head, insert: text },
        selection: { anchor, head: focus },
      });
      cm.focus();
      return;
    }
    if (el.tagName && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = inputEl.selectionStart || 0;
      const end = inputEl.selectionEnd || start;
      const from = Math.max(0, start - n);
      const tailStart = Math.max(end, start);
      const value = inputEl.value;
      inputEl.value = value.substring(0, from) + text + value.substring(tailStart);
      const len = text.length;
      const cursorPos = cursorRel != null ? Math.min(cursorRel, len) : len;
      const selFrom = from + (selectFrom != null ? Math.min(selectFrom, len) : cursorPos);
      const selTo = from + (selectTo != null ? Math.min(selectTo, len) : selFrom);
      inputEl.selectionStart = selFrom;
      inputEl.selectionEnd = selTo;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contentEditable 兜底：插入后光标尽量贴近 cursorRel（超尾则放尾）
    el.focus();
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (sel && range && range.startContainer.nodeType === Node.TEXT_NODE && n > 0) {
      const node = range.startContainer;
      const del = document.createRange();
      del.setStart(node, Math.max(0, range.startOffset - n));
      del.setEnd(node, range.startOffset);
      del.deleteContents();
      const textNode = document.createTextNode(text);
      del.insertNode(textNode);
      const offset = Math.min(
        cursorRel != null ? cursorRel : text.length,
        text.length,
      );
      const after = document.createRange();
      after.setStart(textNode, offset);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      return;
    }
    if (sel && range) {
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      const offset = Math.min(
        cursorRel != null ? cursorRel : text.length,
        text.length,
      );
      const after = document.createRange();
      after.setStart(textNode, offset);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      return;
    }
    for (let i = 0; i < n; i++) document.execCommand('delete');
    document.execCommand('insertText', false, text);
  }

  static replaceRange(el: HTMLElement, text: string, replaceLength: number): void {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const from = cm.state.selection.main.head;
      const to = from + replaceLength;
      cm.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      cm.focus();
      return;
    }
    if (el.tagName && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea')) {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const pos = inputEl.selectionStart || 0;
      inputEl.value =
        inputEl.value.substring(0, pos) + text + inputEl.value.substring(pos + replaceLength);
      const newPos = pos + text.length;
      inputEl.selectionStart = newPos;
      inputEl.selectionEnd = newPos;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    }
  }
}
