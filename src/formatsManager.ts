/**
 * 模板库管理器 - formats.json 的读写 / 迁移（v4，无内置）/ 触发 / 展开
 *
 * v4 模型（用户概念：分组 / 模板条目 / 入口）：
 * - 无任何内置预置：分组与模板条目全部由用户在设置页自建，升级不注入任何内容。
 * - 全局一个触发字符 triggerChar；模板条目必有归属组；删组连带删组内条目。
 * - 直达命令 QuickCommand（1..4）按需添加，对应插件预注册的固定命令位。
 *
 * 存储：<vault>/.inflow/formats.json
 * 首次运行创建空配置；旧版文件读取时一次性迁移：
 * - v3：剥离全部 builtin 分组/条目与 builtinSnapshots（内置预置机制已废弃，不复活）；
 *       内置分组内残留的用户自建条目改收进「迁移条目」组，避免静默丢失。
 * - v1/v2：triggers/slots/itemIds/template 旧结构换算为 v4；孤儿条目收「迁移条目」组。
 */
import { Notice } from 'obsidian';
import type { SimpleScriptCompleter } from './main';
import type {
  FormatGroup,
  FormatItem,
  FormatsFile,
  QuickCommand,
  Suggestion,
} from './types';

/** formats.json 所在隐藏目录（相对 Vault 根） */
export const FORMATS_DIR = '.inflow';
/** formats.json 路径（相对 Vault 根） */
export const FORMATS_FILE_PATH = `${FORMATS_DIR}/formats.json`;
/** 直达命令最大条数（插件 onload 时预注册的固定命令位数量） */
export const MAX_QUICK_COMMANDS = 4;
/** 当前配置 schema 版本 */
export const FORMATS_VERSION = 4;
/** 默认全局触发字符 */
export const DEFAULT_TRIGGER_CHAR = '@';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface LegacyEntity {
  id: string;
  name?: string;
  template?: string;
  text?: string;
  type?: string;
  itemIds?: string[];
  chars?: string[];
  groupIds?: string[];
  index?: number;
  builtin?: boolean;
}

export class FormatsManager {
  private _data: FormatsFile = this.emptyFormats();

  constructor(private plugin: SimpleScriptCompleter) {}

  get file(): FormatsFile {
    return this._data;
  }

  /** 全新空配置（无任何预置；分组 / 条目全部由用户自建） */
  private emptyFormats(): FormatsFile {
    return {
      version: FORMATS_VERSION,
      triggerChar: DEFAULT_TRIGGER_CHAR,
      groups: [],
      items: [],
      quickCommands: [],
    };
  }

  async initialize(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    try {
      if (!(await adapter.exists(FORMATS_DIR))) {
        await adapter.mkdir(FORMATS_DIR).catch(() => {});
      }
      if (await adapter.exists(FORMATS_FILE_PATH)) {
        try {
          const raw = await adapter.read(FORMATS_FILE_PATH);
          const { file, changed } = this.parse(raw);
          this._data = file;
          if (changed) {
            await this.save();
          }
          return;
        } catch (e) {
          console.error('[InFlow] formats.json 解析失败，重建空配置:', e);
        }
      }
      // 首次运行 / 文件损坏：空配置
      this._data = this.emptyFormats();
      await this.save();
    } catch (e) {
      console.error('[InFlow] 初始化 formats.json 失败，使用内存空配置:', e);
      this._data = this.emptyFormats();
    }
  }

  /**
   * 解析 + 迁移 → v4。
   * 返回 changed = 是否需要落盘（发生过迁移 / 清理孤儿 / 剥除内置残留）。
   */
  private parse(raw: string): { file: FormatsFile; changed: boolean } {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') throw new Error('内容为空');

    const isCurrentLike =
      typeof obj.triggerChar === 'string' &&
      Array.isArray(obj.groups) &&
      Array.isArray(obj.items);
    let file: FormatsFile;
    let changed = false;
    if (isCurrentLike) {
      // v3 / v4 文件：统一规范化（版本升 4、字段归整、无 builtinSnapshots）
      const g = obj as unknown as FormatsFile;
      file = {
        version: FORMATS_VERSION,
        triggerChar: g.triggerChar,
        groups: Array.isArray(g.groups) ? g.groups : [],
        items: Array.isArray(g.items) ? g.items : [],
        quickCommands: Array.isArray(g.quickCommands) ? g.quickCommands : [],
      };
      changed =
        (obj.version as number) !== FORMATS_VERSION ||
        this.builtinCount(file) > 0 ||
        (obj as { builtinSnapshots?: unknown }).builtinSnapshots !== undefined;
      file = this.stripBuiltins(file);
      // 内置分组被剥除后，组内残留的自建条目改收「迁移条目」，不静默丢弃
      file = this.homeOrphans(file);
    } else {
      // v1 / v2 旧结构 → v4
      file = this.migrateLegacy(obj as unknown as LegacyFormatsLike);
      changed = true;
    }

    // 防御：修正孤儿条目（正常流程由 UI/迁移保证条目必有组）
    const validGroups = new Set(file.groups.map((grp) => grp.id));
    const before = file.items.length;
    file.items = file.items.filter((i) => validGroups.has(i.group));
    if (file.items.length !== before) changed = true;
    return { file, changed };
  }

