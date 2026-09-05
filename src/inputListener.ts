/**
 * 全局输入监听器 - 替代 EditorSuggest 机制，覆盖 Obsidian 编辑器与所有插件输入框
 */
import { TextInserter } from './textInserter';
import { FloatingSuggestPopup } from './suggestPopup';
import { offsetToLineCh } from './formatEngine';
import type { Suggestion } from './types';
import type { SimpleScriptCompleter } from './main';
import type { Editor, EventRef } from 'obsidian';

interface CursorPos {
  x: number;
  y: number;
  height: number;
}

export class GlobalInputListener {
  private popup: FloatingSuggestPopup;
  private _inputHandler: ((e: Event) => void) | null = null;
  private _editorChangeRef: EventRef | null = null;
  private lastTriggerTime = 0;
  private isActive = false;

  constructor(private plugin: SimpleScriptCompleter) {
    this.popup = new FloatingSuggestPopup(plugin);
  }

  activate(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.popup.create();

    // 1. 全局 input 事件（input / textarea / contentEditable 等非 CM 输入）
    this._inputHandler = (e) => this.onInput(e);
    document.addEventListener('input', this._inputHandler, true);

    // 2. Obsidian 编辑器变更事件（CodeMirror 6 不触发原生 input）
    this._editorChangeRef = this.plugin.app.workspace.on(
      'editor-change',
      (editor) => this.onEditorChange(editor),
    );
    if (this._editorChangeRef) this.plugin.registerEvent(this._editorChangeRef);

  }

  deactivate(): void {
    this.isActive = false;
    if (this._inputHandler) {
      document.removeEventListener('input', this._inputHandler, true);
      this._inputHandler = null;
    }
    // editor-change 由 registerEvent 自动清理
    this.popup.destroy();
  }

  // ---- 非 CodeMirror 输入（input / textarea / contentEditable） ----
  private onInput(_e: Event): void {
    if (!this.plugin.settings.enabled) return;
    const el = document.activeElement as HTMLElement | null;
    if (!el || !TextInserter.isEditable(el)) return;
    if (TextInserter.isInExcludedContainer(el)) return;
    // 跳过 CodeMirror 编辑器，由 onEditorChange 单独处理
    if (TextInserter.getCodeMirrorView(el)) return;

    this._processText(TextInserter.getTextBeforeCursor(el), el, null);
  }

  // ---- Obsidian CodeMirror 编辑器 ----
  private onEditorChange(editor: Editor): void {
    if (!this.plugin.settings.enabled) return;
    if (!editor) return;

    const cursor = editor.getCursor();
    if (!cursor) return;
    const line = editor.getLine(cursor.line);
    const textBefore = line.substring(0, cursor.ch);

    // 用当前编辑器自身的 DOM 作为定位锚点（避免多窗格时取错第一个 .cm-editor）
    const cmDom =
      (editor as unknown as { containerEl?: HTMLElement }).containerEl || null;
    this._processText(textBefore, cmDom || (document.activeElement as HTMLElement), editor);
  }

