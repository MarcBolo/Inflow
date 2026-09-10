/**
 * 悬浮建议弹窗 - 替代 Obsidian EditorSuggest 的自定义弹窗
 */
import { TextInserter } from './textInserter';
import type { Suggestion } from './types';
import { setCssVar } from './dom';

interface CursorPos {
  x: number;
  y: number;
  height: number;
}

/** 第二参数为触发/前缀字符（@ / ~ 或智能补全的查询字），插入时用它计算要覆盖的长度 */
type SelectCallback = (suggestion: Suggestion, prefixChar: string) => void;
type CloseCallback = () => void;

export class FloatingSuggestPopup {
  private container: HTMLElement | null = null;
  private items: Suggestion[] = [];
  private selectedIndex = 0;
  private onSelect: SelectCallback | null = null;
  private onClose: CloseCallback | null = null;
  private targetEl: HTMLElement | null = null;
  private triggerChar = '';
  private prefixChar = '';
  private _cursorPos: CursorPos | null = null;
  private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private _clickHandler: ((e: MouseEvent) => void) | null = null;
  private _scrollHandler: ((e: Event) => void) | null = null;
  private _resizeHandler: (() => void) | null = null;
  private _rafId: number | null = null;
  /** 发起 rAF 的窗口（弹出窗口的 rAF 必须由该窗口取消，不能用主窗口的） */
  private _rafWin: Window | null = null;
  /** 当前事件监听绑定所在的 document / window（弹出窗口与主窗口分开） */
  private _boundDoc: Document | null = null;
  private _boundWin: Window | null = null;
  private _clickBindTimer: number | null = null;
  /** 上次渲染的列表签名：内容未变时复用全部 DOM 节点，跳过 innerHTML 清空重建 */
  private _renderedSig: string | null = null;
  /**
   * 用户是否已明确在弹窗中导航过（方向键或鼠标悬停）。
   * Enter 确认策略：有查询词或触发符（如 @）时，无论是否导航过都直接确认高亮项；
   * 仅「空查询常驻弹窗」（minimal-trigger 自动弹出、尚未输入文字）且未导航过时，
   * Enter 才放行给编辑器做换行。Tab 一律放行（缩进/焦点切换），不参与确认。
   */
  private armed = false;

  constructor(private plugin: unknown) {
    void plugin;
  }

  create(doc: Document = document): void {
    if (this.container) return;
    this.container = doc.body.createDiv();
    this.container.className = 'blfc-suggest-popup';
    // 显示/隐藏由 blfc-popup-hidden 状态类控制，视觉样式见 styles.css
    this.container.addClass('blfc-popup-hidden');
    doc.body.appendChild(this.container);
  }

  /** 弹窗所属 document：跟随输入面（弹出窗口里的输入框必须在本窗口内渲染弹窗） */
  private _doc(): Document {
    return this.targetEl?.ownerDocument ?? document;
  }

  /** 弹窗所属窗口：测量 / 监听 / 定时器都要用目标窗口的，不能用全局 window */
  private _win(): Window {
    return this._doc().defaultView ?? window;
  }

  /**
   * 保证弹窗节点位于目标 document 内。
   * 弹出窗口（popout）是独立 document：固定定位的弹窗只有在同一 document 里
   * 才会覆盖在该窗口上，坐标才与目标窗口的视口一致。appendChild 会自动把
   * 节点从原父节点摘除，因此主窗口 ↔ 弹出窗口来回切换时不会残留副本。
   */
  private _ensureOwnerDocument(): void {
    if (!this.container) return;
    const doc = this._doc();
    if (this.container.ownerDocument !== doc && doc.body) {
      doc.body.appendChild(this.container);
    }
  }

