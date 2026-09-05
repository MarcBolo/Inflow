/**
 * 词库彩条 - 贴在编辑器左边缘的细长色条，每个词库一条，点击直接切换
 */
import { Notice, setIcon } from 'obsidian';
import type { SimpleScriptCompleter } from './main';
import { DEFAULT_LIBRARY_PALETTE } from './constants';

/** lucide 图标名合法字符（仅 ASCII 字母数字与连字符） */
const ICON_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * 图标值最小清洗：仅用于「以 <svg 开头」的用户粘贴内容。
 * 剥除 <script> 与 on* 事件属性、javascript: 链接，其余原样保留
 * （SVG 自带的 fill/stroke 颜色会原样渲染）。
 */
function sanitizeSvg(raw: string): string {
  const holder = document.createElement('div');
  holder.innerHTML = raw;
  holder.querySelectorAll('script').forEach((el) => el.remove());
  holder.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      if (
        n.startsWith('on') ||
        ((n === 'href' || n === 'xlink:href') && v.startsWith('javascript:'))
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return holder.innerHTML;
}

/**
 * 替代旧版圆形悬浮按钮 + 环形选择器。
 * - 容器固定定位在编辑器区域左边缘（rootSplit 左侧），随布局变化重新对齐。
 * - 每个词库一条彩条，颜色取自 settings.libraryColors，缺失则按调色板分配并落盘。
 * - 点击彩条 = 直接切换到该词库；无词库时整个容器隐藏。
 */
export class LibraryEdgeStrips {
  private container: HTMLElement | null = null;
  private layoutHandler: () => void;
  /** CI-* 等第三方插件图标可能晚于本插件注册：未解析成功时递增重试轮数 */
  private retryAttempt = 0;
  private retryTimer: number | null = null;
  /** 观察编辑器根分栏尺寸变化（侧边栏展开/收起等），驱动位置重算 */
  private resizeObserver: ResizeObserver | null = null;
  /** rAF 合并标记：过渡动画期间 RO 高频回调，只保留一帧一次对齐 */
  private rafPending = false;
  /** 当前被 RO 观察的元素（避免 layout-change 时重复重建观察器） */
  private observedEl: HTMLElement | null = null;

  constructor(private plugin: SimpleScriptCompleter) {
    this.layoutHandler = () => {
      // layout-change 可能发生在根分栏重建后：重新确认观察目标，再对齐
      this.observeRoot();
      this.scheduleReposition();
    };
  }

  /** 创建彩条容器并首次渲染 */
  create(): void {
    if (this.container && this.container.parentNode) {
      this.container.remove();
    }

    this.container = document.createElement('div');
    this.container.className = 'blfc-edge-strips';
    document.body.appendChild(this.container);

    this.plugin.app.workspace.on('layout-change', this.layoutHandler);
    window.addEventListener('resize', this.layoutHandler);
    this.observeRoot();

    this.render();
  }

  /** 销毁容器与监听 */
  destroy(): void {
    if (this.retryTimer != null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
      this.observedEl = null;
    }
    this.plugin.app.workspace.off('layout-change', this.layoutHandler);
    window.removeEventListener('resize', this.layoutHandler);
    if (this.container && this.container.parentNode) {
      this.container.remove();
    }
    this.container = null;
    this.retryAttempt = 0;
  }

  /**
   * 重新渲染彩条（词库列表/当前词库/颜色变化后调用）。
   * 同时负责空态隐藏与位置对齐。
   */
  refresh(): void {
    this.render();
  }

  /** 渲染全部彩条 */
  private render(): void {
    if (!this.container) return;

    const libraries = this.plugin.libraryManager.getAvailableLibraries();
    this.container.empty();

    // 空态：无词库直接隐藏整个容器
    if (libraries.length === 0) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';

    const activeLibrary = this.plugin.libraryManager.activeLibrary;
    const colors = this.plugin.settings.libraryColors;
    /** 本轮未能解析的图标（多为 CI-* 第三方插件图标未注册），用于延时重试 */
    const pendingNames: string[] = [];

    libraries.forEach((libraryName, index) => {
      // 缺失颜色按调色板分配并持久化
      let color = colors[libraryName];
      if (!color) {
        color = DEFAULT_LIBRARY_PALETTE[index % DEFAULT_LIBRARY_PALETTE.length];
        this.plugin.settings.libraryColors[libraryName] = color;
        void this.plugin.saveSettings();
      }

      const strip = document.createElement('div');
      strip.className = 'blfc-edge-strip';
      strip.style.backgroundColor = color;
      if (libraryName === activeLibrary) {
        strip.classList.add('blfc-edge-strip-active');
      }

      // 图标：仅当设置了值才显示（空 = 纯色彩条）
      const rawIcon = (this.plugin.settings.libraryIcons?.[libraryName] ?? '').trim();
      if (rawIcon) {
        const iconEl = document.createElement('span');
        iconEl.className = 'blfc-edge-strip-icon';
        let iconOk = false;
        if (rawIcon.toLowerCase().startsWith('<svg')) {
          iconEl.innerHTML = sanitizeSvg(rawIcon);
          // SVG 自带 fill/stroke 优先；缺省 currentColor 时回退到词库色
          iconEl.style.color = color;
          iconOk = true;
        } else if (ICON_NAME_RE.test(rawIcon)) {
          try {
            setIcon(iconEl, rawIcon);
          } catch (e) {
            void e;
          }
          // setIcon 是一次性渲染：CI-* 等第三方图标若来源插件尚未加载，
          // 这里不会产出 svg。此时不丢弃，记录待重试（不阻塞本次渲染）。
          iconOk = !!iconEl.querySelector('svg');
          // 纯图标形态：单色（lucide）图标用词库色上色，保证在主题背景上可见
          if (iconOk) iconEl.style.color = color;
        } else {
          // emoji / 其他文本（保留自身颜色）
          iconEl.textContent = rawIcon;
          iconOk = true;
        }
        if (iconOk) {
          strip.appendChild(iconEl);
          // 有图标 = 纯图标形态：去掉彩条底色，只显示图标
          strip.classList.add('blfc-icon-only');
          strip.style.backgroundColor = '';
        } else {
          pendingNames.push(`${libraryName} → ${rawIcon}`);
        }
      }

      const info = this.plugin.libraryManager.getLibraryInfo(libraryName);
      const count = info ? info.itemCount : 0;
      strip.title = `${libraryName}（${count} 条）`;
      strip.setAttribute('role', 'button');
      strip.setAttribute('aria-label', `切换到词库 ${libraryName}`);
      strip.tabIndex = 0;

      const activate = async () => {
        if (libraryName === this.plugin.libraryManager.activeLibrary) return;
        const ok = await this.plugin.libraryManager.setActiveLibrary(libraryName);
        if (!ok) return;
        await this.plugin.buildSmartCompletionIndex();
        this.plugin.updateStatusBar();
        this.render();
        new Notice(`已切换到词库: ${libraryName}`);
      };

      strip.addEventListener('click', activate);
      strip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void activate();
        }
      });

      this.container!.appendChild(strip);
    });

    this.reposition();

    if (pendingNames.length > 0) {
      this.scheduleIconRetry(pendingNames);
    } else {
      this.retryAttempt = 0;
    }
  }

  /**
   * 图标延时重试：CI-* 等第三方插件图标注册时机不定（插件加载顺序/懒注册），
   * 在 0.4s / 1.2s / 3s / 8s 后各重试一次；仍失败则打日志（大概率来源插件未启用）。
   */
  private scheduleIconRetry(pendingNames: string[]): void {
    if (this.retryTimer != null) return;
    const delays = [400, 1200, 3000, 8000];
    const delay = delays[this.retryAttempt];
    if (delay === undefined) {
      console.warn(
        '[InFlow] 图标多次重试仍无法解析（请确认来源插件已启用且晚于本插件加载；或改用 lucide 内置图标名 / Emoji）：',
        pendingNames,
      );
      this.retryAttempt = 0;
      return;
    }
    this.retryAttempt++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.container) this.render();
    }, delay);
  }

  /**
   * 获取定位参考元素：编辑器根分栏（rootSplit）容器。
   * rootSplit 在部分 Obsidian 类型定义里未暴露 containerEl，这里做宽松断言。
   */
  private getRootElement(): HTMLElement | null {
    const root = (this.plugin.app.workspace as unknown as {
      rootSplit?: { containerEl?: HTMLElement };
    }).rootSplit;
    const rootEl = root?.containerEl;
    if (rootEl) return rootEl;
    return document.querySelector('.workspace-split.mod-root') as HTMLElement | null;
  }

  /**
   * 观察编辑器根分栏：侧边栏展开/收起（不一定触发 layout-change / resize）会改变其
   * 位置或尺寸，ResizeObserver 均能捕获，从而让彩条实时跟随对齐。
   */
  private observeRoot(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const target = this.getRootElement();
    if (!target || target === this.observedEl) return;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.observedEl = target;
    this.resizeObserver = new ResizeObserver(() => this.scheduleReposition());
    this.resizeObserver.observe(target);
  }

  /** 合并到下一帧执行对齐：过渡动画期间 RO 高频回调，避免重复 reflow */
  private scheduleReposition(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    window.requestAnimationFrame(() => {
      this.rafPending = false;
      this.reposition();
    });
  }

  /** 计算左边缘偏移：对齐到编辑器根分栏（mod-root）左侧，避开左侧边栏/ribbon */
  private reposition(): void {
    if (!this.container) return;
    const rootEl = this.getRootElement();
    const rect = rootEl?.getBoundingClientRect();
    const left = rect ? Math.max(0, rect.left) : 0;
    this.container.style.left = `${left}px`;
  }
}
