/**
 * InFlow 类型定义
 */

/** 词库条目：支持 显示文本|插入文本|描述 三种字段组合 */
export interface LibraryItem {
  display: string;
  insert: string;
  description?: string;
}

/** 解析后的词库数据（name + metadata + 任意类别数组） */
export interface LibraryData {
  name: string;
  metadata: Record<string, string>;
  [category: string]: unknown;
}

/** 已加载词库的运行时信息 */
export interface LoadedLibrary {
  name: string;
  path: string;
  data: LibraryData;
  lastModified: number;
}

/** 词库详细信息（用于状态栏 / 设置页 / 测试按钮展示） */
export interface LibraryInfo {
  name: string;
  path: string;
  itemCount: number;
  categoryCounts: Record<string, number>;
  metadata: Record<string, string>;
}

/** 智能补全索引条目 */
export interface SmartItem {
  display: string;
  insert: string;
  type: string;
  typeDisplay: string;
  source: 'library' | 'default' | 'combo';
  library?: string;
  description?: string;
  scene?: string;
  time?: string;
  character?: string;
  dialogue?: string;
  /**
   * 索引期预计算的拼音首字母串（如「林风」→ "lf"）。
   * 只在启用拼音匹配时写入；过滤时直接复用，避免每次按键逐字重算。
   */
  py?: string;
}

/** 补全建议（格式模板 / 词库条目共用结构） */
export interface Suggestion {
  name?: string;
  display?: string;
  template?: string;
  insert?: string;
  type?: string;
  /** 所属分组显示名：非空时弹窗渲染分组头（仅格式补全条目携带） */
  group?: string;
  /** 稳定标识：格式条目的 item.id（智能补全不携带） */
  id?: string;
}

/** 场景重编号结果 */
export interface RenumberResult {
  success: boolean;
  renumberedScenes: number;
  totalRenumbered?: number;
  episodesRenumbered?: number;
}

/** 场景区间 */
export interface EpisodeRange {
  start: number;
  end: number;
}

/** 插件设置 */
export interface BLFormatCompleterSettings {
  enabled: boolean;
  autoDialogue: boolean;
  enableSmartCompletion: boolean;
  enableContextAware: boolean;
  enableMinimalTrigger: boolean;
  enablePinyin: boolean;
  smartMinLength: number;
  smartMaxSuggestions: number;
  defaultSceneType: 'int' | 'ext';
  enableQuickPanel: boolean;
  enableAutoRefresh: boolean;
  showAutoRefreshNotice: boolean;
  floatingButtonPosition: { x: number; y: number };
  /** 词库彩条颜色：键为词库名（file.basename），值为 HEX 颜色。
   *  未显式设置的词库由默认调色板按序分配（见 DEFAULT_LIBRARY_PALETTE）。 */
  libraryColors: Record<string, string>;
  /** 词库彩条图标：键为词库名，值为用户粘贴的原始字符串 ——
   *  `<svg…` 开头按 SVG 渲染；纯 ASCII 标识符按 lucide 图标名渲染；
   *  其余（如 emoji）按文本渲染。留空/缺省 = 纯色条。 */
  libraryIcons: Record<string, string>;
  libraryFolder: string;
  /** 最近使用频次统计：键为 `词库::显示文本`，值为累计选中次数（MRU 排序用） */
  usageStats: Record<string, number>;
  /** 是否生成「场景×时间」「角色×台词」组合建议（笛卡尔积噪声源，可关闭） */
  enableCombos: boolean;
  /** 组合建议的最大条数上限，超过则截断笛卡尔积避免淹没真实词条 */
  comboMaxItems: number;
}

/**
 * 场景编号器 / 场景插入所依赖的编辑器最小接口。
 * 兼容 Obsidian Editor（inputListener 路径）与 CM6 包装 proxy（命令路径）。
 */
export interface EditorLike {
  getCursor(): { line: number; ch: number };
  getLine(n: number): string;
  lineCount(): number;
  setLine?(n: number, text: string): void;
  replaceRange?(text: string, pos: { line: number; ch: number }): void;
  setSelection?(from: { line: number; ch: number }, to: { line: number; ch: number }): void;
}

/** CodeMirror 6 EditorView 最小结构（用于 TextInserter 静态方法） */
export interface CMViewLike {
  state: {
    selection: { main: { head: number } };
    doc: {
      lines: number;
      lineAt(pos: number): { number: number; from: number; to: number; text: string };
      line(n: number): { text: string; from: number; to: number };
    };
  };
  coordsAtPos(pos: number): { left: number; right: number; top: number; bottom: number } | null;
  dispatch(spec: unknown): void;
  focus(): void;
}

// ============ 通用文本模板数据模型（.inflow/formats.json） ============

/**
 * v4 模型（用户只理解 3 个概念：分组 / 模板条目 / 入口）。
 * - 模板条目 = 名称 + 文本（文本支持 {变量} 与 $0 光标标记）
 * - 分组 = 菜单里的一个折叠区；条目必属于某组（删组连带删条目）
 * - 入口 = 全局一个触发字符（triggerChar）+ 常驻菜单命令 + 按需直达命令
 * 无内置预置：分组与条目全部由用户自建，升级不注入、无快照合并。
 */
export interface FormatItem {
  id: string;
  name: string;
  /** 模板文本：{变量} 运行时求值，$0 光标落点，${0:默认词} 落点并选中 */
  text: string;
  /** 所属分组 id（条目必属于某组） */
  group: string;
}

/** 分组 */
export interface FormatGroup {
  id: string;
  name: string;
  /**
   * 分组专属触发符（可选）。为空 = 走全局触发字符 triggerChar；
   * 多组可共用同一触发符（输入后合并弹出）；触发符之间禁止互为前缀。
   */
  trigger?: string;
}

/**
 * 直达命令（按需添加，最多 4 条）：对应插件预注册的固定命令位。
 * 未配置的命令位命令面板中不体现具体用途；有配置即绑定分组菜单。
 */
export interface QuickCommand {
  /** 1..4 */
  slot: number;
  /** 命令面板显示名（onload 时按配置生成） */
  name: string;
  /** 直达弹出的分组（可多组） */
  groupIds: string[];
}

/** formats.json 顶层结构 */
export interface FormatsFile {
  version: number;
  /** 全局触发字符（可多字符如 ##；输入即弹出全部模板菜单） */
  triggerChar: string;
  groups: FormatGroup[];
  items: FormatItem[];
  quickCommands: QuickCommand[];
}

/** 模板渲染结果 */
export interface FormatRenderResult {
  /** 插入文本（已求值、无 $0 标记） */
  text: string;
  /** $0 相对 text 起点的偏移；无 $0 时为 null（调用方兜底放文本尾） */
  cursorOffset: number | null;
  /** ${0:默认词} 的选中区间（相对 text 起点）；无则 null */
  selectFrom?: number | null;
  selectTo?: number | null;
}
