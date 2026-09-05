/**
 * 悬浮建议弹窗 - 替代 Obsidian EditorSuggest 的自定义弹窗
 */
import { TextInserter } from './textInserter';
import type { Suggestion } from './types';

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

  create(): void {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'blfc-suggest-popup';
    // 显示/隐藏由内联控制，视觉样式见 styles.css
    this.container.style.display = 'none';
    document.body.appendChild(this.container);
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
    if (!this.container) this.create();
    // 弹窗正在显示时先解绑旧监听/旧定时器，避免重复累积
    if (this.isVisible()) this.unbindEvents();
    this.renderItems();
    // 先显示再定位：positionNearCursor 依赖 offsetWidth/offsetHeight 取真实渲染尺寸
    this.container!.style.display = 'block';
    this.positionNearCursor();
    // 定位时若发现光标已滚出视口会被收起（display:none），此时无需再挂事件
    if (!this.isVisible()) return;
    this.bindEvents();
    // 布局测量稳定后再校准一次（首次 coordsAtPos 可能基于上一帧布局）
    this._scheduleRefresh();
  }

  hide(): void {
    if (this.container) this.container.style.display = 'none';
    this.unbindEvents();
    if (this.onClose) {
      const cb = this.onClose;
      this.onClose = null;
      cb();
    }
  }

  isVisible(): boolean {
    return !!this.container && this.container.style.display === 'block';
  }

  /** 当前弹窗的触发字符（'' 表示智能补全） */
  getTriggerChar(): string {
    return this.triggerChar;
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
      const head = document.createElement('div');
      head.className = 'blfc-suggest-head';
      head.textContent = row.text;
      this.container!.appendChild(head);
      return;
    }
    const { suggestion, index } = row;
    const el = document.createElement('div');
    el.className = 'blfc-suggest-item';
    el.setAttribute('data-index', String(index));
    if (index === this.selectedIndex) {
      el.addClass('blfc-is-selected');
      el.addClass('blfc-preview-on');
    }

    // 名称行：类别色点 + 显示文本（单行，不再常驻预览）
    const rowEl = document.createElement('div');
    rowEl.className = 'blfc-suggest-row';

    const dotEl = document.createElement('span');
    dotEl.className = `blfc-suggest-dot blfc-dot-${this.dotFamily(suggestion.type)}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'blfc-suggest-name';
    nameEl.textContent = suggestion.display || suggestion.name || '';

    rowEl.appendChild(dotEl);
    rowEl.appendChild(nameEl);
    el.appendChild(rowEl);

    // 预览：默认隐藏，仅在选中/悬停时展开（渐进式披露，避免弹窗被重复色块淹没）
    const preview = suggestion.insert || suggestion.template || '';
    if (preview) {
      const previewEl = document.createElement('div');
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
          : `I\u0000${r.suggestion.display}\u0000${r.suggestion.insert}\u0000${r.suggestion.type}\u0000${r.suggestion.group}`,
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

    this.container.innerHTML = '';
    if (this.items.length === 0) {
      const empty = document.createElement('div');
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
        : `key\u0000${s.group ?? ''}\u0000${s.name ?? ''}\u0000${s.display ?? ''}\u0000${s.insert ?? ''}`;
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

  /** 实时测量光标位置（每次都以当前光标为准）；失败时回退到打开时传入的快照 */
  private _measureCursorPos(): CursorPos | null {
    if (this.targetEl) {
      // CM 编辑器：直接用 coordsAtPos 取光标视口坐标
      // 不走 getCursorScreenPosition 的元素 rect 兜底（containerEl.bottom 会落到面板底部）
      const cm = TextInserter.getCodeMirrorView(this.targetEl);
      if (cm) {
        try {
          const head = cm.state.selection.main.head;
          const coords = cm.coordsAtPos(head);
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
        // coordsAtPos 返回 null（光标行未渲染）：用快照，不退化到容器底部
        return this._cursorPos || null;
      }
      // 非 CM 可编辑元素（textarea / input / contentEditable）：用 mirror 技术精确测量。
      // 防线：只有真正可编辑的表单元素才允许走 getCursorScreenPosition——
      // 其对普通 div 的兜底会返回元素 rect.bottom（整个编辑器面板底部），
      // 这正是“弹窗跑到面板底部而非光标处”的坐标来源。
      const el = this.targetEl;
      const isPlainEditable =
        el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable;
      if (isPlainEditable) {
        try {
          const p = TextInserter.getCursorScreenPosition(el);
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
        } catch (e) {
          void e;
        }
      }
    }
    return this._cursorPos || null;
  }

  /** 按光标坐标排版，并做视口避让：贴光标、不溢出、滚动时跟随 */
  private _applyPosition(pos: CursorPos): void {
    const container = this.container!;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 8;
    const GAP = 4;

    // 光标已滚出视口：收起，避免弹窗悬在错误位置
    if (pos.y < -MARGIN || pos.y > vh + MARGIN) {
      this.hide();
      return;
    }

    // 以实际渲染宽/高为准（受 styles.css max-height 限制）
    const popupWidth = container.offsetWidth || 200;
    // 未渲染时的兜底估算：单行态每条约 28px（选中项展开预览会略高，由实测值覆盖）
    const popupHeight =
      container.offsetHeight || Math.min(this.items.length * 28 + 6, 200);

    // 水平：以光标所在列为左缘，放不下时整体左移；内容过宽时按视口压缩
    container.style.maxWidth = '';
    let left = pos.x;
    const maxLeft = vw - MARGIN - popupWidth;
    if (maxLeft < MARGIN) {
      container.style.maxWidth = vw - MARGIN * 2 + 'px';
      left = MARGIN;
    } else {
      if (left > maxLeft) left = maxLeft;
      if (left < MARGIN) left = MARGIN;
    }

    // 垂直：优先贴光标下方，下方不足一行高度时上移到光标上方
    let top = pos.y + GAP;
    const belowSpace = vh - top - MARGIN;
    if (popupHeight > belowSpace) {
      if (belowSpace >= 48) {
        // 下方空间不足但仍可容纳一行以上：压缩高度，保持弹窗在光标下方
        container.style.maxHeight = Math.floor(belowSpace) + 'px';
      } else {
        // 下方几乎无空间：上移紧贴光标上方（恢复完整高度）
        container.style.maxHeight = '';
        top = pos.y - popupHeight - GAP;
      }
    } else {
      container.style.maxHeight = '';
    }
    if (top < MARGIN) top = MARGIN;

    container.style.left = left + 'px';
    container.style.top = top + 'px';
  }

  /** 用 rAF 合并高频事件（滚动/缩放），弹窗显示时始终贴近光标 */
  private _scheduleRefresh(): void {
    if (!this.isVisible()) return;
    if (this._rafId != null) return;
    this._rafId = window.requestAnimationFrame(() => {
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

    document.addEventListener('keydown', this._keydownHandler, true);
    document.addEventListener('scroll', this._scrollHandler, true);
    window.addEventListener('resize', this._resizeHandler);
    // 延迟绑定点击关闭：避免刚由 mousedown 触发的打开动作被立刻判定为“点击外部”而关闭
    if (this._clickBindTimer != null) {
      window.clearTimeout(this._clickBindTimer);
      this._clickBindTimer = null;
    }
    this._clickBindTimer = window.setTimeout(() => {
      this._clickBindTimer = null;
      document.addEventListener('mousedown', this._clickHandler!, true);
    }, 50);
  }

  unbindEvents(): void {
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler, true);
      this._keydownHandler = null;
    }
    if (this._clickHandler) {
      document.removeEventListener('mousedown', this._clickHandler, true);
      this._clickHandler = null;
    }
    if (this._scrollHandler) {
      document.removeEventListener('scroll', this._scrollHandler, true);
      this._scrollHandler = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._rafId != null) {
      window.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._clickBindTimer != null) {
      window.clearTimeout(this._clickBindTimer);
      this._clickBindTimer = null;
    }
  }

  destroy(): void {
    this.hide();
    if (this.container && this.container.parentNode) {
      this.container.remove();
      this.container = null;
    }
  }
}
