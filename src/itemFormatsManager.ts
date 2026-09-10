/**
 * 词条格式管理器 - .inflow/itemFormats.json 的读写 / 模板编译 / 一行词条的解析
 *
 * 设计要点（与 formatsManager 同构）：
 * - 代码里**不存在**「1 段 / 2 段 / 3 段」这类写死的格式判定：一行词条怎么切分，
 *   完全由用户配置的模板决定。模板里 {显示}/{插入}/{描述}（或 display/insert/description）
 *   是字段占位符，其余字符自动成为分隔符 —— 段数、段序、分隔符全部由模板表达。
 * - 无内置预置：首次初始化只落三条「默认」格式（等价旧版自动判定行为），
 *   用户可见、可改、可删；删光后词库不再解析出任何词条（不复活）。
 * - 允许多条格式并存：解析时按配置顺序依次尝试，第一条匹配成功的胜出。
 *
 * 存储：<vault>/.inflow/itemFormats.json
 */
import { Notice } from 'obsidian';
import type { SimpleScriptCompleter } from './main';
import type {
  ItemFieldRole,
  ItemFormat,
  ItemFormatsFile,
  ParsedItemLine,
} from './types';

/** itemFormats.json 所在隐藏目录（相对 Vault 根，与 formats.json 同目录） */
export const ITEM_FORMATS_DIR = '.inflow';
/** itemFormats.json 路径（相对 Vault 根） */
export const ITEM_FORMATS_FILE_PATH = `${ITEM_FORMATS_DIR}/itemFormats.json`;
/** 当前配置 schema 版本 */
export const ITEM_FORMATS_VERSION = 1;