  /** 统计带 builtin 标记的实体数（旧版残留判断用） */
  private builtinCount(f: FormatsFile): number {
    let n = 0;
    f.groups.forEach((g) => {
      if ((g as { builtin?: boolean }).builtin) n++;
    });
    f.items.forEach((i) => {
      if ((i as { builtin?: boolean }).builtin) n++;
    });
    return n;
  }

  /** 剥除旧版残留：builtin 分组 / builtin 条目（内置预置已废弃，删除后不复活） */
  private stripBuiltins(f: FormatsFile): FormatsFile {
    const out = clone(f);
    out.groups = out.groups.filter((g) => !(g as { builtin?: boolean }).builtin);
    out.items = out.items.filter((i) => !(i as { builtin?: boolean }).builtin);
    // 归整字段：去掉 builtin 残留键
    out.groups = out.groups.map((g) => {
      const { builtin: _b, ...rest } = g as FormatGroup & { builtin?: boolean };
      void _b;
      return rest as FormatGroup;
    });
    out.items = out.items.map((i) => {
      const { builtin: _b, ...rest } = i as FormatItem & { builtin?: boolean };
      void _b;
      return rest as FormatItem;
    });
    return out;
  }

  /**
   * 孤儿归位：条目所属分组不存在时（如内置组被剥除后组内残留的用户自建条目），
   * 收进「迁移条目」组。没有孤儿则原样返回。
   */
  private homeOrphans(f: FormatsFile): FormatsFile {
    const valid = new Set(f.groups.map((g) => g.id));
    const orphans = f.items.filter((i) => !valid.has(i.group));
    if (orphans.length === 0) return f;
    const out = clone(f);
    let migrated = out.groups.find((g) => g.id === 'grp-migrated');
    if (!migrated) {
      migrated = { id: 'grp-migrated', name: '迁移条目' };
      out.groups.push(migrated);
    }
    orphans.forEach((o) => {
      const item = out.items.find((x) => x.id === o.id);
      if (item) item.group = migrated!.id;
    });
    return out;
  }

  /** v1/v2（triggers / slots / itemIds / template / type）→ v4 */
  private migrateLegacy(old: LegacyFormatsLike): FormatsFile {
    const out = this.emptyFormats();
    // 1) 保留旧分组（去掉 itemIds；builtin 旧预置不保留）
    const keepGroups: Array<{ id: string; name: string; builtin?: boolean }> = [];
    const keepItems: Array<{ id: string; name: string; text: string; group: string; builtin?: boolean }> = [];
    if (Array.isArray(old.groups)) {
      old.groups.forEach((g) => {
        keepGroups.push({ id: g.id, name: g.name || g.id, builtin: !!g.builtin });
      });
    }
    const memberOf = new Map<string, string>(); // itemId → groupId
    if (Array.isArray(old.groups)) {
      old.groups.forEach((g) => (g.itemIds || []).forEach((iid) => memberOf.set(iid, g.id)));
    }
    if (Array.isArray(old.items)) {
      old.items.forEach((i) => {
        keepItems.push({
          id: i.id,
          name: i.name || i.id,
          text: i.text ?? i.template ?? '',
          group: memberOf.get(i.id) || '',
          builtin: !!i.builtin,
        });
      });
    }
    out.groups = keepGroups.filter((g) => !g.builtin).map((g) => ({ id: g.id, name: g.name }));
    const groupIds = new Set(out.groups.map((g) => g.id));
    const userItems = keepItems.filter((i) => !i.builtin);
    const keepItemsBound = userItems.filter((i) => i.group && groupIds.has(i.group));
    // 孤儿条目（旧文件无 itemIds 归属或引用悬空）收进「迁移条目」组，避免静默丢失
    const orphans = userItems.filter((i) => !i.group || !groupIds.has(i.group));
    if (orphans.length > 0 && !groupIds.has('grp-migrated')) {
      out.groups.push({ id: 'grp-migrated', name: '迁移条目' });
      groupIds.add('grp-migrated');
      orphans.forEach((o) => keepItemsBound.push({ ...o, group: 'grp-migrated' }));
    }
    out.items = keepItemsBound.map((i) => ({ id: i.id, name: i.name, text: i.text, group: i.group }));

    // 2) 触发字符：取旧 trig-at（@）或绑定组最多的那个；无法归一为多入口
    let chosen = old.triggers?.find((t) => t.id === 'trig-at');
    if (!chosen && old.triggers && old.triggers.length) {
      chosen = [...old.triggers].sort(
        (a, b) => (b.groupIds || []).length - (a.groupIds || []).length,
      )[0];
    }
    out.triggerChar =
      chosen && chosen.chars && chosen.chars.length && !/\s/.test(chosen.chars[0])
        ? chosen.chars[0]
        : DEFAULT_TRIGGER_CHAR;
    // 3) 直达命令为空；v4 无快照字段
    out.quickCommands = [];
    return out;
  }