  // ---- 统一处理逻辑 ----
  private _processText(textBefore: string, el: HTMLElement, cmEditor: Editor | null): void {
    if (!textBefore) {
      // 光标前已无内容（如删空/换行），收起仍在显示的弹窗，避免悬空
      if (this.popup.isVisible()) this.popup.hide();
      return;
    }
    const cursorPos = cmEditor ? this._getCMCursorPos(cmEditor, el) : null;

    // 模板菜单：按命中触发符弹出其覆盖的分组（全局默认 @ 或分组专属触发符）
    const tmatch = this.plugin.formatsManager.findTriggerMatch(textBefore);
    if (tmatch) {
      const suggestions = this.plugin.formatsManager.expandGroups(tmatch.groupIds);
      if (suggestions.length > 0) {
        this.popup.show(
          suggestions,
          el,
          tmatch.char,
          (s, prefixChar) =>
            cmEditor
              ? this._onFormatSelectCM(cmEditor, s, prefixChar)
              : this._onFormatSelectDOM(el, s, prefixChar),
          () => {},
          cursorPos,
          tmatch.char,
        );
        return;
      }
    }

    // 已离开格式触发上下文（光标前不再是触发符）：关闭格式弹窗，避免残留旧位置
    if (
      this.popup.isVisible() &&
      this.popup.getTriggerChar() !== '' &&
      !textBefore.endsWith(this.popup.getTriggerChar())
    ) {
      this.popup.hide();
    }

    // 智能补全
    if (!this.plugin.settings.enableSmartCompletion) return;
    const now = Date.now();
    if (now - this.lastTriggerTime < 150) {
      // 节流期间若弹窗仍显示，先跟随光标微移（不重新计算建议）
      if (this.popup.isVisible()) this.popup.positionNearCursor();
      return;
    }
    this.lastTriggerTime = now;

    const lineText = cmEditor
      ? cmEditor.getLine(cmEditor.getCursor().line)
      : TextInserter.getCurrentLineText(el);
    const contextType = this.detectLineContext(lineText);

    // 查询词由插件统一解析：支持中文多字输入，且光标前是空白/标点时不再触发。
    // 返回值里的 query 同时作为插入时的替换长度依据，两者严格一致。
    const resolved = this.plugin.resolveCompletion(textBefore, contextType);

    // 最小触发：在格式位置（场景标题/角色名/动作行）即使没有输入也展示该上下文候选，
    // 方便直接挑选，而非必须先打出一个字符。
    let toShow = resolved;
    if (
      !toShow &&
      this.plugin.settings.enableMinimalTrigger &&
      (contextType === 'scene_location' ||
        contextType === 'character_name' ||
        contextType === 'action')
    ) {
      const minimal = this.plugin.getSmartSuggestionsForContext(contextType, '');
      if (minimal.length > 0) toShow = { query: '', suggestions: minimal };
    }

    if (toShow) {
      this.popup.show(
        toShow.suggestions,
        el,
        '',
        (s, prefixChar) =>
          cmEditor
            ? this._onSmartSelectCM(cmEditor, s, prefixChar)
            : this._onSmartSelectDOM(el, s, prefixChar),
        () => {},
        cursorPos,
        toShow.query,
      );
    } else if (this.popup.isVisible()) {
      // 当前字符没有匹配项：收起，避免弹窗留在错误位置
      this.popup.hide();
    }
  }

  private _getCMCursorPos(editor: Editor, fallbackEl?: HTMLElement | null): CursorPos | null {
    // Obsidian Editor 对象上没有 coordsAtPos（该方法属于 CM6 EditorView）。
    // 通过 editor.containerEl 找到 .cm-editor，用 EditorView.findFromDOM
    // （经 external 引入，运行时取 Obsidian 内部模块）解析出 EditorView，
    // 再用 coordsAtPos 获取光标的视口坐标（与 position:fixed 弹窗一致）。
    try {
      const containerEl = (editor as unknown as { containerEl?: HTMLElement }).containerEl;
      const view = containerEl ? TextInserter.getCodeMirrorView(containerEl) : null;
      if (view) {
        const head = view.state.selection.main.head;
        const coords = view.coordsAtPos(head);
        if (coords) {
          return {
            x: coords.left,
            y: coords.bottom,
            height: coords.bottom - coords.top,
          };
        }
      }
    } catch (e) {
      void e;
    }
    // 回退：限定在触发本次补全的编辑器内估算，
    // 避免多窗格时全局取到其他编辑器的第一个 .cm-content 导致弹窗定位跑偏
    const scope = fallbackEl || (editor as unknown as { containerEl?: HTMLElement }).containerEl;
    let contentEl: HTMLElement | null = null;
    if (scope) {
      const cmEl: HTMLElement | null =
        (scope.querySelector('.cm-editor') as HTMLElement | null) ||
        (scope.classList.contains('cm-editor') ? scope : null);
      contentEl =
        (cmEl ? (cmEl.querySelector('.cm-content') as HTMLElement | null) : null) ||
        (scope.classList.contains('cm-content') ? scope : null) ||
        cmEl ||
        scope;
    }
    if (contentEl) {
      const rect = contentEl.getBoundingClientRect();
      return { x: rect.left + 40, y: rect.top + 40, height: 20 };
    }
    return null;
  }