  show(
    items: Suggestion[],
    targetEl: HTMLElement | null,
    triggerChar: string,
    onSelect: SelectCallback,
    onClose: CloseCallback,
    cursorPos?: CursorPos | null,
    prefixChar = '',
  ): void {
    // 记录弹窗打开前的状态，供 _retainHighlight 判断是否保留上次高亮项
    const wasVisible = this.isVisible();
    const prevItems = this.items;
    const prevSelected = this.selectedIndex;
    this.items = items;
    this.targetEl = targetEl;
    this.triggerChar = triggerChar;
    this.prefixChar = prefixChar || triggerChar;
    this.onSelect = onSelect;
    this.onClose = onClose;
    // 打字筛选（弹窗持续可见）时保留上次高亮项，首次弹出/重新打开回到第 0 项
    this.selectedIndex = this._retainHighlight(items, prevItems, prevSelected, wasVisible);
    this.armed = false;
    this._cursorPos = cursorPos || null;
    if (!this.container) this.create(this._doc());
    else this._ensureOwnerDocument();
    // 弹窗正在显示时先解绑旧监听/旧定时器，避免重复累积
    if (this.isVisible()) this.unbindEvents();
    this.renderItems();
    // 先显示再定位：positionNearCursor 依赖 offsetWidth/offsetHeight 取真实渲染尺寸
    this.container!.removeClass('blfc-popup-hidden');
    this.positionNearCursor();
    // 定位时若发现光标已滚出视口会被收起（display:none），此时无需再挂事件
    if (!this.isVisible()) return;
    this.bindEvents();
    // 布局测量稳定后再校准一次（首次 coordsAtPos 可能基于上一帧布局）
    this._scheduleRefresh();
  }

  hide(): void {
    if (this.container) this.container.addClass('blfc-popup-hidden');
    this.unbindEvents();
    if (this.onClose) {
      const cb = this.onClose;
      this.onClose = null;
      cb();
    }
  }

  isVisible(): boolean {
    return !!this.container && !this.container.classList.contains('blfc-popup-hidden');
  }

  /** 当前弹窗的触发字符（'' 表示智能补全） */
  getTriggerChar(): string {
    return this.triggerChar;
  }

  /**
   * 弹窗当前是否依附于「模态窗内的输入面」。
   * 2026-09-10 起放开模态输入：true 时弹窗层级抬到该模态之上
   * （styles.css 的 .blfc-popup-in-modal），且避让边界改用模态对话框矩形。
   */
  private isAnchoredInModal(): boolean {
    if (!this.targetEl || typeof this.targetEl.closest !== 'function') return false;
    return !!this.targetEl.closest('.modal-container');
  }

  /**
   * 按键是否来自弹窗所依附的编辑区域。
   * 弹窗的 keydown 监听挂在 document 捕获阶段，若不收窄作用域，
   * 弹窗可见期间任何输入框（命令面板、其他窗格）的 Enter / Tab 都会被吞掉。
   */
  private isEventFromTarget(e: KeyboardEvent): boolean {
    if (!this.targetEl) return false;
    const target = e.target as Node | null;
    if (!target) return false;
    return target === this.targetEl || this.targetEl.contains(target);
  }

  /**
   * 渲染行序列：条目前插入分组头（相邻同组不重复）。分组头不是可选条目。
   * 条目行保序等同 items —— data-index 即条目的真实下标，键盘导航只对条目生效。
   */
  private buildRows(): Array<
    | { kind: 'head'; text: string }
    | { kind: 'item'; suggestion: Suggestion; index: number }
  > {
    const rows: Array<
      | { kind: 'head'; text: string }
      | { kind: 'item'; suggestion: Suggestion; index: number }
    > = [];
    let lastGroup: string | null = null;
    this.items.forEach((suggestion, index) => {
      const g = suggestion.group || '';
      if (g && g !== lastGroup) {
        rows.push({ kind: 'head', text: g });
      }
      lastGroup = g || lastGroup;
      rows.push({ kind: 'item', suggestion, index });
    });
    return rows;
  }

