/**
 * InFlow 主插件入口
 * 剧本格式补全插件：场景/角色/对话格式插入、词库智能补全、时间戳、悬浮快捷面板
 */
import { Notice, Plugin, TFile, TFolder, debounce } from 'obsidian';
import type { Editor, TAbstractFile } from 'obsidian';
import { LibraryManager } from './libraryManager';
import { LibraryCreationModal, LibrarySwitcherModal } from './libraryModals';
import { LibraryEdgeStrips } from './quickPanel';
import { GlobalInputListener } from './inputListener';
import { SceneNumberGenerator } from './sceneNumberGenerator';
import { TextInserter } from './textInserter';
import { SimpleScriptSettingTab } from './settingsTab';
import { FormatsManager, MAX_QUICK_COMMANDS } from './formatsManager';
import { FormatSuggestModal } from './formatModals';
import { offsetToLineCh, renderFormatTemplate } from './formatEngine';
import {
  CATEGORY_DISPLAY_MAP,
  CATEGORY_TYPE_MAP,
  CONTEXT_CATEGORY_MAP,
  DEFAULT_SETTINGS,
  MAX_COMPLETION_QUERY_LEN,
  PINYIN_BRANCH,
  SYSTEM_CATEGORY_SET,
  TYPE_ORDER,
  WORD_BOUNDARY_RE,
} from './constants';
import type {
  BLFormatCompleterSettings,
  EditorLike,
  FormatItem,
  LibraryData,
  LibraryItem,
  SmartItem,
  Suggestion,
} from './types';

/** 状态栏项（obsidian 运行时为 HTMLElement 附带 onClick） */
type StatusBarItem = HTMLElement & {
  onClick?: ((ev: MouseEvent) => unknown) | null;
};

/** CJK 基本区汉字判定（覆盖 99% 以上常用字；扩展区生僻字不做拼音映射） */
const CJK_BASIC_RE = /[\u4e00-\u9fff]/;

/** 汉字 → 拼音首字母 的缓存。去重后通常只有数千字，首次之后几乎全部命中 */
const pinyinCache = new Map<string, string>();

let pinyinCollator: Intl.Collator | null | undefined;

/**
 * 惰性创建中文拼音排序器并做一次自检：只有当 ICU 确实按拼音排序时才启用。
 * 某些运行环境的中文默认排序是笔画序，此时返回 null —— 拼音匹配退化为不可用，
 * 但绝不会产生错误的结果。
 */
function getPinyinCollator(): Intl.Collator | null {
  if (pinyinCollator !== undefined) return pinyinCollator;
  try {
    const col = new Intl.Collator('zh-Hans-CN-u-co-pinyin');
    const sortedByPinyin =
      col.compare('啊', '八') < 0 && col.compare('八', '匝') < 0;
    pinyinCollator = sortedByPinyin ? col : null;
  } catch (e) {
    void e;
    pinyinCollator = null;
  }
  return pinyinCollator;
}

export class SimpleScriptCompleter extends Plugin {
  settings: BLFormatCompleterSettings = { ...DEFAULT_SETTINGS };
  libraryManager!: LibraryManager;
  /** 格式模板数据驱动层（formats.json 读写 / 触发查表 / 分组展开） */
  formatsManager!: FormatsManager;
  globalListener!: GlobalInputListener;
  sceneNumberGenerator = new SceneNumberGenerator();
  quickPanel: LibraryEdgeStrips | null = null;
  statusBarItem!: StatusBarItem;

  // 智能补全索引
  allSmartItems: SmartItem[] = [];
  prefixIndex: Map<string, SmartItem[]> = new Map();

  // 词库文件 modify 事件防抖器（编辑词库时避免逐键重建索引）
  private _debouncedFileChange: ((file: TAbstractFile) => void) | null = null;