  // ============ 查询 / 触发 / 展开 ============

  groupById(id: string): FormatGroup | undefined {
    return this._data.groups.find((g) => g.id === id);
  }

  /** 当前全局触发字符（未设专属触发符的分组共用） */
  get triggerChar(): string {
    return this._data.triggerChar || DEFAULT_TRIGGER_CHAR;
  }

  /**
   * 光标前文本 → 命中的触发符与它覆盖的分组。
   * - 分组有专属触发符 g.trigger 时只被该触发符弹出；
   * - 未设触发符的分组跟随全局 triggerChar；
   * - 多组可共用同一触发符（命中后合并弹出，靠分组头区分）。
   * 返回 null = 没有命中任何入口（此时不弹菜单）。
   */
  findTriggerMatch(textBefore: string): { char: string; groupIds: string[] } | null {
    if (!textBefore) return null;
    const def = this.triggerChar;
    const candidates = new Set<string>([def]);
    this._data.groups.forEach((g) => {
      if (g.trigger) candidates.add(g.trigger);
    });
    let best: string | null = null;
    for (const c of candidates) {
      if (!c) continue;
      if (textBefore.endsWith(c) && (!best || c.length > best.length)) best = c;
    }
    if (!best) return null;
    const groupIds = this._data.groups
      .filter((g) => (g.trigger ? g.trigger === best : best === def))
      .map((g) => g.id);
    return groupIds.length > 0 ? { char: best, groupIds } : null;
  }

  /**
   * 触发符集合校验（全局默认 + 各分组专属）：非空、不含空白；
   * 不同值之间禁止互为前缀（输入 `@` 时会吞掉 `@@` 造成歧义）；相同值允许多组共用。
   */
  validateTriggerSet(values: string[]): { ok: boolean; message: string } {
    for (const raw of values) {
      if (raw && /\s/.test(raw)) {
        return { ok: false, message: `触发符「${raw.trim() || '(空格)'}」不能包含空白字符` };
      }
    }
    const list = values.filter((c) => !!c && c.length > 0);
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        if (list[i] === list[j]) continue; // 同值允许（多组共用）
        if (list[i].startsWith(list[j]) || list[j].startsWith(list[i])) {
          return {
            ok: false,
            message: `触发符「${list[i]}」与「${list[j]}」互为前缀，输入时会互相吞并`,
          };
        }
      }
    }
    return { ok: true, message: '' };
  }

  /** 当前配置全部触发符（默认 + 各组专属） */
  currentTriggerValues(): string[] {
    const vals = [this.triggerChar];
    this._data.groups.forEach((g) => {
      if (g.trigger) vals.push(g.trigger);
    });
    return vals;
  }

  /** 全部模板条目按分组顺序展开为弹窗建议（含分组头 group 字段） */
  expandAll(): Suggestion[] {
    return this.expandGroups(this._data.groups.map((g) => g.id));
  }

  /** 指定分组展开（组顺序按传入；条目按组内数组顺序） */
  expandGroups(groupIds: string[]): Suggestion[] {
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const pushGroup = (gid: string) => {
      const g = this.groupById(gid);
      if (!g) return;
      for (const item of this._data.items) {
        if (item.group !== gid || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({
          name: item.name,
          display: item.name,
          template: item.text,
          insert: item.text,
          id: item.id,
          group: g.name,
        });
      }
    };
    groupIds.forEach(pushGroup);
    return out;
  }

  /** 直达命令配置 */
  quickCommand(slot: number): QuickCommand | undefined {
    return this._data.quickCommands.find((q) => q.slot === slot);
  }

  /** 原子修改：mutator 内直接改传入副本，落盘后刷新内存 */
  async mutate<T = unknown>(mutator: (draft: FormatsFile) => T): Promise<T> {
    const draft = clone(this._data);
    const result = mutator(draft);
    await this.write(draft);
    this._data = draft;
    return result;
  }

  async save(): Promise<void> {
    await this.write(this._data);
  }

  private async write(f: FormatsFile): Promise<void> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(FORMATS_DIR))) {
        await adapter.mkdir(FORMATS_DIR).catch(() => {});
      }
      await adapter.write(FORMATS_FILE_PATH, JSON.stringify(f, null, 2));
    } catch (e) {
      console.error('[InFlow] formats.json 写入失败:', e);
      new Notice('模板配置保存失败，请检查 .inflow 目录权限');
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

  /** 生成不与现有 id 冲突的自定义 id */
  newCustomId(prefix: string): string {
    const taken = new Set<string>();
    this._data.items.forEach((i) => taken.add(i.id));
    this._data.groups.forEach((g) => taken.add(g.id));
    let id = '';
    do {
      id = `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
    } while (taken.has(id));
    return id;
  }
}

/** 旧版文件形状（仅迁移用；不引用 types 已删接口） */
interface LegacyFormatsLike {
  version?: number;
  triggers?: Array<{ id: string; chars?: string[]; groupIds?: string[] }>;
  groups?: Array<LegacyEntity & { itemIds?: string[] }>;
  items?: Array<LegacyEntity>;
  triggerChar?: string;
}
