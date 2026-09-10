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
        type === 'tel' ||
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

  /**
   * 输入面排除清单（2026-09-10 起放开模态窗，策略为「尽量全放开、排除搜索类」）：
   * - `.blfc-plugin`：InFlow 自身设置页/词库/模板弹窗的表单不参与（避免自我触发）
   * - `.prompt`：Obsidian 命令面板 / 快速切换 / 搜索类弹窗 —— 输入的是命令名/文件名，
   *   弹剧本补全候选会刷屏，且这类框自带键盘消费。
   *   可用 allowSearchPrompt 放开（第三方插件常把普通输入框做成 SuggestModal）。
   * - `.blfc-edge-strips` / `.suggestion-container` / `.notice-container`：彩条自身 / 建议列表 / 通知
   * 其余模态（含第三方插件 Modal）内的 input/textarea 允许触发；弹窗在模态中的
   * 层级抬升与按键策略见 suggestPopup.ts 与 styles.css。
   */
  static isInExcludedContainer(
    el: HTMLElement | null | undefined,
    opts?: { allowSearchPrompt?: boolean },
  ): boolean {
    if (!el) return true;
    if (el.closest('.blfc-plugin')) return true;
    if (!opts?.allowSearchPrompt && el.closest('.prompt')) return true;
    if (el.closest('.blfc-edge-strips')) return true;
    if (el.closest('.suggestion-container')) return true;
    if (el.closest('.notice-container')) return true;
    return false;
  }

  /**
   * el 所属窗口。弹出窗口（popout）有独立的 document / defaultView，
   * 之前一律用全局 window / document 会让测量、选区、监听全部落到主窗口上。
   */
  static windowOf(el: Node | null | undefined): Window {
    if (!el) return window;
    // 传入 Document 本身时没有 ownerDocument，用 nodeType 9 判定
    const doc = el.nodeType === 9 ? (el as Document) : el.ownerDocument;
    return (doc && doc.defaultView) || window;
  }

  /**
   * 穿透 shadow DOM 取真实焦点元素。
   * Web Component 内部的输入框：document.activeElement 只会停在宿主元素上
   * （宿主自身不可编辑 → 之前判定为「非输入面」直接跳过）。
   */
  static deepActiveElement(doc: Document | null | undefined): HTMLElement | null {
    if (!doc) return null;
    let el = doc.activeElement as HTMLElement | null;
    let guard = 0;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement as HTMLElement;
      if (++guard > 10) break;
    }
    return el;
  }

  /**
   * 从事件解析真实输入元素：
   * 1) composedPath() 里第一个可编辑元素 —— input 事件是 composed 的，会穿出 shadow DOM，
   *    但 e.target 被重定向到宿主元素，只有路径里还留着真实节点；
   * 2) 退回「穿透 shadow 的当前焦点」。
   */
  static resolveInputTarget(e: Event | null, doc?: Document | null): HTMLElement | null {
    // composedPath 在个别环境（旧版运行时 / 测试桩）可能缺失，取不到就退回焦点元素
    const path = e && typeof e.composedPath === 'function' ? e.composedPath() : null;
    if (path) {
      for (const node of path) {
        const el = node as HTMLElement;
        if (
          el &&
          el.nodeType === 1 &&
          typeof el.tagName === 'string' &&
          TextInserter.isEditable(el)
        ) {
          return el;
        }
      }
    }
    const target = (e?.target ?? null) as Node | null;
    const rootDoc = doc ?? (target ? target.ownerDocument : null) ?? document;
    return TextInserter.deepActiveElement(rootDoc);
  }

  /**
   * 是否 Obsidian 工作区自带的编辑器（Live Preview / 源码模式 / 阅读视图）。
   * 这类编辑器由 workspace 的 'editor-change' 通道处理（见 inputListener），
   * 全局 input 通道必须放行给它们，避免双通道重复触发。
   * 插件自建的 CM6 编辑器（第三方 Modal 内嵌编辑器、看板卡片、代码块编辑器等）
   * 不在这些容器里 —— 它们不触发 editor-change，必须由全局 input 通道兜住。
   */
  static isWorkspaceEditor(el: HTMLElement | null | undefined): boolean {
    if (!el || typeof el.closest !== 'function') return false;
    return !!el.closest('.markdown-source-view, .markdown-reading-view, .markdown-preview-view');
  }

  /**
   * 写值走「原生 value setter」（写在原型上的那个）。
   * React / Vue 等框架会给受控组件装 value tracker（实例级劫持 value）：
   * 直接 `el.value = x` 会让 tracker 与新值一致，框架随后判定「值没变」而丢弃该次输入
   * —— 表现就是「补全弹窗出现了，但选中后文字没进去 / 被回滚」。
   * 用原型上的原生 setter 改值，tracker 仍停留在旧值，再派发 input 事件，
   * 框架的 onChange 才能看到真实变更并同步状态。
   */
  static setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const win = TextInserter.windowOf(el) as unknown as {
      HTMLTextAreaElement: { prototype: object };
      HTMLInputElement: { prototype: object };
    };
    const ctor =
      el.tagName.toLowerCase() === 'textarea' ? win.HTMLTextAreaElement : win.HTMLInputElement;
    const desc = ctor ? Object.getOwnPropertyDescriptor(ctor.prototype, 'value') : null;
    if (desc && typeof desc.set === 'function') {
      (desc.set as (this: HTMLElement, v: string) => void).call(el, value);
    } else {
      el.value = value;
    }
  }

  /**
   * 诊断：当前焦点输入面属于哪一类、补全是否会被处理。
   * 供命令「诊断：当前输入面」使用 —— 第三方插件输入框不触发补全时，
   * 这行结论能直接指认原因（不受支持 / 被排除 / 由别的通道接管）。
   */
  static describeInputSurface(
    el: HTMLElement | null,
    opts: { allowSearchPrompt: boolean },
  ): string {
    if (!el) {
      return '未检测到焦点元素：请先点进目标插件的输入框（光标在里面）再执行本命令。';
    }
    const lines: string[] = [];
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? ` type="${(el as HTMLInputElement).type || '(空)'}"` : '';
    const cls = typeof el.className === 'string' && el.className ? ` class="${el.className.slice(0, 60)}"` : '';
    lines.push(`焦点元素: <${tag}${inputType}>${cls}`);

    const doc = el.ownerDocument;
    const win = TextInserter.windowOf(el);
    const isPopout = win !== window;
    const inShadow = typeof el.getRootNode === 'function' && el.getRootNode() !== doc;
    lines.push(
      `窗口: ${isPopout ? '弹出窗口（popout）' : '主窗口'}${inShadow ? ' · 位于 Shadow DOM 内' : ''}${el.isContentEditable ? ' · contentEditable' : ''}`,
    );

    const chain: string[] = [];
    let p: HTMLElement | null = el.parentElement;
    for (let i = 0; p && i < 6; i++) {
      const c = typeof p.className === 'string' && p.className
        ? `.${p.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
      chain.push(`${p.tagName.toLowerCase()}${c}`);
      p = p.parentElement;
    }
    lines.push(`祖先链: ${chain.join(' < ') || '(顶层)'}`);

    if (!TextInserter.isEditable(el)) {
      lines.push('判定: ✗ 不是可编辑输入面（input 类型不在白名单 / 非 contentEditable）');
    } else if (TextInserter.isInExcludedContainer(el, opts)) {
      const isPrompt = !!el.closest('.prompt');
      lines.push(
        isPrompt
          ? '判定: ✗ 属于「搜索类弹窗」(.prompt)，当前被排除。可在设置页开启「搜索类弹窗中也触发补全」。'
          : '判定: ✗ 位于排除容器内（InFlow 自身面板 / 彩条 / 建议列表 / 通知）',
      );
    } else if (TextInserter.isWorkspaceEditor(el)) {
      lines.push('判定: ✓ 由 editor-change 通道处理（Obsidian 自带编辑器）');
    } else if (TextInserter.getCodeMirrorView(el)) {
      lines.push('判定: ✓ 第三方插件自建 CodeMirror 编辑器（走全局 input 通道）');
    } else {
      lines.push(`判定: ✓ 普通输入面（input/textarea/contentEditable，走全局 input 通道）`);
    }
    return lines.join('\n');
  }

  /**
   * 取「作用域内」的当前选区。
   * 普通情况就是窗口选区；输入面在 Shadow DOM 内时，Chrome 的 shadowRoot.getSelection()
   * 才是该作用域的真实选区（window.getSelection() 可能看到的是外层）。
   */
  static selectionIn(el: HTMLElement, win: Window): Selection | null {
    const sel = win.getSelection();
    const anchor = sel?.anchorNode ?? null;
    if (sel && sel.rangeCount > 0 && anchor && (anchor === el || el.contains(anchor))) {
      return sel;
    }
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    const shadow = root as (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    if (shadow && typeof shadow.getSelection === 'function') {
      return shadow.getSelection() ?? sel;
    }
    return sel;
  }

  static getTextBeforeCursor(el: HTMLElement): string {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const pos = cm.state.selection.main.head;
      const line = cm.state.doc.lineAt(pos);
      return line.text.substring(0, pos - line.from);
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = inputEl.selectionStart;
      return inputEl.value.substring(0, typeof start === 'number' ? start : inputEl.value.length);
    }
    const win = TextInserter.windowOf(el);
    const sel = TextInserter.selectionIn(el, win);
    const anchor = sel?.anchorNode ?? null;
    if (sel && sel.rangeCount > 0 && anchor && (anchor === el || el.contains(anchor))) {
      const range = sel.getRangeAt(0);
      const preRange = win.document.createRange();
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

  /**
   * 创建/复用全局测量镜像 <pre>。只负责建节点 + 复制字体，
   * 每次测量按需覆写 width/white-space/内容（见 getCursorScreenPosition）。
   */
  static getOrCreateMirror(el: HTMLElement): HTMLPreElement {
    const doc = el.ownerDocument;
    if (!TextInserter._mirror) {
      TextInserter._mirror = doc.body.createEl('pre');
      // 静态测量样式迁移到 styles.css 的 .blfc-text-mirror（position/visibility/white-space/z-index）
      TextInserter._mirror.className = 'blfc-text-mirror';
      doc.body.appendChild(TextInserter._mirror);
    }
    const mirror = TextInserter._mirror;
    // 弹出窗口（popout）有自己的 document：镜像必须与测量目标同文档，
    // 否则在另一个 document 里量出的宽高与目标窗口的坐标系无关
    if (mirror.ownerDocument !== doc) doc.body.appendChild(mirror);
    const style = TextInserter.windowOf(el).getComputedStyle(el);
    mirror.style.font = style.font;
    mirror.style.fontSize = style.fontSize;
    mirror.style.fontFamily = style.fontFamily;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.letterSpacing = style.letterSpacing;
    return mirror;
  }

  /**
   * 原生 input/textarea 光标屏幕坐标（镜像测量）。
   *
   * 旧实现把镜像宽度钳到输入框内容宽 + pre-wrap 下量矩形宽 → 恒等于输入框宽：
   * 光标 x 永远被锚到输入框右缘（宽输入框里输入几个字时弹窗会"离光标很远"），
   * 多行文本高度叠加还会让 y 跑远。
   *
   * 现改为逐行精确测量：
   * - 横向：只测光标所在行的文本（white-space:pre + width:max-content 不折行），
   *   宽度即该行文本真实宽度；超宽时按可视内容宽折算折行后的可见列位；
   * - 纵向：光标上方已换行数 × lineHeight（textarea 上方行按 \n 计数，
   *   早前行的视觉折行在本插件主要输入面——单行表单——无影响）。
   */
  static getCursorScreenPosition(el: HTMLElement): CursorScreenPos {
    const cm = TextInserter.getCodeMirrorView(el);
    if (cm) {
      const pos = cm.state.selection.main.head;
      const coords = cm.coordsAtPos(pos);
      if (coords) return { x: coords.left, y: coords.bottom, height: coords.bottom - coords.top };
    }
    const win = TextInserter.windowOf(el);
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = inputEl.selectionStart;
      const pos = typeof start === 'number' ? start : inputEl.value.length;
      const textBefore = inputEl.value.substring(0, pos);
      const style = win.getComputedStyle(el);
      const fontSize = parseFloat(style.fontSize) || 14;
      const lineHeight =
        parseFloat(style.lineHeight) || fontSize * 1.2 || 16;
      const rect = el.getBoundingClientRect();
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padRight = parseFloat(style.paddingRight) || 0;
      const padBottom = parseFloat(style.paddingBottom) || 0;

      const parts = textBefore.split('\n');
      const caretLineText = parts[parts.length - 1] || '';
      const newlinesAbove = parts.length - 1;

      // 水平：光标行文本真实宽度（width:max-content + white-space:pre 由 .blfc-text-mirror 提供，
      // 尾随空格由 DOM 文本节点 + pre 原样保留）
      const mirror = TextInserter.getOrCreateMirror(el);
      mirror.textContent = caretLineText;
      const caretLineWidth = mirror.getBoundingClientRect().width;

      // 折行近似：内容可视宽 = 输入框宽 - 内边距 - 边框
      const contentWidth = rect.width - padLeft - padRight - borderLeft;
      const wrapsInCaretLine =
        contentWidth > 0 && caretLineWidth > contentWidth
          ? Math.ceil(caretLineWidth / contentWidth) - 1
          : 0;
      const visibleWidthAtCaret =
        wrapsInCaretLine > 0 ? caretLineWidth - wrapsInCaretLine * contentWidth : caretLineWidth;
      const x =
        rect.left + borderLeft + padLeft +
        Math.min(Math.max(visibleWidthAtCaret, 0), Math.max(contentWidth, 0));

      // 垂直：上方行数 × 行高（textarea 的 \n 上方行 + 光标行自身折行），
      // 结果约束在输入框可视区底边内，避免镜像估算越界。
      const visualRowsAbove = newlinesAbove + wrapsInCaretLine;
      const bottomLimit = rect.bottom - borderTop - padBottom;
      const topBase = rect.top + borderTop + padTop;
      let y = topBase + Math.max(0, visualRowsAbove) * lineHeight + lineHeight;
      y = Math.min(Math.max(y, topBase + lineHeight), Math.max(bottomLimit, topBase + lineHeight));

      return { x, y, height: lineHeight };
    }
    // 普通 contentEditable（非 CM）：直接量真实 Selection range 的矩形
    const sel = TextInserter.selectionIn(el, win);
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (range.startContainer && el.contains(range.startContainer)) {
        const r = range.getBoundingClientRect();
        if (r && r.width + r.height > 0) {
          return { x: r.left, y: r.bottom, height: r.height || 16 };
        }
      }
    }
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom, height: 20 };
  }

  /**
   * 定位 el 所属（或内含）的 .cm-editor 根元素。
   * 先向上找（el 在编辑器内部）；找不到再向下找
   * （Obsidian 中 editor.containerEl 可能是 .cm-editor 的祖先容器）。
   * Live Preview 表格的内嵌编辑器同样以 .cm-editor 子树挂载在 widget 内，
   * 从焦点元素向上会命中离光标最近的那一个。
   */
  static getCodeMirrorElement(el: HTMLElement | null | undefined): HTMLElement | null {
    if (!el || typeof el.closest !== 'function') return null;
    return (
      el.closest<HTMLElement>('.cm-editor') ||
      (typeof el.querySelector === 'function'
        ? el.querySelector<HTMLElement>('.cm-editor')
        : null) ||
      null
    );
  }

  static getCodeMirrorView(el: HTMLElement | null | undefined): CMViewLike | null {
    const cmEl = TextInserter.getCodeMirrorElement(el);
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
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : 0;
      const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : start;
      TextInserter.setInputValue(
        inputEl,
        inputEl.value.substring(0, start) + text + inputEl.value.substring(end),
      );
      const newPos = start + text.length;
      inputEl.selectionStart = newPos;
      inputEl.selectionEnd = newPos;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    const win = TextInserter.windowOf(el);
    win.document.execCommand('insertText', false, text);
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
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : 0;
      const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : start;
      const from = Math.max(0, start - n);
      const tailStart = Math.max(end, start);
      const value = inputEl.value;
      TextInserter.setInputValue(
        inputEl,
        value.substring(0, from) + text + value.substring(tailStart),
      );
      const newPos = from + text.length;
      inputEl.selectionStart = newPos;
      inputEl.selectionEnd = newPos;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contentEditable 兜底
    el.focus();
    const win = TextInserter.windowOf(el);
    const sel = TextInserter.selectionIn(el, win);
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (sel && range && range.startContainer.nodeType === 3 && n > 0) {
      const node = range.startContainer;
      const del = win.document.createRange();
      del.setStart(node, Math.max(0, range.startOffset - n));
      del.setEnd(node, range.startOffset);
      del.deleteContents();
      const textNode = win.document.createTextNode(text);
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
      range.insertNode(win.document.createTextNode(text));
      range.collapse(false);
      return;
    }
    for (let i = 0; i < n; i++) win.document.execCommand('delete');
    win.document.execCommand('insertText', false, text);
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
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : 0;
      const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : start;
      const from = Math.max(0, start - n);
      const tailStart = Math.max(end, start);
      const value = inputEl.value;
      TextInserter.setInputValue(
        inputEl,
        value.substring(0, from) + text + value.substring(tailStart),
      );
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
    const win = TextInserter.windowOf(el);
    const sel = TextInserter.selectionIn(el, win);
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (sel && range && range.startContainer.nodeType === 3 && n > 0) {
      const node = range.startContainer;
      const del = win.document.createRange();
      del.setStart(node, Math.max(0, range.startOffset - n));
      del.setEnd(node, range.startOffset);
      del.deleteContents();
      const textNode = win.document.createTextNode(text);
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
      const textNode = win.document.createTextNode(text);
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
    for (let i = 0; i < n; i++) win.document.execCommand('delete');
    win.document.execCommand('insertText', false, text);
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
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
      const pos = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : 0;
      TextInserter.setInputValue(
        inputEl,
        inputEl.value.substring(0, pos) + text + inputEl.value.substring(pos + replaceLength),
      );
      const newPos = pos + text.length;
      inputEl.selectionStart = newPos;
      inputEl.selectionEnd = newPos;
      inputEl.focus();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    const win = TextInserter.windowOf(el);
    const sel = TextInserter.selectionIn(el, win);
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(win.document.createTextNode(text));
      range.collapse(false);
    }
  }
}