/** 占位符别名 → 字段角色（中英文都认，大小写不敏感） */
const ROLE_ALIASES: Record<string, ItemFieldRole> = {
  显示: 'display',
  display: 'display',
  插入: 'insert',
  insert: 'insert',
  描述: 'description',
  说明: 'description',
  description: 'description',
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 剥离行首列表标记（`- ` / `* `）并 trim —— 与旧版 parseLibraryItem 的前置处理一致 */
const stripListMarker = (line: string): string => line.replace(/^[-*]\s*/, '').trim();

/** 模板校验结果 */
export interface TemplateValidation {
  ok: boolean;
  message: string;
}

interface CompiledFormat {
  format: ItemFormat;
  regex: RegExp;
  roles: ItemFieldRole[];
}

export class ItemFormatsManager {
  private _data: ItemFormatsFile = ItemFormatsManager.empty();
  /** 编译缓存：配置变更时置空，下次解析惰性重建 */
  private _compiled: CompiledFormat[] | null = null;

  constructor(private plugin: SimpleScriptCompleter) {}

  get file(): ItemFormatsFile {
    return this._data;
  }

  get formats(): ItemFormat[] {
    return this._data.formats;
  }

  private static empty(): ItemFormatsFile {
    return { version: ITEM_FORMATS_VERSION, formats: [] };
  }

  /**
   * 首次初始化落地的默认格式（三条，按序尝试）。
   * 它们等价于旧版写死的自动判定：3 段 → 2 段 → 1 段兜底。
   * 注意顺序不可颠倒：单段 `{显示}` 能匹配任意行，必须垫底。
   */
  private static defaultFormats(): ItemFormat[] {
    return [
      { id: 'ifmt-default-3', name: '默认 · 词条|插入|描述', template: '{显示}|{插入}|{描述}' },
      { id: 'ifmt-default-2', name: '默认 · 词条|插入', template: '{显示}|{插入}' },
      { id: 'ifmt-default-1', name: '默认 · 仅词条', template: '{显示}' },
    ];
  }

  async initialize(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    try {
      if (!(await adapter.exists(ITEM_FORMATS_DIR))) {
        await adapter.mkdir(ITEM_FORMATS_DIR).catch(() => {});
      }
      if (await adapter.exists(ITEM_FORMATS_FILE_PATH)) {
        try {
          const raw = await adapter.read(ITEM_FORMATS_FILE_PATH);
          const { file, changed } = this.parse(raw);
          this._data = file;
          if (changed) await this.save();
          return;
        } catch (e) {
          console.error('[InFlow] itemFormats.json 解析失败，重建默认配置:', e);
        }
      }
      // 首次运行 / 文件损坏：落三条可编辑默认（此后完全由用户掌控）
      this._data = {
        version: ITEM_FORMATS_VERSION,
        formats: ItemFormatsManager.defaultFormats(),
      };
      await this.save();
    } catch (e) {
      console.error('[InFlow] 初始化 itemFormats.json 失败，使用内存默认配置:', e);
      this._data = {
        version: ITEM_FORMATS_VERSION,
        formats: ItemFormatsManager.defaultFormats(),
      };
    }
  }

  /** 解析 + 规范化；changed = 是否需要落盘（版本升级 / 丢弃脏条目 / 补 id） */
  private parse(raw: string): { file: ItemFormatsFile; changed: boolean } {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') throw new Error('内容为空');

    const list = Array.isArray(obj.formats) ? obj.formats : [];
    const formats: ItemFormat[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<ItemFormat>;
      const template = typeof e.template === 'string' ? e.template : '';
      if (!template.trim()) continue;
      let id = typeof e.id === 'string' && e.id ? e.id : '';
      if (!id || seen.has(id)) id = ItemFormatsManager.randomId();
      seen.add(id);
      formats.push({
        id,
        name: typeof e.name === 'string' && e.name.trim() ? e.name : '未命名格式',
        template,
      });
    }
    const changed =
      formats.length !== list.length || (obj.version as number) !== ITEM_FORMATS_VERSION;
    return { file: { version: ITEM_FORMATS_VERSION, formats }, changed };
  }

  // ============ 模板校验 / 编译 ============

  /**
   * 校验模板：占位符必须已知、每个字段至多一次、必须含 {显示}、
   * 相邻字段之间必须有字面量（否则无从切分）。
   */
  validateTemplate(template: string): TemplateValidation {
    const t = (template || '').trim();
    if (!t) return { ok: false, message: '模板不能为空' };

    const re = /\{([^{}]*)\}/g;
    const roles: ItemFieldRole[] = [];
    let cursor = 0;
    let lastWasField = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const rawName = m[1].trim();
      const role = ROLE_ALIASES[rawName.toLowerCase()] ?? ROLE_ALIASES[rawName];
      if (!role) {
        return { ok: false, message: `未知字段「{${rawName}}」，可用：{显示} {插入} {描述}` };
      }
      if (lastWasField && m.index === cursor) {
        return { ok: false, message: '相邻字段之间必须有分隔字符，否则无法切分' };
      }
      if (roles.includes(role)) {
        return { ok: false, message: `字段「{${rawName}}」重复出现，每个字段最多一次` };
      }
      roles.push(role);
      lastWasField = true;
      cursor = m.index + m[0].length;
    }

    if (roles.length === 0) return { ok: false, message: '模板至少要包含一个字段占位符' };
    if (!roles.includes('display')) return { ok: false, message: '模板必须包含 {显示} 字段' };
    return { ok: true, message: '' };
  }

  /** 模板 → 正则：字面量转义后原样匹配，字段变为捕获组（末位字段贪婪到行尾）。
   *  公开供设置页对「编辑中但尚未保存」的模板做实时预览。 */
  compileTemplate(template: string): { regex: RegExp; roles: ItemFieldRole[] } | null {
    const t = (template || '').trim();
    if (!this.validateTemplate(t).ok) return null;

    const re = /\{([^{}]*)\}/g;
    const roles: ItemFieldRole[] = [];
    let pattern = '^';
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      pattern += escapeRegExp(t.slice(cursor, m.index));
      const rawName = m[1].trim();
      const role = ROLE_ALIASES[rawName.toLowerCase()] ?? ROLE_ALIASES[rawName];
      const isLastToken = m.index + m[0].length >= t.length;
      pattern += isLastToken ? '(.*)' : '(.*?)';
      roles.push(role);
      cursor = m.index + m[0].length;
    }
    pattern += escapeRegExp(t.slice(cursor)) + '$';
    try {
      return { regex: new RegExp(pattern), roles };
    } catch (e) {
      console.error('[InFlow] 词条格式模板编译失败:', template, e);
      return null;
    }
  }

  /** 当前生效的编译结果（惰性构建；非法模板静默跳过，UI 侧已拦截） */
  private compiledFormats(): CompiledFormat[] {
    if (this._compiled) return this._compiled;
    const out: CompiledFormat[] = [];
    for (const f of this._data.formats) {
      const c = this.compileTemplate(f.template);
      if (!c) continue;
      out.push({ format: f, regex: c.regex, roles: c.roles });
    }
    this._compiled = out;
    return out;
  }

  private invalidate(): void {
    this._compiled = null;
  }

  // ============ 解析 ============

  /** 是否存在可用格式（没有则词库解析不出任何词条） */
  hasUsableFormat(): boolean {
    return this.compiledFormats().length > 0;
  }

  /**
   * 按配置顺序尝试解析一行词条，返回第一条匹配的格式结果。
   * 字段回退规则（固定）：插入缺省 → 取显示文本；描述缺省 → 空。
   * 显示字段解析为空的行视为不匹配，继续尝试下一条格式。
   */
  parseLine(rawLine: string): ParsedItemLine | null {
    const line = stripListMarker(rawLine);
    if (!line) return null;

    for (const c of this.compiledFormats()) {
      const m = c.regex.exec(line);
      if (!m) continue;

      const values: Partial<Record<ItemFieldRole, string>> = {};
      for (let i = 0; i < c.roles.length; i++) {
        const v = (m[i + 1] ?? '').trim();
        if (v) values[c.roles[i]] = v;
      }
      const display = values.display || '';
      if (!display) continue;

      const insert = values.insert || display;
      const description = values.description;
      return description
        ? { display, insert, description, formatId: c.format.id }
        : { display, insert, formatId: c.format.id };
    }
    return null;
  }

  /**
   * 用「编辑中的模板」解析一行（不读写已保存配置）—— 设置页实时预览用。
   * 模板非法或未命中返回 null。
   */
  parseLineWithTemplate(template: string, rawLine: string): ParsedItemLine | null {
    const c = this.compileTemplate(template);
    if (!c) return null;
    const line = stripListMarker(rawLine);
    if (!line) return null;
    const m = c.regex.exec(line);
    if (!m) return null;

    const values: Partial<Record<ItemFieldRole, string>> = {};
    for (let i = 0; i < c.roles.length; i++) {
      const v = (m[i + 1] ?? '').trim();
      if (v) values[c.roles[i]] = v;
    }
    const display = values.display || '';
    if (!display) return null;
    const insert = values.insert || display;
    const description = values.description;
    return description
      ? { display, insert, description, formatId: '__preview__' }
      : { display, insert, formatId: '__preview__' };
  }

  /** 逐个格式尝试并给出诊断明细（设置页预览用） */
  explainLine(
    rawLine: string,
  ): Array<{ format: ItemFormat; matched: boolean; result: ParsedItemLine | null }> {
    const line = stripListMarker(rawLine);
    return this.compiledFormats().map((c) => {
      if (!line) return { format: c.format, matched: false, result: null };
      const m = c.regex.exec(line);
      if (!m) return { format: c.format, matched: false, result: null };
      const values: Partial<Record<ItemFieldRole, string>> = {};
      for (let i = 0; i < c.roles.length; i++) {
        const v = (m[i + 1] ?? '').trim();
        if (v) values[c.roles[i]] = v;
      }
      const display = values.display || '';
      if (!display) return { format: c.format, matched: false, result: null };
      const insert = values.insert || display;
      const description = values.description;
      return {
        format: c.format,
        matched: true,
        result: description
          ? { display, insert, description, formatId: c.format.id }
          : { display, insert, formatId: c.format.id },
      };
    });
  }

  // ============ 增删改 / 持久化 ============

  formatById(id: string): ItemFormat | undefined {
    return this._data.formats.find((f) => f.id === id);
  }

  /** 原子修改：mutator 内直接改传入副本，落盘后刷新内存与编译缓存 */
  async mutate<T = unknown>(mutator: (draft: ItemFormatsFile) => T): Promise<T> {
    const draft = clone(this._data);
    const result = mutator(draft);
    await this.write(draft);
    this._data = draft;
    this.invalidate();
    return result;
  }

  async save(): Promise<void> {
    await this.write(this._data);
    this.invalidate();
  }

  private async write(f: ItemFormatsFile): Promise<void> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(ITEM_FORMATS_DIR))) {
        await adapter.mkdir(ITEM_FORMATS_DIR).catch(() => {});
      }
      await adapter.write(ITEM_FORMATS_FILE_PATH, JSON.stringify(f, null, 2));
    } catch (e) {
      console.error('[InFlow] itemFormats.json 写入失败:', e);
      new Notice('词条格式保存失败，请检查 .inflow 目录权限');
    }
  }

  exportJson(): string {
    return JSON.stringify(this._data, null, 2);
  }

  importJson(raw: string): { ok: boolean; message: string } {
    try {
      const { file } = this.parse(raw);
      this._data = file;
      void this.save();
      return { ok: true, message: '导入成功' };
    } catch (e) {
      return {
        ok: false,
        message: `导入失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private static randomId(): string {
    return `ifmt-${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
      .toString(36)
      .padStart(2, '0')}`;
  }

  /** 生成不与现有 id 冲突的自定义 id */
  newCustomId(): string {
    const taken = new Set(this._data.formats.map((f) => f.id));
    let id = '';
    do {
      id = ItemFormatsManager.randomId();
    } while (taken.has(id));
    return id;
  }
}