  /** 计算选中项需要覆盖（替换）的字符数，详见 TextInserter.calcReplaceLength */
  private _calcDeleteLength(textBefore: string, prefixChar: string): number {
    return TextInserter.calcReplaceLength(textBefore, prefixChar);
  }

  // ---- 选择回调：两条路径统一交给 main.insertFormatItem 渲染插入 ----
  private _onFormatSelectDOM(el: HTMLElement, suggestion: Suggestion, prefixChar: string): void {
    const len = this._calcDeleteLength(TextInserter.getTextBeforeCursor(el), prefixChar);
    this.plugin.insertFormatItem(null, el, suggestion, len);
  }

  /**
   * 确认前的过期守卫：弹窗打开到 Enter 确认之间若发生 IME 上屏 / 其它并发改动，
   * 光标前的文本可能已不再包含本次确认的查询词（prefixChar 非空但算不出替换长度）。
   * 此时继续插入会把补全文本落到错误坐标 —— 丢弃本次插入比强插更安全。
   */
  private _isStaleConfirm(textBefore: string, prefixChar: string): boolean {
    return !!prefixChar && TextInserter.calcReplaceLength(textBefore, prefixChar) === 0;
  }

  private _onSmartSelectDOM(el: HTMLElement, suggestion: Suggestion, prefixChar: string): void {
    const textBefore = TextInserter.getTextBeforeCursor(el);
    const len = this._calcDeleteLength(textBefore, prefixChar);
    if (this._isStaleConfirm(textBefore, prefixChar)) {
      console.warn(
        `[InFlow] 智能补全已过期（光标前未找到查询词「${prefixChar}」），已取消插入`,
      );
      return;
    }
    const insert = suggestion.insert ?? '';
    if (!insert) return;
    TextInserter.replaceBeforeCursor(el, insert, len);
    this.plugin.recordUsage(suggestion);
  }

  // ---- 选择回调：CM 编辑器的 Obsidian Editor API ----
  private _onFormatSelectCM(editor: Editor, suggestion: Suggestion, prefixChar: string): void {
    const cursor = editor.getCursor();
    const textBefore = editor.getLine(cursor.line).substring(0, cursor.ch);
    const len = this._calcDeleteLength(textBefore, prefixChar);
    this.plugin.insertFormatItem(editor, null, suggestion, len);
  }

  private _onSmartSelectCM(editor: Editor, suggestion: Suggestion, prefixChar: string): void {
    const cursor = editor.getCursor();
    const textBefore = editor.getLine(cursor.line).substring(0, cursor.ch);
    const len = this._calcDeleteLength(textBefore, prefixChar);
    if (this._isStaleConfirm(textBefore, prefixChar)) {
      console.warn(
        `[InFlow] 智能补全已过期（光标前未找到查询词「${prefixChar}」），已取消插入`,
      );
      return;
    }
    const insert = suggestion.insert ?? '';
    if (!insert) return;
    // 删除 [base, cursor]（查询词）后插入补全文本
    const base = { line: cursor.line, ch: Math.max(0, cursor.ch - len) };
    editor.replaceRange(insert, base, cursor);
    // 显式把光标放到补全文本末尾，不依赖 Obsidian/CM6 的默认落点（避免 IME 竞争等
    // 场景下被映射到错误位置）：单行 = base.ch + 文本长；多行 = 末行 {line, ch}。
    const rel = offsetToLineCh(insert, insert.length);
    editor.setCursor({
      line: base.line + rel.line,
      ch: rel.line === 0 ? base.ch + rel.ch : rel.ch,
    });
    this.plugin.recordUsage(suggestion);
  }

  detectLineContext(line: string): string {
    if (!line) return 'general';
    if (/^##\s/.test(line)) return 'scene_location';
    if (/^####\s/.test(line)) return 'character_name';
    if (/^#####\s/.test(line)) return 'character_name';
    if (/^`\[.*\]`$/.test(line)) return 'action';
    if (/^\*\(.*\)\*$/.test(line)) return 'action';
    return 'general';
  }
}
