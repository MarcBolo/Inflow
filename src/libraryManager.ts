/**
 * 词库管理器 - 负责词库文件的加载、解析、识别与切换
 */
import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { LibraryData, LibraryInfo, LibraryItem, LoadedLibrary } from './types';
import type { SimpleScriptCompleter } from './main';
import { CATEGORY_ALIASES } from './constants';

export class LibraryManager {
  readonly app: App;
  libraries: Map<string, LoadedLibrary> = new Map();
  activeLibrary: string | null = null;
  activeLibraryData: LibraryData | null = null;

  constructor(private plugin: SimpleScriptCompleter) {
    this.app = plugin.app;
  }

  async initialize(): Promise<void> {
    await this.loadLibraries();
  }

  getLibraryDirectory(): string {
    return this.plugin.settings.libraryFolder || '';
  }

  async loadLibraries(): Promise<void> {
    this.libraries.clear();

    const libraryDir = this.getLibraryDirectory();
    if (!libraryDir) return;

    try {
      const folder = this.app.vault.getAbstractFileByPath(libraryDir);
      if (!folder) return;
      if (!(folder instanceof TFile) && !(folder instanceof TFolder)) return;

      const files: TFile[] = [];
      this.collectMdFiles(folder, files);

      let successCount = 0;
      for (const file of files) {
        if (file instanceof TFile && file.extension === 'md') {
          if (await this.loadLibraryFile(file)) successCount++;
        }
      }
    } catch (error) {
      console.error('加载词库失败:', error);
    }
  }