  private renderRow(row: { kind: 'head'; text: string } | { kind: 'item'; suggestion: Suggestion; index: number }): void {
    if (row.kind === 'head') {
      const head = this.container!.createDiv();
      head.className = 'blfc-suggest-head';
      head.textContent = row.text;
      this.container!.appendChild(head);
      return;
    }
    const { suggestion, index } = row;
    const el = this.container!.createDiv();
    el.className = 'blfc-suggest-item';
    el.setAttribute('data-index', String(index));
    if (index === this.selectedIndex) {
      el.addClass('blfc-is-selected');
      el.addClass('blfc-preview-on');
    }

    // 名称行：类别色点 + 显示文本
    const rowEl = el.createDiv();
    rowEl.className = 'blfc-suggest-row';

    const dotEl = rowEl.createSpan();
    dotEl.className = `blfc-suggest-dot blfc-dot-${this.dotFamily(suggestion.type)}`;

    const nameEl = rowEl.createSpan();
    nameEl.className = 'blfc-suggest-name';
    const displayText = suggestion.display || suggestion.name || '';
    nameEl.textContent = displayText;

    rowEl.appendChild(dotEl);
    rowEl.appendChild(nameEl);
    el.appendChild(rowEl);

    // 描述：词条格式 {描述} 字段的内容，另起一行展示（淡色小字，最多两行）
    const descText = (suggestion.description || '').trim();
    if (descText) {
      const descEl = el.createDiv();
      descEl.className = 'blfc-suggest-desc';
      descEl.textContent = descText;
      descEl.title = descText;
      el.appendChild(descEl);
    }

    // 预览：默认隐藏，仅在选中/悬停时展开（渐进式披露，避免弹窗被重复色块淹没）。
    // 插入内容与显示文本完全相同时（词条格式未配 {插入}、回退为显示文本）不再重复展示。
    const preview = (suggestion.insert || suggestion.template || '').trim();
    if (preview && preview !== displayText.trim()) {
      const previewEl = el.createDiv();
      previewEl.textContent = preview;
      previewEl.className = 'blfc-suggest-preview';
      el.appendChild(previewEl);
    }

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.selectItem(index);
    });
    el.addEventListener('mouseenter', () => {
      this.armed = true;
      this.highlightItem(index);
    });
    this.container!.appendChild(el);
  }

  renderItems(): void {
    if (!this.container) return;

    const rows = this.buildRows();
    // 列表内容（分组 | display | insert | type）未变且节点数一致时，直接复用 DOM、仅刷新高亮，
    // 避免每次 show（每次按键）都 innerHTML 清空 + 全量重建节点。
    const sig = rows
      .map((r) =>
        r.kind === 'head'
          ? `H\u0000${r.text}`
          : `I\u0000${r.suggestion.display}\u0000${r.suggestion.insert}\u0000${r.suggestion.description ?? ''}\u0000${r.suggestion.type}\u0000${r.suggestion.group}`,
      )
      .join('\u0001');
    if (
      this._renderedSig === sig &&
      rows.length > 0 &&
      this.container.childElementCount === rows.length
    ) {
      this.highlightItem(this.selectedIndex);
      return;
    }
    this._renderedSig = sig;

    this.container.replaceChildren();
    if (this.items.length === 0) {
      const empty = this.container.createDiv();
      empty.className = 'blfc-suggest-empty';
      empty.textContent = '无匹配结果';
      this.container.appendChild(empty);
      return;
    }

    rows.forEach((row) => this.renderRow(row));
  }

  /**
   * 类别 → 色点色系。
   * 只分四族：场景空间 / 角色台词 / 动作转场 / 其他。
   * 族过多会让色点本身变成噪声，反而违背降噪初衷。
   */
  private dotFamily(type?: string): string {
    if (!type) return 'other';
    if (type === 'scene' || type === 'scene_time_combo' || type === 'location') return 'scene';
    if (type === 'character' || type === 'dialogue' || type === 'dialogue_combo') {
      return 'character';
    }
    if (
      type === 'action' ||
      type === 'technique' ||
      type === 'skill' ||
      type === 'transition' ||
      type === 'sound'
    ) {
      return 'action';
    }
    return 'other';
  }

  /**
   * 弹窗持续显示（打字筛选）时保留上次高亮项：上次选中项若仍在新的候选列表里
   * 则返回其新下标，否则返回 0。首次弹出/重新打开一律回到第 0 项。
   * 匹配按条目签名而非下标：格式条目用稳定 id，智能补全用 group|name|display|insert
   * 组合，避免列表增删/排序变化后高亮错位。
   */
  private _retainHighlight(
    items: Suggestion[],
    prevItems: Suggestion[],
    prevSelected: number,
    wasVisible: boolean,
  ): number {
    if (!wasVisible || prevItems.length === 0 || items.length === 0) return 0;
    const prev = prevItems[Math.min(prevSelected, prevItems.length - 1)];
    if (!prev) return 0;
    const sig = (s: Suggestion): string =>
      s.id
        ? `id\u0000${s.id}`
        : `key\u0000${s.group ?? ''}\u0000${s.name ?? ''}\u0000${s.display ?? ''}\u0000${s.insert ?? ''}\u0000${s.description ?? ''}`;
    const prevSig = sig(prev);
    const ni = items.findIndex((s) => sig(s) === prevSig);
    return ni >= 0 ? ni : 0;
  }

  highlightItem(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.selectedIndex = index;
    const items = this.container!.querySelectorAll('.blfc-suggest-item');
    items.forEach((el, i) => {
      const item = el as HTMLElement;
      const on = i === index;
      // 高亮与预览展开都走 class，由 styles.css 统一控制，不再写内联 background
      item.classList.toggle('blfc-is-selected', on);
      item.classList.toggle('blfc-preview-on', on);
    });
    const item = items[index] as HTMLElement | undefined;
    // 只在弹窗内部滚动到选中项，避免带动编辑器/页面滚动
    if (item && this.container) {
      const listTop = this.container.getBoundingClientRect().top;
      const listBottom = this.container.getBoundingClientRect().bottom;
      const itemTop = item.getBoundingClientRect().top;
      const itemBottom = item.getBoundingClientRect().bottom;
      if (itemTop < listTop) this.container.scrollTop += itemTop - listTop;
      else if (itemBottom > listBottom) this.container.scrollTop += itemBottom - listBottom;
    }
  }

  selectItem(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const suggestion = this.items[index];
    const prefixChar = this.prefixChar;
    this.hide();
    if (this.onSelect) {
      const cb = this.onSelect;
      this.onSelect = null;
      cb(suggestion, prefixChar);
    }
  }

  positionNearCursor(): void {
    if (!this.container) return;
    const pos = this._measureCursorPos();
    if (pos) this._applyPosition(pos);
  }

  /**
   * 当前真实焦点元素。
   * 穿透 shadow DOM；且不能写 `instanceof HTMLElement` —— 弹出窗口（popout）里的元素
   * 属于另一个 realm，用主窗口的构造函数判断会恒为 false。
   */
  private _activeEl(): HTMLElement | null {
    const el = TextInserter.deepActiveElement(this._doc());
    if (el && el.nodeType === 1 && typeof el.tagName === 'string') return el;
    return null;
  }

  /**
   * 取定位锚元素：真实焦点优先（表格单元格内嵌编辑器/模态输入框），
   * 焦点不可编辑时退回弹窗打开时依附的元素。
   */
  private _pickAnchorEl(): HTMLElement | null {
    const ae = this._activeEl();
    if (ae) {
      if (TextInserter.isEditable(ae)) return ae;
      if (ae.closest('.cm-editor')) return ae;
    }
    return this.targetEl;
  }

  /**
   * 实时测量光标位置（每次都以当前光标为准）；失败时回退到打开时传入的快照。
   *
   * 表格修复（2026-09-10）：Live Preview 表格是 cm-table-widget 替换块，单元格输入
   * 发生在 widget 内嵌编辑器上；主编辑器对“被替换区内的文档位置”coordsAtPos 返回
   * null 或整块矩形 → 必须以可视光标元素（.cm-cursor）为准，坐标测不到就收起，
   * 绝不落到「内容区左上 +40px」这类会制造远处弹窗的假锚点。
   */
  private _measureCursorPos(): CursorPos | null {
    const anchor = this._pickAnchorEl();
    if (!anchor) return this._cursorPos || null;

    const cmEl = TextInserter.getCodeMirrorElement(anchor);
    if (cmEl) {
      const cm = TextInserter.getCodeMirrorView(cmEl);
      if (cm) {
        try {
          const head = cm.state.selection.main.head;
          const coords = cm.coordsAtPos(head);
          const caret = this._visibleCaretRect(cmEl, coords);
          if (caret) {
            return {
              x: caret.left,
              y: caret.bottom,
              height: Math.max(1, caret.bottom - caret.top),
            };
          }
          if (
            coords &&
            Number.isFinite(coords.left) &&
            Number.isFinite(coords.bottom)
          ) {
            return {
              x: coords.left,
              y: coords.bottom,
              height: coords.bottom - coords.top,
            };
          }
        } catch (e) {
          void e;
        }
      }
      // 有 CM 元素但拿不到视图/坐标：仍试一次可视光标（表格嵌套编辑器、隐藏视图等）
      const caret = this._visibleCaretRect(cmEl, null);
      if (caret) {
        return { x: caret.left, y: caret.bottom, height: Math.max(1, caret.bottom - caret.top) };
      }
      return this._cursorPos || null;
    }

    // 原生表单元素（input / textarea / 普通 contentEditable）
    const ae = this._activeEl();
    const el = ae && TextInserter.isEditable(ae) ? ae : anchor;
    const isPlainEditable =
      !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    if (isPlainEditable) {
      try {
        const p = TextInserter.getCursorScreenPosition(el);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
      } catch (e) {
        void e;
      }
    }
    return this._cursorPos || null;
  }

  /**
   * 可视光标锚点：优先取编辑器子树内真正显示的光标元素（.cm-cursor）。
   * - 焦点在表格 widget 内时，优先该 widget 子树里的光标（Live Preview 表格单元格
   *   的光标就挂在 cm-table-widget 的内嵌编辑器上）；
   * - 有 coordsAtPos 参考坐标时取几何上最近的光标，避免多编辑器并存时取错；
   * - 都找不到时，退回表格被选中单元格自身的矩形（多选/整块选中时光标层会被
   *   Obsidian CSS 隐藏，此时单元格是唯一可见锚点）。
   */
  private _visibleCaretRect(
    cmEl: HTMLElement,
    preferNear: { left: number; bottom: number } | null,
  ): { left: number; top: number; bottom: number } | null {
    if (!cmEl || typeof cmEl.querySelectorAll !== 'function') return null;

    const focusEl = this._activeEl();
    const focusInWidget = !!focusEl?.closest?.('.cm-table-widget');
    const widgetScope =
      focusInWidget && focusEl ? focusEl.closest('.cm-table-widget') : null;

    const cursorEls = Array.from(cmEl.querySelectorAll<HTMLElement>('.cm-cursor'));
    const visible: Array<{ el: HTMLElement; r: DOMRect }> = [];
    const win = this._win();
    for (const el of cursorEls) {
      if (el.classList.contains('cm-cursor-secondary')) continue;
      const st = win.getComputedStyle(el);
      // display/visibility 隐藏 = 光标层被关（如表格整块选中态）；opacity 忽略——
      // 光标 blink 的“灭”相位正是 opacity:0，几何依然有效，不应被排除
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) continue;
      if (r.bottom < -2 || r.top > win.innerHeight + 2) continue;
      visible.push({ el, r });
    }

    const pick = (
      list: Array<{ el: HTMLElement; r: DOMRect }>,
    ): { left: number; top: number; bottom: number } | null => {
      if (list.length === 0) return null;
      let best = list[0];
      if (preferNear) {
        let bestD = Infinity;
        for (const item of list) {
          const cx = (item.r.left + item.r.right) / 2;
          const cy = (item.r.top + item.r.bottom) / 2;
          const d = Math.abs(cx - preferNear.left) + Math.abs(cy - preferNear.bottom);
          if (d < bestD) {
            bestD = d;
            best = item;
          }
        }
      }
      return { left: best.r.left, top: best.r.top, bottom: best.r.bottom };
    };

    if (widgetScope) {
      const scoped = visible.filter((v) => v.el.closest('.cm-table-widget') === widgetScope);
      const hit = pick(scoped.length > 0 ? scoped : visible);
      if (hit) return hit;
    } else {
      const hit = pick(visible);
      if (hit) return hit;
    }

    // 兜底：表格选中态（光标层被隐藏）→ 用被选中/聚焦单元格矩形近似
    const widget =
      widgetScope || cmEl.querySelector<HTMLElement>('.cm-table-widget');
    if (widget) {
      const cell = widget.querySelector<HTMLElement>(
        'td.is-selected, th.is-selected, td:focus-within, th:focus-within',
      );
      if (cell) {
        const r = cell.getBoundingClientRect();
        const st = win.getComputedStyle(cell);
        const pl = parseFloat(st.paddingLeft) || 8;
        const top = parseFloat(st.paddingTop) || 4;
        return {
          left: r.left + pl,
          top: r.top + top,
          bottom: r.top + top + 20,
        };
      }
    }
    return null;
  }

  /** 按光标坐标排版，并做视口/模态避让：贴光标、不溢出、滚动时跟随 */
  private _applyPosition(pos: CursorPos): void {
    const container = this.container!;
    // 模态窗内的输入面：层级抬到该模态之上（styles.css .blfc-popup-in-modal）
    container.classList.toggle('blfc-popup-in-modal', this.isAnchoredInModal());

    const MARGIN = 8;
    const GAP = 4;

    // 边界：普通编辑器用整个窗口；依附模态输入时改用模态对话框矩形
    // （弹窗仍 fixed 于 body，坐标为视口系，用偏移换算即可）
    const win = this._win();
    let vw = win.innerWidth;
    let vh = win.innerHeight;
    let ox = 0;
    let oy = 0;
    if (this.isAnchoredInModal()) {
      const modal = this.targetEl?.closest?.('.modal-container .modal') as HTMLElement | null;
      const mr = modal ? modal.getBoundingClientRect() : null;
      if (mr && mr.width > 0) {
        ox = mr.left;
        oy = mr.top;
        vw = mr.width;
        vh = mr.height;
      }
    }

    // 光标已滚出可视区：收起，避免弹窗悬在错误位置
    if (pos.y < oy - MARGIN || pos.y > oy + vh + MARGIN) {
      this.hide();
      return;
    }

    // 以实际渲染宽/高为准（受 styles.css max-height 限制）
    const popupWidth = container.offsetWidth || 200;
    // 未渲染时的兜底估算：单行态每条约 28px（选中项展开预览会略高，由实测值覆盖）
    const popupHeight =
      container.offsetHeight || Math.min(this.items.length * 28 + 6, 200);

    // 水平：以光标所在列为左缘，放不下时整体左移；内容过宽时按可视区压缩
    let left = pos.x;
    let maxWidth = 'none'; // 与 styles.css 默认一致：不限制宽度
    const minLeft = ox + MARGIN;
    const maxLeft = ox + vw - MARGIN - popupWidth;
    if (maxLeft < minLeft) {
      maxWidth = `${vw - MARGIN * 2}px`;
      left = minLeft;
    } else {
      if (left > maxLeft) left = maxLeft;
      if (left < minLeft) left = minLeft;
    }

    // 垂直：优先贴光标下方，下方不足一行高度时上移到光标上方
    let top = pos.y + GAP;
    let maxHeight = '200px'; // styles.css 默认上限；下方空间不足时压缩
    const belowSpace = oy + vh - top - MARGIN;
    if (popupHeight > belowSpace) {
      if (belowSpace >= 48) {
        // 下方空间不足但仍可容纳一行以上：压缩高度，保持弹窗在光标下方
        maxHeight = `${Math.floor(belowSpace)}px`;
      } else {
        // 下方几乎无空间：上移紧贴光标上方（恢复完整高度）
        maxHeight = '200px';
        top = pos.y - popupHeight - GAP;
      }
    }
    const minTop = oy + MARGIN;
    if (top < minTop) top = minTop;

    // 位置/尺寸统一经 CSS 自定义属性写入（.blfc-suggest-popup 的 left/top/max-* 消费），不写内联样式
    setCssVar(container, '--blfc-pop-left', `${left}px`);
    setCssVar(container, '--blfc-pop-top', `${top}px`);
    setCssVar(container, '--blfc-pop-maxw', maxWidth);
    setCssVar(container, '--blfc-pop-maxh', maxHeight);
  }

  /** 用 rAF 合并高频事件（滚动/缩放），弹窗显示时始终贴近光标 */
  private _scheduleRefresh(): void {
    if (!this.isVisible()) return;
    if (this._rafId != null) return;
    const win = this._win();
    this._rafWin = win;
    this._rafId = win.requestAnimationFrame(() => {
      this._rafId = null;
      if (this.isVisible()) this.positionNearCursor();
    });
  }

  bindEvents(): void {
    this._keydownHandler = (e) => {
      if (!this.isVisible()) return;

      // 输入法组字/选词期间一律放行，不参与任何按键判定。
      // keyCode 229 是部分 IME 在 composition 期间上报的兼容码。
      if (e.isComposing || e.keyCode === 229) return;

      // 作用域策略（2026-09-10 起支持模态内输入面）：
      // 只处理「来自弹窗所依附输入区域」的按键；其它区域的按键一律放行——
      // 包括模态的列表导航、页面控件、另一编辑器的打字。
      // 唯一的例外：Esc 全局收起弹窗但绝不拦截（让模态/页面自行处理关闭）。
      if (!this.isEventFromTarget(e)) {
        if (e.key === 'Escape') this.hide();
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          if (!this.isEventFromTarget(e)) return;
          e.preventDefault();
          e.stopPropagation();
          this.armed = true;
          this.highlightItem(Math.min(this.selectedIndex + 1, this.items.length - 1));
          break;
        case 'ArrowUp':
          if (!this.isEventFromTarget(e)) return;
          e.preventDefault();
          e.stopPropagation();
          this.armed = true;
          this.highlightItem(Math.max(this.selectedIndex - 1, 0));
          break;
        case 'Enter':
          if (!this.isEventFromTarget(e)) return;
          // 智能区分：有查询词（prefixChar 非空）或触发符（triggerChar 非空，如 @）
          // 时，Enter 直接确认当前高亮项；仅当「空查询常驻弹窗」（minimal-trigger
          // 自动弹出、尚未输入文字）且用户还没用方向键/悬停导航时，才把 Enter 原样
          // 交给编辑器做换行（收起弹窗、不拦截；随后的 editor-change 会按新上下文重算）。
          if (
            !this.armed &&
            this.prefixChar.length === 0 &&
            this.triggerChar === ''
          ) {
            this.hide();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          this.selectItem(this.selectedIndex);
          break;
        // Tab 不参与确认：无对应 case，一律放行给编辑器做缩进/焦点切换
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          this.hide();
          break;
      }
    };
    this._clickHandler = (e) => {
      if (this.isVisible() && this.container && !this.container.contains(e.target as Node)) {
        this.hide();
      }
    };
    // 滚动/缩放期间保持弹窗贴合光标（捕获阶段可收到任意滚动容器的事件）
    this._scrollHandler = () => this._scheduleRefresh();
    this._resizeHandler = () => this._scheduleRefresh();

    // 监听挂在「弹窗所依附输入面所在的 document / window」上：
    // 弹出窗口（popout）是独立 document，挂到主窗口会漏掉那里的按键与滚动
    const doc = this._doc();
    const win = this._win();
    this._boundDoc = doc;
    this._boundWin = win;
    doc.addEventListener('keydown', this._keydownHandler, true);
    doc.addEventListener('scroll', this._scrollHandler, true);
    win.addEventListener('resize', this._resizeHandler);
    // 延迟绑定点击关闭：避免刚由 mousedown 触发的打开动作被立刻判定为“点击外部”而关闭
    if (this._clickBindTimer != null) {
      win.clearTimeout(this._clickBindTimer);
      this._clickBindTimer = null;
    }
    this._clickBindTimer = win.setTimeout(() => {
      this._clickBindTimer = null;
      doc.addEventListener('mousedown', this._clickHandler!, true);
    }, 50);
  }

  unbindEvents(): void {
    const doc = this._boundDoc ?? this._doc();
    const win = this._boundWin ?? this._win();
    if (this._keydownHandler) {
      doc.removeEventListener('keydown', this._keydownHandler, true);
      this._keydownHandler = null;
    }
    if (this._clickHandler) {
      doc.removeEventListener('mousedown', this._clickHandler, true);
      this._clickHandler = null;
    }
    if (this._scrollHandler) {
      doc.removeEventListener('scroll', this._scrollHandler, true);
      this._scrollHandler = null;
    }
    if (this._resizeHandler) {
      win.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._rafId != null) {
      (this._rafWin ?? win).cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._rafWin = null;
    }
    if (this._clickBindTimer != null) {
      win.clearTimeout(this._clickBindTimer);
      this._clickBindTimer = null;
    }
    this._boundDoc = null;
    this._boundWin = null;
  }

  destroy(): void {
    this.hide();
    if (this.container && this.container.parentNode) {
      this.container.remove();
      this.container = null;
    }
  }
}