  // 使用频次持久化防抖（选中补全后累计 usageStats，避免每次选中都写盘）
  private _debouncedSaveSettings: (() => void) | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SimpleScriptSettingTab(this.app, this));

    // 初始化词库管理器
    this.libraryManager = new LibraryManager(this);
    await this.libraryManager.initialize();

    // 初始化格式模板管理器（formats.json，数据驱动剧本格式）
    this.formatsManager = new FormatsManager(this);
    await this.formatsManager.initialize();

    // 启动时已打开的文档不会再触发 file-open，必须在这里主动构建一次索引，
    // 否则打开 Obsidian 后直接输入将拿不到任何候选。
    await this.buildSmartCompletionIndex();
    this.updateStatusBar();

    // 注册全局输入监听器（替代 EditorSuggest，覆盖所有插件的输入框）
    this.globalListener = new GlobalInputListener(this);
    this.globalListener.activate();

    // 注册命令
    this.addCommands();

    // 初始化场景编号生成器
    this.sceneNumberGenerator = new SceneNumberGenerator();

    // 初始化状态栏
    this.setupStatusBar();

    // 初始化快捷悬浮面板（Ribbon 图标已移除：它只是悬浮按钮的第二个入口，
    // 且在面板关闭时会跳转到设置页，行为不一致）
    if (this.settings.enableQuickPanel) {
      this.quickPanel = new LibraryEdgeStrips(this);
      this.quickPanel.create();
    }

    // 监听文件激活事件（重建索引 + 刷新状态栏；当前词库不再随文件自动切换）
    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        if (file) {
          await this.buildSmartCompletionIndex();
          this.updateStatusBar();
          if (this.quickPanel) this.quickPanel.refresh();
        }
      }),
    );

    // 监听词库文件夹变化（create / delete / rename 即时；modify 防抖）
    // 编辑词库文件时每次按键都会触发 modify，防抖避免逐键重建索引（reload + 重算 O(N)）。
    if (!this._debouncedFileChange) {
      this._debouncedFileChange = debounce(
        (file: TAbstractFile) => {
          void this.handleFileChange(file);
        },
        400,
        true,
      );
    }
    this.registerEvent(this.app.vault.on('create', (file) => this.handleFileChange(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.handleFileChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file) => this.handleFileChange(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => this._debouncedFileChange!(file)));

  }

  override onunload(): void {
    if (this.globalListener) this.globalListener.deactivate();
    if (this.quickPanel) {
      this.quickPanel.destroy();
      this.quickPanel = null;
    }
  }

  async handleFileChange(file: TAbstractFile): Promise<void> {
    // 关闭「词库更新自动刷新」后，词库文件变更完全不触发重载（手动刷新命令仍可用）
    if (!this.settings.enableAutoRefresh) return;

    if (!(file instanceof TFile)) return;

    // 检查是否是词库文件
    const libraryDir = this.libraryManager.getLibraryDirectory();
    if (libraryDir && file.path.startsWith(libraryDir) && file.extension === 'md') {
      const changedLibraryName = file.basename;
      const isActiveLibrary = this.libraryManager.activeLibrary === changedLibraryName;

      await this.libraryManager.reloadLibraries();

      // 如果当前活动词库是这个文件，自动重新构建索引
      if (isActiveLibrary) {
          await this.buildSmartCompletionIndex();
          this.updateStatusBar();
          if (this.quickPanel) this.quickPanel.refresh();

          if (this.settings.showAutoRefreshNotice) {
            new Notice(`"${changedLibraryName}" 词库已自动刷新`);
          }
        }

        if (this.quickPanel) this.quickPanel.refresh();
      }
    }

  async loadSettings(): Promise<void> {
    const defaultSettings = Object.assign({}, DEFAULT_SETTINGS);
    const savedData = await this.loadData();
    this.settings = Object.assign(defaultSettings, savedData);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // 保存设置后，同步创建或销毁快捷面板
    if (this.settings.enableQuickPanel && !this.quickPanel) {
      this.quickPanel = new LibraryEdgeStrips(this);
      this.quickPanel.create();
    } else if (!this.settings.enableQuickPanel && this.quickPanel) {
      this.quickPanel.destroy();
      this.quickPanel = null;
    }
  }

  /** 选中补全项时累计使用频次（MRU 排序信号），防抖写盘避免每次选中都落盘 */
  recordUsage(s: Suggestion): void {
    const display = s.display || s.name;
    if (!display) return;
    const library = (s as { library?: string }).library || this.libraryManager.activeLibrary || '';
    const key = `${library}::${display}`;
    const stats = this.settings.usageStats || (this.settings.usageStats = {});
    stats[key] = (stats[key] || 0) + 1;

    if (!this._debouncedSaveSettings) {
      this._debouncedSaveSettings = debounce(() => {
        void this.saveSettings();
      }, 800, false);
    }
    this._debouncedSaveSettings();
  }

  /** 取某条候选的累计使用次数（MRU 排序用） */
  private getUsage(item: SmartItem): number {
    const stats = this.settings.usageStats;
    if (!stats) return 0;
    return stats[`${item.library}::${item.display}`] || 0;
  }

  // ============ 状态栏 ============
  setupStatusBar(): void {
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();
  }

  updateStatusBar(): void {
    if (!this.statusBarItem) return;
    const activeLibrary = this.libraryManager.activeLibrary;
    const libraryDir = this.libraryManager.getLibraryDirectory();

    if (activeLibrary && libraryDir) {
      const info = this.libraryManager.getLibraryInfo(activeLibrary);
      const itemCount = info ? info.itemCount : 0;
      this.statusBarItem.setText(`📚 ${activeLibrary}(${itemCount})`);
      this.statusBarItem.onClick = () => this.showLibrarySwitcher();
    } else if (libraryDir) {
      this.statusBarItem.setText('📚 无词库');
      this.statusBarItem.onClick = () => this.showLibrarySwitcher();
    } else {
      this.statusBarItem.setText('📚 未设置');
      this.statusBarItem.onClick = () => {
        this.openSettings();
      };
    }
  }

  /** 打开插件设置页 */
  private openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.manifest.id);
    }
  }

  // ============ 智能补全索引 ============
  async buildSmartCompletionIndex(): Promise<void> {
    this.allSmartItems = [];

    // 获取当前活动词库数据
    const activeData = this.libraryManager.getActiveLibraryData();

    if (activeData && activeData.name) {
      // 遍历所有类别
      for (const [category, items] of Object.entries(activeData)) {
        if (category === 'name' || category === 'metadata') continue;

        // 对于用户自定义的类别，使用类别名作为类型
        const categoryType = CATEGORY_TYPE_MAP[category] || category;
        const categoryDisplay =
          CATEGORY_DISPLAY_MAP[category] || category.replace(/_/g, ' ');

        if (Array.isArray(items) && items.length > 0) {
          for (const rawItem of items) {
            const item = rawItem as LibraryItem;
            const displayText = item.display || String(rawItem);
            const insertText = item.insert || displayText;
            this.allSmartItems.push({
              display: displayText,
              insert: insertText,
              type: categoryType,
              typeDisplay: categoryDisplay,
              source: 'library',
              library: activeData.name,
              description: item.description || '',
            });
          }
        }
      }

      // 构建场景时间组合（兼容中英文类别标题）
      // 组合项是笛卡尔积噪声源：场景×时间 全量可能淹没真实词条，故受开关控制并按上限截断。
      if (this.settings.enableCombos) {
        const scenes = this.getCategoryItems(activeData, ['scenes', '场景']);
        const times = this.getCategoryItems(activeData, ['times', '时间段']);
        if (scenes.length > 0 && times.length > 0) {
          this.buildSceneTimeCombinations(
            activeData.name,
            scenes,
            this.capComboDimension(times, scenes.length),
          );
        }

        // 构建角色台词组合（兼容中英文类别标题）
        const characters = this.getCategoryItems(activeData, ['characters', '角色']);
        const dialogues = this.getCategoryItems(activeData, ['dialogues', '台词']);
        if (characters.length > 0 && dialogues.length > 0) {
          this.buildCharacterDialogueCombinations(
            activeData.name,
            characters,
            this.capComboDimension(dialogues, characters.length),
          );
        }
      }
    }

    // 预计算拼音首字母：索引期一次性完成，过滤时不再逐条逐字重算
    if (this.settings.enablePinyin) {
      for (const item of this.allSmartItems) {
        item.py = this.getPinyinFirstLetters(item.display);
      }
    }

    // 构建前缀索引
    this.buildPrefixIndex();

  }

  private getCategoryItems(
    data: LibraryData,
    keys: string[],
  ): LibraryItem[] {
    for (const key of keys) {
      const value = data[key];
      if (Array.isArray(value)) return value as LibraryItem[];
    }
    return [];
  }

  /**
   * 组合项笛卡尔积上限：把「另一维度」按 comboMaxItems 截断，
   * 使 场景数×时间数 ≤ comboMaxItems，避免大词库下组合项淹没真实词条。
   */
  private capComboDimension(dimension: LibraryItem[], otherLen: number): LibraryItem[] {
    const max = Math.max(1, this.settings.comboMaxItems || 60);
    if (otherLen <= 0) return dimension;
    const allowed = Math.floor(max / otherLen);
    if (allowed >= dimension.length) return dimension;
    return dimension.slice(0, Math.max(1, allowed));
  }

  private buildSceneTimeCombinations(
    libraryName: string,
    scenes: LibraryItem[],
    times: LibraryItem[],
  ): void {
    for (const scene of scenes) {
      for (const time of times) {
        const sceneDisplay = scene.display || String(scene);
        const sceneInsert = scene.insert || sceneDisplay;
        const timeDisplay = time.display || String(time);
        const timeInsert = time.insert || timeDisplay;

        this.allSmartItems.push({
          display: `${sceneDisplay} - ${timeDisplay}`,
          insert: `${sceneInsert} - ${timeInsert}`,
          type: 'scene_time_combo',
          typeDisplay: '场景+时间',
          source: 'combo',
          scene: sceneDisplay,
          time: timeDisplay,
          library: libraryName,
        });
      }
    }
  }

  private buildCharacterDialogueCombinations(
    libraryName: string,
    characters: LibraryItem[],
    dialogues: LibraryItem[],
  ): void {
    if (characters.length === 0 || dialogues.length === 0) return;

    characters.slice(0, 5).forEach((character) => {
      dialogues.slice(0, 3).forEach((dialogue) => {
        const charDisplay = character.display || String(character);
        const charInsert = character.insert || charDisplay;
        const dialogueDisplay = dialogue.display || String(dialogue);
        const dialogueInsert = dialogue.insert || dialogueDisplay;

        this.allSmartItems.push({
          display: `${charDisplay}: ${dialogueDisplay}`,
          insert: `${charInsert}: ${dialogueInsert}`,
          type: 'dialogue_combo',
          typeDisplay: '角色对话',
          source: 'combo',
          character: charDisplay,
          dialogue: dialogueDisplay,
          library: libraryName,
        });
      });
    });
  }

  /**
   * 构建前缀索引。查询词始终是「当前输入词」的【后缀】（resolveCompletion 从词尾回退试探），
   * 因此同时建「前缀索引」与「后缀索引」才能让补全查询真正命中桶、把查询复杂度从 O(N) 降到 O(桶)。
   * 索引键长度封顶到 MAX_COMPLETION_QUERY_LEN：更长的查询极少出现，且会退化为全表扫描保召回。
   */
  private buildPrefixIndex(): void {
    // key -> 去重后的候选集合（Set 以对象标识去重，O(1)，避免旧实现的 list.some 线性去重）
    const raw = new Map<string, Set<SmartItem>>();
    const addKey = (key: string, item: SmartItem): void => {
      let set = raw.get(key);
      if (!set) {
        set = new Set<SmartItem>();
        raw.set(key, set);
      }
      set.add(item);
    };

    const cap = MAX_COMPLETION_QUERY_LEN;

    for (const item of this.allSmartItems) {
      const text = item.display;
      const lower = text.toLowerCase();

      // 完整字符串
      addKey(lower, item);

      // 每个字符（中文逐字 / 拉丁单字母，补全查询最短单位）
      for (let i = 0; i < text.length; i++) {
        addKey(text[i].toLowerCase(), item);
      }

      // 前缀（封顶 cap）
      const preLen = Math.min(cap, text.length);
      for (let i = 1; i <= preLen; i++) {
        addKey(lower.substring(0, i), item);
      }
      // 后缀（补全查询的真实形状，命中率最高）
      const sufStart = Math.max(0, text.length - cap);
      for (let i = sufStart; i < text.length; i++) {
        addKey(lower.substring(i), item);
      }

      // 拼音首字母串：完整 + 前缀 + 后缀
      if (this.settings.enablePinyin && item.py) {
        const py = item.py;
        addKey(py, item);
        const pyPre = Math.min(cap, py.length);
        for (let i = 1; i <= pyPre; i++) addKey(py.substring(0, i), item);
        const pySuf = Math.max(0, py.length - cap);
        for (let i = pySuf; i < py.length; i++) addKey(py.substring(i), item);
      }
    }

    this.prefixIndex = new Map();
    for (const [key, set] of raw) {
      this.prefixIndex.set(key, [...set]);
    }

  }

  getPinyinFirstLetter(char: string): string {
    if (!char) return '';

    // 拉丁字母直接返回其小写形式
    if (/[a-zA-Z]/.test(char)) return char.toLowerCase();

    // 非汉字（数字、标点、其他文字）不参与拼音匹配
    if (!CJK_BASIC_RE.test(char)) return '';

    const cached = pinyinCache.get(char);
    if (cached !== undefined) return cached;

    let result = '';
    const col = getPinyinCollator();
    if (col) {
      // 代表字表按拼音有序，二分定位最后一个「不大于该字」的代表字
      let lo = 0;
      let hi = PINYIN_BRANCH.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (col.compare(char, PINYIN_BRANCH[mid][1]) >= 0) {
          result = PINYIN_BRANCH[mid][0];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }

    pinyinCache.set(char, result);
    return result;
  }

  getPinyinFirstLetters(text: string): string {
    let result = '';
    for (const char of text) {
      const pinyin = this.getPinyinFirstLetter(char);
      if (pinyin) result += pinyin;
    }
    return result;
  }

  // ============ 智能补全建议 ============
  /**
   * 按上下文类别过滤候选。
   * - enableContextAware 关闭 → 不过滤（返回全部，兼容旧行为）。
   * - 未知上下文 → 回退到 general 宽泛列表（不再是 'all' 全放行，避免正文行下感知形同虚设）。
   * - 自定义类别（不在 SYSTEM_CATEGORY_SET）始终透传，不受上下文收窄影响。
   */
  getSmartSuggestionsForContext(contextType: string, query = ''): Suggestion[] {
    const q = query ? query.trim() : '';
    const qLower = q.toLowerCase();
    const filterByContext = this.settings.enableContextAware;
    const ctxCats: string[] | null = filterByContext
      ? CONTEXT_CATEGORY_MAP[contextType] || CONTEXT_CATEGORY_MAP['general']
      : null;

    // 角色名上下文 + 自动对话：兼带对话类建议（在角色后快速续写台词）
    let effectiveCats = ctxCats;
    if (filterByContext && contextType === 'character_name' && this.settings.autoDialogue) {
      effectiveCats = ctxCats ? [...ctxCats, 'dialogue'] : ['dialogue'];
    }

    const contextOk = (item: SmartItem): boolean =>
      !effectiveCats ||
      effectiveCats.includes(item.type) ||
      !SYSTEM_CATEGORY_SET.has(item.type);

    // 查询词为空：直接返回上下文过滤后的全量候选
    if (!qLower) {
      return this.sortSuggestions(
        this.allSmartItems.filter(contextOk),
        q,
      ).slice(0, this.settings.smartMaxSuggestions || 10);
    }

    // 查询词非空：优先用前缀索引桶做候选源（O(桶大小)），无命中则退化为全表扫描（保持召回）
    // 中英文共用统一的 smartMinLength 阈值（入口层 resolveCompletion 已把关），不再对英文单独设门槛
    const bucket = this.prefixIndex.get(qLower);
    const source = bucket && bucket.length ? bucket : this.allSmartItems;

    const matched = source.filter(
      (item) => contextOk(item) && this.itemMatchesQuery(item, qLower),
    );

    // 模糊兜底：精确/前缀/拼音全部零命中（说明打错或接近某个词）时，
    // 对全词库做子序列匹配，避免打错一个字就无任何候选。
    if (matched.length === 0 && qLower.length >= 2) {
      const fuzzy = this.allSmartItems.filter(
        (item) =>
          contextOk(item) && this.fuzzyMatch(item.display, qLower),
      );
      return this.sortSuggestions(fuzzy, q).slice(
        0,
        this.settings.smartMaxSuggestions || 10,
      );
    }

    return this.sortSuggestions(matched, q).slice(0, this.settings.smartMaxSuggestions || 10);
  }

  /**
   * 子序列模糊匹配：query 的每个字符按顺序在目标文本中出现即命中。
   * 比编辑距离更宽容（可容忍插入/漏打），且实现为 O(target) 单趟扫描，代价可忽略。
   * 仅作兜底，不参与排序权重，避免干扰精确/前缀的正常排序。
   */
  private fuzzyMatch(target: string, queryLower: string): boolean {
    const hay = target.toLowerCase();
    if (!hay) return false;
    let ti = 0;
    for (let qi = 0; qi < queryLower.length; qi++) {
      const c = queryLower[qi];
      const found = hay.indexOf(c, ti);
      if (found === -1) return false;
      ti = found + 1;
    }
    return true;
  }

  /** 单条候选是否命中查询词（显示文本 / 拼音首字母 / 描述三路匹配） */
  private itemMatchesQuery(item: SmartItem, queryLower: string): boolean {
    if (item.display.toLowerCase().includes(queryLower)) return true;
    if (this.settings.enablePinyin) {
      const py = item.py ?? this.getPinyinFirstLetters(item.display);
      if (py && py.includes(queryLower)) return true;
    }
    if (item.description && item.description.toLowerCase().includes(queryLower)) return true;
    return false;
  }

  /**
   * 智能补全入口：从光标前文本解析出最佳查询片段与对应候选。
   *
   * 旧实现只取光标前最后 1 个字符作为查询词，带来两个问题：
   *  1. 中文多字输入时替换长度不足 —— 输入「主角」再选候选会得到「主主角」；
   *  2. 光标前是空白或标点时，查询词退化为空串，弹出一堆无关候选。
   *
   * 现在的策略：先截取「当前输入词」（遇空白/标点即停，保证不跨既有正文），
   * 再从长到短回退试探，取第一个能命中候选的长度。
   * 返回的 query 同时决定了插入时的替换长度，两者严格一致。
   */
  resolveCompletion(
    textBefore: string,
    contextType: string,
  ): { query: string; suggestions: Suggestion[] } | null {
    const minLen = Math.max(1, this.settings.smartMinLength || 1);
    const raw = textBefore.slice(this.findCompletionWordStart(textBefore));
    if (raw.length < minLen) return null;

    const maxLen = Math.min(raw.length, MAX_COMPLETION_QUERY_LEN);
    for (let len = maxLen; len >= minLen; len--) {
      const query = raw.slice(raw.length - len);
      const suggestions = this.getSmartSuggestionsForContext(contextType, query);
      if (suggestions.length > 0) return { query, suggestions };
    }
    return null;
  }

  /** 定位「当前输入词」的起始下标：遇空白或中英文标点即停 */
  private findCompletionWordStart(textBefore: string): number {
    for (let i = textBefore.length - 1; i >= 0; i--) {
      if (WORD_BOUNDARY_RE.test(textBefore[i])) return i + 1;
    }
    return 0;
  }

  private sortSuggestions(suggestions: SmartItem[], query: string): SmartItem[] {
    if (!query || !query.trim()) {
      return suggestions.slice().sort((a, b) => {
        // 最小触发/空查询：使用频次是首要信号（用户常选的排前面）
        const freqDiff = this.getUsage(b) - this.getUsage(a);
        if (freqDiff !== 0) return freqDiff;

        // 当前词库优先
        if (
          a.library === this.libraryManager.activeLibrary &&
          b.library !== this.libraryManager.activeLibrary
        )
          return -1;
        if (
          a.library !== this.libraryManager.activeLibrary &&
          b.library === this.libraryManager.activeLibrary
        )
          return 1;

        // 词库数据优先于默认数据
        if (a.source === 'library' && b.source === 'default') return -1;
        if (a.source === 'default' && b.source === 'library') return 1;

        // 类型排序
        const aOrder = TYPE_ORDER[a.type] || 99;
        const bOrder = TYPE_ORDER[b.type] || 99;
        if (aOrder !== bOrder) return aOrder - bOrder;

        return a.display.localeCompare(b.display);
      });
    }

    const queryLower = query.toLowerCase();

    return suggestions.slice().sort((a, b) => {
      // 1. 完全匹配优先
      if (a.display.toLowerCase() === queryLower && b.display.toLowerCase() !== queryLower)
        return -1;
      if (a.display.toLowerCase() !== queryLower && b.display.toLowerCase() === queryLower)
        return 1;

      // 2. 前缀匹配优先
      const aStartsWith = a.display.toLowerCase().startsWith(queryLower);
      const bStartsWith = b.display.toLowerCase().startsWith(queryLower);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;

      // 2.5 常用项优先（同前缀下把用户常选的词上浮）
      const freqDiff = this.getUsage(b) - this.getUsage(a);
      if (freqDiff !== 0) return freqDiff;

      // 3. 当前词库优先
      if (
        a.library === this.libraryManager.activeLibrary &&
        b.library !== this.libraryManager.activeLibrary
      )
        return -1;
      if (
        a.library !== this.libraryManager.activeLibrary &&
        b.library === this.libraryManager.activeLibrary
      )
        return 1;

      // 4. 词库数据优先于默认数据
      if (a.source === 'library' && b.source === 'default') return -1;
      if (a.source === 'default' && b.source === 'library') return 1;

      // 5. 长度短的优先
      return a.display.length - b.display.length;
    });
  }

  // ============ 命令注册 ============
  addCommands(): void {
    // 格式补全命令
    this.addCommand({
      id: 'insert-dialogue',
      name: '插入角色对话',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'd' }],
      callback: () => {
        const el = document.activeElement as HTMLElement | null;
        if (el && TextInserter.isEditable(el)) {
          TextInserter.insertText(el, '对话内容\n');
        }
      },
    });

    // 常驻菜单命令：打开全部分组的模板菜单（命令面板唯一必显入口）
    this.addCommand({
      id: 'open-template-menu',
      name: '打开模板菜单',
      callback: () => this.runTemplateMenu(),
    });

    // 直达命令位（预注册固定数量；Obsidian 命令仅 onload 期可注册）。
    // 只在设置里「添加直达命令」后才指向具体分组；未配置时命令面板中保留占位名。
    for (let slot = 1; slot <= MAX_QUICK_COMMANDS; slot++) {
      this.addCommand({
        id: `insert-template-quick-${slot}`,
        name: `插入模板 · 直达 ${slot}`,
        callback: () => this.runQuickCommand(slot),
      });
    }

    // 场景编号命令（仅 CodeMirror 编辑器可用）
    this.addCommand({
      id: 'renumber-current-episode',
      name: '重新编号当前集场景',
      callback: () => {
        const el = document.activeElement as HTMLElement | null;
        const cm = el ? TextInserter.getCodeMirrorView(el) : null;
        if (cm) {
          const proxy = TextInserter.createCMEditorProxy(cm);
          this.renumberScenesInCurrentEpisode(proxy);
        } else {
          new Notice('场景重编号仅支持 Obsidian 编辑器');
        }
      },
    });

    this.addCommand({
      id: 'renumber-all-scenes',
      name: '重新编号整个文档',
      callback: () => {
        const el = document.activeElement as HTMLElement | null;
        const cm = el ? TextInserter.getCodeMirrorView(el) : null;
        if (cm) {
          const proxy = TextInserter.createCMEditorProxy(cm);
          this.renumberAllScenes(proxy);
        } else {
          new Notice('场景重编号仅支持 Obsidian 编辑器');
        }
      },
    });

    // 词库管理命令
    this.addCommand({
      id: 'switch-library',
      name: '切换词库',
      callback: () => {
        this.showLibrarySwitcher();
      },
    });

    // 「重新加载词库」命令：重载 → 重建索引 → 刷新状态（当前词库不再自动重识别）
    this.addCommand({
      id: 'reload-libraries',
      name: '重新加载词库',
      callback: async () => {
        await this.libraryManager.reloadLibraries();

        const libraries = this.libraryManager.getAvailableLibraries();
        if (libraries.length === 0) {
          new Notice('没有找到词库，请先在设置中指定词库文件夹');
          return;
        }

        await this.buildSmartCompletionIndex();
        this.updateStatusBar();
        if (this.quickPanel) this.quickPanel.refresh();

        const active = this.libraryManager.activeLibrary;
        new Notice(
          active
            ? `词库已重新加载（${libraries.length} 个），当前：${active}`
            : `词库已重新加载（${libraries.length} 个），当前未选中`,
        );
      },
    });

    this.addCommand({
      id: 'open-library-folder',
      name: '打开词库文件夹',
      callback: async () => {
        const libraryDir = this.libraryManager.getLibraryDirectory();
        if (libraryDir) {
          const folder = this.app.vault.getAbstractFileByPath(libraryDir);
          if (folder) {
            const explorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
            if (explorerLeaves.length > 0) {
              const explorer = explorerLeaves[0].view as unknown as {
                revealInFolder?: (file: TAbstractFile) => void;
              };
              if (explorer.revealInFolder) explorer.revealInFolder(folder);
              await this.app.workspace.revealLeaf(explorerLeaves[0]);
            } else {
              new Notice(`词库文件夹: ${libraryDir}`);
            }
          } else {
            new Notice(`词库文件夹不存在: ${libraryDir}`);
          }
        } else {
          new Notice('请先设置词库文件夹');
        }
      },
    });

    this.addCommand({
      id: 'create-library-file',
      name: '创建新词库文件',
      callback: async () => {
        const libraryDir = this.libraryManager.getLibraryDirectory();
        if (libraryDir) {
          const modal = new LibraryCreationModal(this.app, async (libraryName) => {
            if (libraryName && libraryName.trim()) {
              let fileName = `${libraryName.trim()}.md`;
              let filePath = `${libraryDir}/${fileName}`;
              let counter = 1;

              while (this.app.vault.getAbstractFileByPath(filePath)) {
                fileName = `${libraryName.trim()}_${counter}.md`;
                filePath = `${libraryDir}/${fileName}`;
                counter++;
              }

              const template = `# ${libraryName.trim()}

## 角色
主角
配角

## 场景
主要场景1
主要场景2

## 时间段
白天
夜晚

## 动作
常用动作1
常用动作2

## 台词
常用台词1
常用台词2`;

              try {
                await this.app.vault.create(filePath, template);
                new Notice(`已创建词库文件: ${fileName}`);

              await this.libraryManager.reloadLibraries();
              await this.libraryManager.setActiveLibrary(libraryName.trim());
              await this.buildSmartCompletionIndex();
              this.updateStatusBar();
              if (this.quickPanel) this.quickPanel.refresh();
              } catch (e) {
                console.error('创建词库文件失败:', e);
                new Notice('创建词库文件失败');
              }
            }
          });
          modal.open();
        } else {
          new Notice('请先设置词库文件夹');
        }
      },
    });

    // 快捷面板命令
    this.addCommand({
      id: 'toggle-quick-panel',
      name: '打开词库选择器',
      callback: () => {
        this.showLibrarySwitcher();
      },
    });

    // 调试命令：查看当前索引状态（设置页的「测试」按钮已移除，避免两处重复）
    this.addCommand({
      id: 'debug-index',
      name: '调试索引状态',
      callback: () => {
        const activeData = this.libraryManager.getActiveLibraryData();
        const allLibraries = this.libraryManager.getAvailableLibraries();
        const itemCount = this.allSmartItems ? this.allSmartItems.length : 0;

        let message = `索引状态:\n`;
        message += `总词条数: ${itemCount}\n`;
        message += `当前词库: ${this.libraryManager.activeLibrary || '无'}\n`;
        message += `可用词库: ${allLibraries.length} 个（${allLibraries.join('、') || '无'}）\n`;
        message += `词库文件夹: ${this.libraryManager.getLibraryDirectory() || '未设置'}`;

        if (activeData) {
          let typed = 0;
          let untyped = 0;
          const catLines: string[] = [];

          for (const [category, items] of Object.entries(activeData)) {
            if (category === 'name' || category === 'metadata' || !Array.isArray(items)) continue;
            const type = CATEGORY_TYPE_MAP[category] || category;
            const known = SYSTEM_CATEGORY_SET.has(type);
            if (known) typed += items.length;
            else untyped += items.length;
            catLines.push(
              `${CATEGORY_DISPLAY_MAP[type] || category}: ${items.length}个${known ? '' : '（自定义）'}`,
            );
          }

          message += `\n\n词库类别统计:\n${catLines.join('\n')}`;
          if (untyped > 0) {
            message += `\n\n⚠ ${untyped} 条（${Math.round((untyped / (typed + untyped)) * 100)}%）未匹配到已知类别，不参与上下文过滤与类型排序。`;
          }
        }

        new Notice(message);
      },
    });

    // ---- 时间戳命令 ----
    this.addCommand({
      id: 'insert-timestamp',
      name: '插入时间戳 (YYYY-MM-DD-HH:mm)',
      hotkeys: [
        { modifiers: ['Mod', 'Shift'], key: ';' },
        { modifiers: ['Mod', 'Alt'], key: 't' },
      ],
      callback: () => this.insertTimestampAtCursor(),
    });

    this.addCommand({
      id: 'insert-timestamp-frontmatter',
      name: '写入时间戳到 frontmatter',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !(file instanceof TFile)) {
          new Notice('没有打开的笔记文件');
          return;
        }
        const ts = this.formatTimestamp(new Date());
        try {
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (!fm.created) fm.created = ts;
            fm.updated = ts;
          });
          new Notice(`已写入时间戳: ${ts}`);
        } catch (e) {
          console.error('写入 frontmatter 时间戳失败:', e);
          new Notice('写入时间戳失败');
        }
      },
    });

    this.addCommand({
      id: 'create-timestamp-note',
      name: '用时间戳创建新笔记',
      callback: async () => {
        const now = new Date();
        const ts = this.formatTimestamp(now);
        const name = this.formatTimestampForFilename(now);
        const activeFile = this.app.workspace.getActiveFile();
        const parent = this.app.fileManager.getNewFileParent(
          activeFile ? activeFile.path : '',
        );

        let fileName = `${name}.md`;
        let filePath = parent ? `${parent.path}/${fileName}` : fileName;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(filePath)) {
          fileName = `${name}_${counter}.md`;
          filePath = parent ? `${parent.path}/${fileName}` : fileName;
          counter++;
        }

        try {
          const file = await this.app.vault.create(
            filePath,
            `---\ncreated: ${ts}\nupdated: ${ts}\n---\n\n`,
          );
          await this.app.workspace.getLeaf(false).openFile(file);
          new Notice(`已创建笔记: ${fileName}`);
        } catch (e) {
          console.error('创建时间戳笔记失败:', e);
          new Notice('创建笔记失败');
        }
      },
    });
  }

  // ============ 时间戳 ============
  formatTimestamp(date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `-${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  formatTimestampForFilename(date = new Date()): string {
    return this.formatTimestamp(date).replace(/:/g, '');
  }

  insertTimestampAtCursor(): void {
    const TAG = '[InFlow]';
    const ts = this.formatTimestamp(new Date());
    const el = document.activeElement as HTMLElement | null;

    // 分支 1：焦点在可编辑元素上
    if (el && TextInserter.isEditable(el) && !TextInserter.isInExcludedContainer(el)) {
      TextInserter.insertText(el, ts);
      return;
    }

    // 分支 2：回退到 Obsidian 编辑器
    const editor =
      this.app.workspace.activeEditor &&
      (this.app.workspace.activeEditor as { editor?: Editor }).editor;
    if (editor) {
      editor.replaceSelection(ts);
      return;
    }

    console.warn(`${TAG} 插入失败：没有可用目标`);
    new Notice('没有找到可插入时间戳的光标位置');
  }

  // ============ 词库切换 ============
  async showLibrarySwitcher(): Promise<void> {
    const libraries = this.libraryManager.getAvailableLibraries();

    if (libraries.length === 0) {
      new Notice('没有找到词库，请先设置词库文件夹');
      return;
    }

    const modal = new LibrarySwitcherModal(
      this.app,
      libraries,
      this.libraryManager.activeLibrary,
      async (selectedLibrary) => {
        if (selectedLibrary) {
          await this.libraryManager.setActiveLibrary(selectedLibrary);
          await this.buildSmartCompletionIndex();
          this.updateStatusBar();
          if (this.quickPanel) this.quickPanel.refresh();
          new Notice(`已切换到词库: ${selectedLibrary}`);
        }
      },
    );

    modal.open();
  }

  // ============ 格式模板：统一插入管线 ============

  /** 常驻命令：打开全部模板分组菜单 */
  runTemplateMenu(): void {
    new FormatSuggestModal(this.app, this, this.formatsManager.file.groups.map((g) => g.id)).open();
  }

  /** 直达命令位：跳转到该位绑定的分组菜单 */
  runQuickCommand(slot: number): void {
    const q = this.formatsManager.quickCommand(slot);
    if (!q || q.groupIds.length === 0) {
      new Notice(`直达 ${slot} 未配置：设置 → 模板菜单 → 直达命令`);
      return;
    }
    new FormatSuggestModal(this.app, this, q.groupIds).open();
  }

  /**
   * 统一的格式插入管线：模板求值（变量 + $0）→ 删除触发串 → 插入 → 光标落点。
   * editor 非空走 Obsidian Editor（CM）路径；否则走 DOM 元素路径（非 CM 输入框）。
   */
  insertFormatItem(
    editor: Editor | null,
    el: HTMLElement | null,
    s: Suggestion,
    deleteLen: number,
  ): void {
    const template = s.template ?? s.insert ?? '';
    if (!template) return;

    if (editor) {
      const cursor = editor.getCursor();
      const needSceneNumber = /\{episode\}|\{scene\}/.test(template);
      const r = renderFormatTemplate(template, {
        sceneType: this.settings.defaultSceneType,
        getSceneNumber: needSceneNumber
          ? () => this.sceneNumberGenerator.getNextSceneNumber(editor, cursor)
          : undefined,
        selection: this.getEditorSelectionSafe(editor),
      });
      const ch = Math.max(0, cursor.ch - deleteLen);
      const base = { line: cursor.line, ch };
      // 用选区覆盖「触发符 + 其后输入」，避免 @ / ~ / 自定义触发串残留进文档
      editor.replaceRange(r.text, base, { line: cursor.line, ch: cursor.ch });
      this.placeCursorAfterInsert(editor, base, r);
      return;
    }

    if (el && TextInserter.isEditable(el)) {
      const r = renderFormatTemplate(template, {
        sceneType: this.settings.defaultSceneType,
      });
      TextInserter.replaceBeforeCursorSmart(
        el,
        r.text,
        deleteLen,
        r.cursorOffset,
        r.selectFrom,
        r.selectTo,
      );
    }
  }

  /** 渲染结果落点：$0 → 光标/选中；无 $0 → 文本尾 */
  private placeCursorAfterInsert(
    editor: Editor,
    base: { line: number; ch: number },
    r: { text: string; cursorOffset: number | null; selectFrom?: number | null; selectTo?: number | null },
  ): void {
    if (r.cursorOffset != null) {
      const rel = offsetToLineCh(r.text, r.cursorOffset);
      const pos = {
        line: base.line + rel.line,
        ch: rel.line === 0 ? base.ch + rel.ch : rel.ch,
      };
      if (r.selectFrom != null && r.selectTo != null) {
        const f = offsetToLineCh(r.text, r.selectFrom);
        const t = offsetToLineCh(r.text, r.selectTo);
        editor.setSelection(
          { line: base.line + f.line, ch: f.line === 0 ? base.ch + f.ch : f.ch },
          { line: base.line + t.line, ch: t.line === 0 ? base.ch + t.ch : t.ch },
        );
      } else {
        editor.setCursor(pos);
      }
      return;
    }
    const rel = offsetToLineCh(r.text, r.text.length);
    editor.setCursor({
      line: base.line + rel.line,
      ch: rel.line === 0 ? base.ch + rel.ch : rel.ch,
    });
  }

  private getEditorSelectionSafe(editor: Editor): string | undefined {
    try {
      return editor.getSelection() || undefined;
    } catch (e) {
      void e;
      return undefined;
    }
  }

  // ============ 场景编号 ============
  async renumberScenesInCurrentEpisode(editor: EditorLike): Promise<void> {
    const result = this.sceneNumberGenerator.renumberCurrentEpisode(editor);
    if (result.success) {
      new Notice(`已重新编号${result.renumberedScenes}个场景`);
    } else {
      new Notice('未找到需要重新编号的场景');
    }
  }

  async renumberAllScenes(editor: EditorLike): Promise<void> {
    const result = this.sceneNumberGenerator.renumberAllEpisodes(editor);
    if (result.success) {
      new Notice(
        `已重新编号${result.totalRenumbered}个场景，涉及${result.episodesRenumbered}集`,
      );
    } else {
      new Notice('未找到需要重新编号的场景');
    }
  }
}

export default SimpleScriptCompleter;