  private collectMdFiles(folder: TFile | TFolder, result: TFile[]): void {
    if (folder instanceof TFile) {
      if (folder.extension === 'md') result.push(folder);
      return;
    }
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (child.extension === 'md') result.push(child);
      } else if (child instanceof TFolder) {
        this.collectMdFiles(child, result);
      }
    }
  }

  async loadLibraryFile(file: TFile): Promise<boolean> {
    try {
      const content = await this.app.vault.read(file);
      const libraryName = file.basename;
      const libraryData = this.parseLibraryContent(content, libraryName);

      this.libraries.set(libraryName, {
        name: libraryName,
        path: file.path,
        data: libraryData,
        lastModified: file.stat.mtime,
      });
      return true;
    } catch (error) {
      console.error(`加载词库文件失败: ${file.path}`, error);
      return false;
    }
  }

  parseLibraryContent(content: string, libraryName: string): LibraryData {
    const data: LibraryData = { name: libraryName, metadata: {} };

    let currentSection: string | null = null;
    // 最近一个二级（##）标题的类别：三级（###）标题只作分组小标题，
    // 继承父类别，否则父级章节会变成空数组（如「## 常用单词」下全是「### 基础单词」）。
    let parentSection: string | null = null;
    const lines = content.split('\n');

    // 解析文件开头 YAML 元数据
    if (lines[0] && lines[0].trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') break;
        const parts = lines[i].split(':').map((p) => p.trim());
        if (parts.length >= 2) {
          data.metadata[parts[0]] = parts.slice(1).join(':');
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const trimmedLine = lines[i].trim();

      if (trimmedLine.startsWith('#')) {
        const level = trimmedLine.match(/^#+/)?.[0].length ?? 1;
        if (level <= 2) {
          currentSection = this.detectCategory(trimmedLine);
          parentSection = currentSection;
        } else {
          // ### 及以下：继承最近的 ## 类别，章节标题本身不入条目
          currentSection = parentSection;
        }
        if (currentSection && !data[currentSection]) {
          data[currentSection] = [];
        }
      } else if (currentSection && trimmedLine && !trimmedLine.startsWith('#')) {
        const item = this.parseLibraryItem(trimmedLine);
        if (item) {
          if (!data[currentSection]) {
            data[currentSection] = [];
          }
          (data[currentSection] as LibraryItem[]).push(item);
        }
      }
    }

    return data;
  }

  /**
   * 章节标题 → 类别键（中英归一化为规范英文键，见 CATEGORY_ALIASES）。
   *
   * 带英文括号的标题（如「拍摄方式 (Camera Movement)」）会产生三种候选键，按序查表：
   *   1. 完整标题    → "拍摄方式_(camera_movement)"
   *   2. 去括号中文主干 → "拍摄方式"
   *   3. 括号内英文原名 → "camera_movement"
   * 只要任一命中别名表即归一；全不命中才原样作为自定义类别键返回。
   */
  detectCategory(line: string): string | null {
    const cleanLine = line.replace(/^#+\s*/, '').trim();
    if (!cleanLine) return null;

    const toKey = (s: string): string => s.toLowerCase().replace(/\s+/g, '_');

    const candidates: string[] = [toKey(cleanLine)];

    const withoutParens = cleanLine.replace(/[（(][^）)]*[）)]/g, '').trim();
    if (withoutParens && withoutParens !== cleanLine) candidates.push(toKey(withoutParens));

    const parens = cleanLine.match(/[（(]([^）)]*)[）)]/);
    if (parens && parens[1].trim()) candidates.push(toKey(parens[1].trim()));

    for (const key of candidates) {
      const hit = CATEGORY_ALIASES[key];
      if (hit) return hit;
    }
    return candidates[0];
  }

  /** 解析词库条目：支持 显示|插入|描述 / 显示|插入 / 显示 三种格式 */
  parseLibraryItem(line: string): LibraryItem | null {
    const cleanLine = line.replace(/^[-\*]\s*/, '').trim();
    if (!cleanLine) return null;

    const parts = cleanLine.split('|').map((part) => part.trim());

    if (parts.length >= 3) {
      return { display: parts[0], insert: parts[1], description: parts[2] };
    } else if (parts.length === 2) {
      return { display: parts[0], insert: parts[1] };
    } else {
      return { display: parts[0], insert: parts[0] };
    }
  }

  async reloadLibraries(): Promise<void> {
    await this.loadLibraries();

    // 当前活动词库已不存在时清空
    if (this.activeLibrary && !this.libraries.has(this.activeLibrary)) {
      this.activeLibrary = null;
      this.activeLibraryData = null;
    }
  }

  /** 词库名规范化：只保留中英文与数字。
   * 历史配置里可能出现 emoji 前缀（如 "🅰单词"），而词库名取自文件 basename（"单词"），
   * 精确比较会静默失败——规范化后即可容忍 emoji / 空格 / 大小写差异。
   */
  private normalizeLibraryKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  }

  /** 解析词库名：精确命中优先，其次规范化匹配；都不中返回 null */
  resolveLibraryName(libraryName: string): string | null {
    if (!libraryName) return null;
    if (this.libraries.has(libraryName)) return libraryName;

    const target = this.normalizeLibraryKey(libraryName);
    if (!target) return null;
    for (const name of this.libraries.keys()) {
      if (this.normalizeLibraryKey(name) === target) return name;
    }
    return null;
  }

  async setActiveLibrary(libraryName: string): Promise<boolean> {
    if (!libraryName) return false;

    const resolved = this.resolveLibraryName(libraryName);
    if (!resolved) return false;

    this.activeLibrary = resolved;
    this.activeLibraryData = this.libraries.get(resolved)!.data;
    return true;
  }

  getActiveLibraryData(): LibraryData | null {
    return this.activeLibraryData;
  }

  getAvailableLibraries(): string[] {
    return Array.from(this.libraries.keys());
  }

  getLibraryInfo(libraryName: string): LibraryInfo | null {
    const library = this.libraries.get(libraryName);
    if (!library) return null;

    const data = library.data;
    let itemCount = 0;
    const categoryCounts: Record<string, number> = {};

    for (const [category, items] of Object.entries(data)) {
      if (category !== 'name' && category !== 'metadata' && Array.isArray(items)) {
        const count = items.length;
        itemCount += count;
        categoryCounts[category] = count;
      }
    }

    return {
      name: library.name,
      path: library.path,
      itemCount,
      categoryCounts,
      metadata: data.metadata || {},
    };
  }
}
