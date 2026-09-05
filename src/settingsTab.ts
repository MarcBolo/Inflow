/**
 * 插件设置面板
 */
import { Modal, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { LibraryEdgeStrips } from './quickPanel';
import { FormatItemEditModal, FormatsTransferModal } from './formatModals';
import type { SimpleScriptCompleter } from './main';
import type { FormatItem } from './types';
import { MAX_QUICK_COMMANDS } from './formatsManager';
import { DEFAULT_LIBRARY_PALETTE } from './constants';

/** type → 简短中文标签（条目表格展示用） */
/** 简单文本输入弹窗（新增 / 重命名分组、直达命令名等用） */
class SimpleTextModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private initial: string,
    private onConfirm: (text: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');
    contentEl.createEl('h3', { text: this.title });
    let value = this.initial;
    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: this.placeholder,
      value: this.initial,
      cls: 'blfc-fmt-name-input',
    });
    input.select();
    const submit = () => {
      const v = value.trim();
      if (!v) {
        new Notice('名称不能为空');
        return;
      }
      this.onConfirm(v);
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
    });
    input.addEventListener('input', () => {
      value = input.value;
    });
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('确定').setCta().onClick(submit))
      .addButton((btn) => btn.setButtonText('取消').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 新建直达命令：命令名 + 绑定分组（一次完成；可预设默认勾选组） */
class DirectCommandModal extends Modal {
  private name = '插入模板';
  private picked: Set<string>;

  constructor(
    app: App,
    private groups: Array<{ id: string; name: string }>,
    private onConfirm: (name: string, groupIds: string[]) => void,
    defaultSelected: string[] = [],
  ) {
    super(app);
    this.picked = new Set(defaultSelected);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');
    contentEl.createEl('h3', { text: '添加直达命令' });
    contentEl.createEl('p', {
      text: '该命令会出现在命令面板与快捷键设置中（名称需重载插件后生效），直达所选分组菜单。',
      cls: 'blfc-fmt-transfer-desc',
    });
    const nameInput = contentEl.createEl('input', {
      type: 'text',
      value: this.name,
      cls: 'blfc-fmt-name-input',
    });
    nameInput.addEventListener('input', () => {
      this.name = nameInput.value;
    });
    contentEl.createEl('div', { text: '打开以下分组：', cls: 'blfc-fmt-edit-preview-label' });
    const listEl = contentEl.createEl('div', { cls: 'blfc-fmt-group-pick' });
    this.groups.forEach((g) => {
      const label = listEl.createEl('label', { cls: 'blfc-fmt-group-pick-item' });
      const cb = label.createEl('input', { type: 'checkbox' });
      cb.checked = this.picked.has(g.id);
      label.createEl('span', { text: g.name });
      cb.addEventListener('change', () => {
        if (cb.checked) this.picked.add(g.id);
        else this.picked.delete(g.id);
      });
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('保存')
          .setCta()
          .onClick(() => {
            if (!this.name.trim()) {
              new Notice('命令名不能为空');
              return;
            }
            if (this.picked.size === 0) {
              new Notice('至少选择一个分组');
              return;
            }
            this.onConfirm(this.name.trim(), [...this.picked]);
            this.close();
          }),
      )
      .addButton((btn) => btn.setButtonText('取消').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 通用确认弹窗（删除分组等破坏性操作前二次确认） */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.message });
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('确认删除')
          .setWarning()
          .onClick(() => {
            this.onConfirm();
            this.close();
          }),
      )
      .addButton((btn) => btn.setButtonText('取消').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class SimpleScriptSettingTab extends PluginSettingTab {
  private libraryTableContainer!: HTMLElement;
  /** 模板库设置区块容器（内容全部动态重建） */
  private formatsArea: HTMLElement | null = null;

  constructor(app: App, private plugin: SimpleScriptCompleter) {
    super(app, plugin);
  }

  /** 二级页面导航状态：null=主设置页；groupId=正在查看的分组页 */
  private activeGroupId: string | null = null;
  /** 二级页面导航状态：true=正在查看「词库列表」页 */
  private showLibraryList = false;
  /** 二级页面导航状态：true=正在查看「词库参考」页（词库格式说明） */
  private showLibraryReference = false;

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 添加插件专属命名空间类
    containerEl.addClass('blfc-plugin');

    // 二级页面（分组设置）会话保持：切走再回来仍在原分组页
    if (this.activeGroupId) {
      this.renderGroupSubpage(this.activeGroupId);
      return;
    }
    // 二级页面（词库列表）会话保持
    if (this.showLibraryList) {
      this.renderLibraryListSubpage();
      return;
    }
    // 二级页面（词库参考：词库格式说明）会话保持
    if (this.showLibraryReference) {
      this.renderReferenceSubpage();
      return;
    }

    // ========== 第一部分：基本设置 ==========
    containerEl.createEl('h3', { text: '基本设置' });

    new Setting(containerEl)
      .setName('启用插件')
      .setDesc('启用或禁用格式补全功能')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('自动对话建议')
      .setDesc('在角色名后自动建议插入对话格式')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoDialogue).onChange(async (value) => {
          this.plugin.settings.autoDialogue = value;
          await this.plugin.saveSettings();
        }),
      );

    // ========== 第二部分：智能补全设置 ==========
    containerEl.createEl('h3', { text: '智能补全' });

    new Setting(containerEl)
      .setName('启用智能补全')
      .setDesc('启用智能补全功能')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSmartCompletion)
          .onChange(async (value) => {
            this.plugin.settings.enableSmartCompletion = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('启用上下文感知')
      .setDesc('根据光标位置自动提供相关补全建议')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableContextAware).onChange(async (value) => {
          this.plugin.settings.enableContextAware = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('启用最小触发')
      .setDesc('在特定格式位置（如场景标题、角色名）即使没有输入也显示建议')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableMinimalTrigger).onChange(async (value) => {
          this.plugin.settings.enableMinimalTrigger = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('启用拼音匹配')
      .setDesc('启用拼音首字母匹配功能')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enablePinyin).onChange(async (value) => {
          this.plugin.settings.enablePinyin = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('智能补全最小触发长度')
      .setDesc('输入多少个字符后开始智能补全建议')
      .addSlider((slider) =>
        slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.smartMinLength)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.smartMinLength = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('智能补全最大建议数')
      .setDesc('智能补全最多显示多少个建议')
      .addSlider((slider) =>
        slider
          .setLimits(5, 20, 1)
          .setValue(this.plugin.settings.smartMaxSuggestions)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.smartMaxSuggestions = value;
            await this.plugin.saveSettings();
          }),
      );

    // ========== 组合建议设置 ==========
    containerEl.createEl('h3', { text: '组合建议' });

    new Setting(containerEl)
      .setName('启用场景/对话组合建议')
      .setDesc('生成「场景×时间」「角色×台词」的组合词条；词库较大时组合项可能淹没真实词条，可关闭')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableCombos).onChange(async (value) => {
          this.plugin.settings.enableCombos = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('组合建议最大条数')
      .setDesc('组合词条的上限，超出部分自动截断（仅启用组合建议时生效）')
      .addSlider((slider) =>
        slider
          .setLimits(20, 200, 10)
          .setValue(this.plugin.settings.comboMaxItems)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.comboMaxItems = value;
            await this.plugin.saveSettings();
          }),
      );

    // ========== 第三部分：快捷悬浮面板设置 ==========
    containerEl.createEl('h3', { text: '快捷悬浮面板' });

    new Setting(containerEl)
      .setName('启用快捷悬浮面板')
      .setDesc('在编辑器界面显示词库快捷操作面板')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableQuickPanel).onChange(async (value) => {
          this.plugin.settings.enableQuickPanel = value;
          await this.plugin.saveSettings();

          // 立即创建或销毁面板
          if (value && !this.plugin.quickPanel) {
            this.plugin.quickPanel = new LibraryEdgeStrips(this.plugin);
            this.plugin.quickPanel.create();
          } else if (!value && this.plugin.quickPanel) {
            this.plugin.quickPanel.destroy();
            this.plugin.quickPanel = null;
          }
        }),
      );

    new Setting(containerEl)
      .setName('词库更新自动刷新')
      .setDesc('修改词库文件后自动刷新当前词库（无需手动操作）')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableAutoRefresh).onChange(async (value) => {
          this.plugin.settings.enableAutoRefresh = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('自动刷新后显示通知')
      .setDesc('词库自动刷新后显示简短通知')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAutoRefreshNotice).onChange(async (value) => {
          this.plugin.settings.showAutoRefreshNotice = value;
          await this.plugin.saveSettings();
        }),
      );

    // ========== 格式模板（数据驱动，formats.json） ==========
    this.formatsArea = containerEl.createEl('div', { cls: 'blfc-fmt-area' });
    this.renderFormatsArea();

    // ========== 第四部分：词库管理（配置主区；词库列表在二级页） ==========
    this.renderLibraryOverview();

    // ========== 第五部分：词库参考（入口卡片；词库格式说明在二级页） ==========
    this.renderReferenceOverview();

    // ========== 第六部分：调试 ==========
    containerEl.createEl('h3', { text: '调试' });

    new Setting(containerEl)
      .setName('测试功能')
      .setDesc('测试当前词库加载情况')
      .addButton((button) =>
        button.setButtonText('测试').onClick(async () => {
          const libraryDir = this.plugin.libraryManager.getLibraryDirectory();
          const libraries = this.plugin.libraryManager.getAvailableLibraries();
          const activeLibrary = this.plugin.libraryManager.activeLibrary;

          let message = '';
          if (libraryDir) {
            message += `词库文件夹: ${libraryDir}\n`;
            message += `找到 ${libraries.length} 个词库\n`;

            if (activeLibrary) {
              const info = this.plugin.libraryManager.getLibraryInfo(activeLibrary);
              message += `当前词库: ${activeLibrary}\n`;
              if (info) {
                message += `总词条数: ${info.itemCount}个\n`;
                if (info.metadata && Object.keys(info.metadata).length > 0) {
                  message += `元数据: ${JSON.stringify(info.metadata)}\n`;
                }
              }
            } else {
              message += '当前未使用词库';
            }
          } else {
            message = '请先设置词库文件夹';
          }

          new Notice(message);
        }),
      );
  }

  // ========== 模板库设置（主界面概览 + 分组管理进入二级） ==========

  /** 重建主设置区（改动后调用；分组内部管理在 GroupManageModal 二级界面） */
  private renderFormatsArea(): void {
    if (!this.formatsArea) return;
    const area = this.formatsArea;
    area.empty();
    const fm = this.plugin.formatsManager;
    const file = fm.file;

    // —— 标题栏：格式模板 + 新增 ——
    const header = area.createEl('div', { cls: 'blfc-fmt-header' });
    header.createEl('span', { text: '格式模板', cls: 'blfc-fmt-title' });
    const addBtn = header.createEl('button', {
      text: '新增',
      cls: 'blfc-fmt-add-btn',
    });
    addBtn.addEventListener('click', () => {
      new SimpleTextModal(
        this.app,
        '新建分组',
        '分组名，如：周报模板',
        '',
        (name) => {
          const g = { id: fm.newCustomId('grp'), name };
          void fm.mutate((d) => {
            d.groups.push(g);
            return null;
          });
          this.renderFormatsArea();
        },
      ).open();
    });

    // —— 入口：默认触发符 + 常驻命令 ——
    const entryRow = area.createEl('div', { cls: 'blfc-fmt-entry' });
    entryRow.createEl('label', { text: '默认触发符', cls: 'blfc-fmt-entry-label' });
    const chInput = entryRow.createEl('input', {
      type: 'text',
      value: fm.triggerChar,
      placeholder: '@',
      cls: 'blfc-fmt-trigger-input',
      title: '未设专属触发符的分组由它弹出；支持多字符（如 ##）',
    });
    chInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.commitTriggerChar(chInput.value);
    });
    chInput.addEventListener('blur', () => this.commitTriggerChar(chInput.value));
    entryRow.createEl('span', {
      text: '输入后弹出模板菜单；可为某分组单独设专属触发符（在其管理界面里）。',
      cls: 'blfc-fmt-hint',
    });

    // —— 分组概览（每行一行；管理在二级弹窗） ——
    if (file.groups.length === 0) {
      area.createEl('div', { text: '暂无分组，点右上角「新增」开始。', cls: 'blfc-fmt-empty' });
    } else {
      file.groups.forEach((g) => this.renderGroupRow(area, g.id));
    }

    // —— 高级（折叠） ——
    const adv = area.createEl('details', { cls: 'blfc-fmt-advanced' });
    adv.createEl('summary', { text: '高级：导出 / 导入' });
    const advRow = adv.createEl('div', { cls: 'blfc-fmt-tools' });
    const mkAdv = (text: string, onClick: () => void): HTMLButtonElement => {
      const b = advRow.createEl('button', { text, cls: 'blfc-fmt-btn' });
      b.addEventListener('click', onClick);
      return b;
    };
    mkAdv('导出配置…', () => new FormatsTransferModal(this.app, this.plugin, 'export').open());
    mkAdv('导入配置…', () => new FormatsTransferModal(this.app, this.plugin, 'import').open());
  }

  /** 分组一行概览：名称 / 条数+触发命令 / 进入箭头（仅箭头可点击） */
  private renderGroupRow(area: HTMLElement, groupId: string): void {
    const fm = this.plugin.formatsManager;
    const group = fm.groupById(groupId);
    if (!group) return;
    const count = fm.file.items.filter((i) => i.group === groupId).length;
    const row = area.createEl('div', { cls: 'blfc-fmt-group-row' });
    const main = row.createEl('div', { cls: 'blfc-fmt-group-row-main' });
    main.createEl('span', { text: group.name, cls: 'blfc-fmt-group-row-name' });
    main.createEl('span', {
      text: `${count}条 · 触发 ${group.trigger ?? fm.triggerChar}`,
      cls: 'blfc-fmt-group-row-meta',
    });
    const arrowBtn = row.createEl('button', {
      text: '›',
      title: '进入分组设置',
      cls: 'blfc-fmt-arrow',
    });
    arrowBtn.addEventListener('click', () => this.goToGroup(groupId));
  }

  // ========== 分组二级页面（设置页内页面导航，非弹窗） ==========

  /** 进入分组设置页 */
  goToGroup(groupId: string): void {
    this.activeGroupId = groupId;
    this.display();
  }

  /** 返回主设置页 */
  backToOverview(): void {
    this.activeGroupId = null;
    this.showLibraryList = false;
    this.showLibraryReference = false;
    this.display();
  }

  /** 进入词库列表二级页 */
  goToLibraryList(): void {
    this.showLibraryList = true;
    this.display();
  }

  /** 进入「词库参考」二级页（词库格式说明） */
  goToReference(): void {
    this.showLibraryReference = true;
    this.display();
  }

  /** 渲染分组设置二级页面（替换整页内容） */
  private renderGroupSubpage(groupId: string): void {
    const fm = this.plugin.formatsManager;
    const group = fm.groupById(groupId);
    if (!group) {
      this.backToOverview();
      return;
    }
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');

    // 顶部返回栏
    const nav = containerEl.createEl('div', { cls: 'blfc-fmt-subnav' });
    const backBtn = nav.createEl('button', { text: '返回', cls: 'blfc-fmt-btn' });
    backBtn.addEventListener('click', () => this.backToOverview());
    nav.createEl('span', { text: '格式模板', cls: 'blfc-fmt-subnav-crumb' });

    const headTitle = containerEl.createEl('h3', { text: `${group.name} · 分组设置` });

    // —— 专属触发符 ——
    const triggerRow = containerEl.createEl('div', { cls: 'blfc-fmt-entry' });
    triggerRow.createEl('label', { text: '专属触发符', cls: 'blfc-fmt-entry-label' });
    const trigInput = triggerRow.createEl('input', {
      type: 'text',
      value: group.trigger || '',
      placeholder: `留空＝跟随默认 ${fm.triggerChar}`,
      cls: 'blfc-fmt-trigger-input',
      title: '留空则用全局默认触发符弹出本组；填了如 # 后，输入 # 才弹本组',
    });
    const commitTrig = (raw: string) => {
      const v = raw.trim();
      if (!v || v === fm.triggerChar) {
        void fm.mutate((d) => {
          const g = d.groups.find((x) => x.id === groupId);
          if (g) delete g.trigger;
          return null;
        });
        trigInput.value = '';
        new Notice('已恢复跟随全局默认触发符');
        return;
      }
      const others = fm
        .currentTriggerValues()
        .filter((c) => !(group.trigger && c === group.trigger) && c !== v);
      const check = fm.validateTriggerSet([...others, v]);
      if (!check.ok) {
        new Notice(check.message);
        return;
      }
      void fm.mutate((d) => {
        const g = d.groups.find((x) => x.id === groupId);
        if (g) g.trigger = v;
        return null;
      });
      trigInput.value = v;
      new Notice(`已设为专属触发符：${v}`);
    };
    trigInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commitTrig(trigInput.value);
    });
    trigInput.addEventListener('blur', () => commitTrig(trigInput.value));
    containerEl.createEl('div', {
      text: '空 = 跟随全局默认；多组可用同一触发符（合并弹出）；不同触发符禁止互为前缀（如 @ 与 @@）。',
      cls: 'blfc-fmt-hint',
    });

    // —— 改名 ——
    const renameBtn = containerEl.createEl('button', {
      text: '重命名分组…',
      cls: 'blfc-fmt-btn',
    });
    renameBtn.style.margin = '8px 0';
    renameBtn.addEventListener('click', () => {
      new SimpleTextModal(this.app, '重命名分组', '分组名', group.name, (name) => {
        void fm.mutate((d) => {
          const g = d.groups.find((x) => x.id === groupId);
          if (g) g.name = name;
          return null;
        });
        headTitle.textContent = `${name.trim()} · 分组设置`;
      }).open();
    });

    // —— 直达命令（本组绑定关系，槽位全局共享） ——
    containerEl.createEl('div', { cls: 'blfc-fmt-subhead' }).textContent = '直达命令';
    containerEl.createEl('div', {
      text: '勾选 = 本组由该命令弹出。命令可绑定多个分组；需重载插件后命令才出现在命令面板 / 快捷键里。',
      cls: 'blfc-fmt-hint',
    });
    const quickBox = containerEl.createEl('div', { cls: 'blfc-fmt-qc-box' });
    const reRenderQuick = () => {
      quickBox.empty();
      const qcs = [...fm.file.quickCommands].sort((a, b) => a.slot - b.slot);
      if (qcs.length === 0) {
        quickBox.createEl('div', { text: '还没有直达命令，点下方「+ 添加」创建。', cls: 'blfc-fmt-empty' });
      }
      qcs.forEach((q) => {
        const row = quickBox.createEl('label', { cls: 'blfc-fmt-qc-row' });
        const cb = row.createEl('input', { type: 'checkbox' });
        cb.checked = q.groupIds.includes(groupId);
        cb.addEventListener('change', () => {
          void fm.mutate((d) => {
            const qq = d.quickCommands.find((x) => x.slot === q.slot);
            if (!qq) return null;
            if (cb.checked) {
              if (!qq.groupIds.includes(groupId)) qq.groupIds.push(groupId);
            } else {
              qq.groupIds = qq.groupIds.filter((x) => x !== groupId);
            }
            return null;
          });
          new Notice(cb.checked ? '已绑定本组' : '已解除本组');
          reRenderQuick();
        });
        row.createEl('span', { text: `直达 ${q.slot} · ${q.name}`, cls: 'blfc-fmt-qc-name' });
        const bound = q.groupIds.length;
        row.createEl('span', { text: `已绑 ${bound} 组`, cls: 'blfc-fmt-count' });
        const del = row.createEl('button', { text: '✕', title: '删除该直达命令（解除所有分组绑定）', cls: 'blfc-fmt-btn' });
        del.addEventListener('click', (ev) => {
          ev.preventDefault();
          const boundNow = fm.file.quickCommands.find((x) => x.slot === q.slot)?.groupIds.length ?? 0;
          new ConfirmModal(
            this.app,
            '删除直达命令？',
            `将删除「直达 ${q.slot} · ${q.name}」，其绑定的 ${boundNow} 个分组一并解除。`,
            () => {
              void fm.mutate((d) => {
                d.quickCommands = d.quickCommands.filter((x) => x.slot !== q.slot);
                return null;
              });
              reRenderQuick();
            },
          ).open();
        });
      });
      const addQuick = quickBox.createEl('button', {
        text: '+ 添加直达命令',
        cls: 'blfc-fmt-btn',
      });
      addQuick.addEventListener('click', () => {
        if (fm.file.quickCommands.length >= MAX_QUICK_COMMANDS) {
          new Notice(`直达命令最多 ${MAX_QUICK_COMMANDS} 条`);
          return;
        }
        new DirectCommandModal(
          this.app,
          fm.file.groups.map((g) => ({ id: g.id, name: g.name })),
          (name, groupIds) => {
            const slot = this.nextFreeSlot(fm.file);
            if (!slot) {
              new Notice(`直达命令最多 ${MAX_QUICK_COMMANDS} 条`);
              return;
            }
            void fm.mutate((d) => {
              d.quickCommands.push({ slot, name, groupIds });
              return null;
            });
            new Notice('已添加（命令名称需重载插件后显示）');
            reRenderQuick();
          },
          [groupId],
        ).open();
      });
    };
    reRenderQuick();

    // —— 条目 ——
    containerEl.createEl('div', { cls: 'blfc-fmt-subhead' }).textContent = '模板条目';
    const itemsBox = containerEl.createEl('div', { cls: 'blfc-fmt-items' });
    const addBtn = containerEl.createEl('button', {
      text: '+ 添加模板到本组',
      cls: 'blfc-fmt-btn',
    });
    addBtn.style.margin = '6px 0 10px';

    const reRenderItems = () => {
      itemsBox.empty();
      const items = fm.file.items.filter((i) => i.group === groupId);
      if (items.length === 0) {
        itemsBox.createEl('div', { text: '（空组）', cls: 'blfc-fmt-empty' });
      }
      items.forEach((item, rowIdx) => {
        const row = itemsBox.createEl('div', { cls: 'blfc-fmt-item-row' });
        const nameBtn = row.createEl('button', {
          text: item.name,
          title: '点击编辑',
          cls: 'blfc-fmt-item-name',
        });
        const openEdit = () => {
          new FormatItemEditModal(this.app, this.plugin, { ...item }, (saved) => {
            void fm.mutate((d) => {
              const idx = d.items.findIndex((i) => i.id === saved.id);
              if (idx >= 0) d.items[idx] = saved;
              return null;
            });
            reRenderItems();
          }).open();
        };
        nameBtn.addEventListener('click', openEdit);
        const text = item.text;
        row.createEl('span', {
          text: text.length > 52 ? `${text.slice(0, 52)}…` : text,
          title: text,
          cls: 'blfc-fmt-item-tpl',
        });
        const mk = (t: string, title: string, onClick: () => void) => {
          const b = row.createEl('button', { text: t, title, cls: 'blfc-fmt-btn' });
          b.addEventListener('click', onClick);
        };
        mk('↑', '上移（组内顺序）', () => {
          void fm.mutate((d) => {
            const arr = d.items.filter((i) => i.group === groupId);
            const idx = arr.findIndex((i) => i.id === item.id);
            if (idx <= 0) return null;
            const a = arr[idx - 1];
            const b = arr[idx];
            const i1 = d.items.indexOf(a);
            const i2 = d.items.indexOf(b);
            if (i1 >= 0 && i2 >= 0) [d.items[i1], d.items[i2]] = [d.items[i2], d.items[i1]];
            return null;
          });
          reRenderItems();
        });
        mk('↓', '下移（组内顺序）', () => {
          void fm.mutate((d) => {
            const arr = d.items.filter((i) => i.group === groupId);
            const idx = arr.findIndex((i) => i.id === item.id);
            if (idx < 0 || idx >= arr.length - 1) return null;
            const a = arr[idx];
            const b = arr[idx + 1];
            const i1 = d.items.indexOf(a);
            const i2 = d.items.indexOf(b);
            if (i1 >= 0 && i2 >= 0) [d.items[i1], d.items[i2]] = [d.items[i2], d.items[i1]];
            return null;
          });
          reRenderItems();
        });
        mk('✕', '删除该模板（删除后不可恢复）', () => {
          void fm.mutate((d) => {
            d.items = d.items.filter((i) => i.id !== item.id);
            return null;
          });
          reRenderItems();
        });
      });
    };
    reRenderItems();

    addBtn.addEventListener('click', () => {
      const item: FormatItem = {
        id: fm.newCustomId('tpl'),
        name: '新模板',
        text: '$0',
        group: groupId,
      };
      void fm.mutate((d) => {
        d.items.push(item);
        return null;
      });
      new FormatItemEditModal(this.app, this.plugin, item, (saved) => {
        void fm.mutate((d) => {
          const idx = d.items.findIndex((i) => i.id === saved.id);
          if (idx >= 0) d.items[idx] = saved;
          return null;
        });
        reRenderItems();
      }).open();
    });

    // —— 删除分组（页尾） ——
    const delBtn = containerEl.createEl('button', {
      text: '删除该分组及组内模板',
      cls: 'blfc-fmt-btn',
    });
    delBtn.style.marginTop = '14px';
    delBtn.style.color = 'var(--text-error)';
    delBtn.addEventListener('click', () => {
      const count = fm.file.items.filter((i) => i.group === groupId).length;
      new ConfirmModal(
        this.app,
        '删除分组？',
        `将删除分组「${group.name}」及其 ${count} 条模板。删除后不可恢复，请确认。`,
        () => {
          void fm.mutate((d) => {
            d.groups = d.groups.filter((g) => g.id !== groupId);
            d.items = d.items.filter((i) => i.group !== groupId);
            d.quickCommands.forEach((q) => {
              q.groupIds = q.groupIds.filter((x) => x !== groupId);
            });
            return null;
          });
          this.backToOverview();
        },
      ).open();
    });
  }

  private nextFreeSlot(file: { quickCommands: Array<{ slot: number }> }): number | undefined {
    const used = new Set(file.quickCommands.map((q) => q.slot));
    for (let s = 1; s <= MAX_QUICK_COMMANDS; s++) {
      if (!used.has(s)) return s;
    }
    return undefined;
  }

  /** 修改全局默认触发符：与所有分组专属触发符一起做前缀冲突校验 */
  private commitTriggerChar(value: string): void {
    const ch = value.trim();
    if (!ch) {
      new Notice('默认触发符不能为空');
      this.renderFormatsArea();
      return;
    }
    const others = this.plugin.formatsManager.currentTriggerValues().filter(
      (c) => c !== this.plugin.formatsManager.triggerChar,
    );
    const check = this.plugin.formatsManager.validateTriggerSet([...others, ch]);
    if (!check.ok) {
      new Notice(check.message);
      this.renderFormatsArea();
      return;
    }
    void this.plugin.formatsManager.mutate((d) => {
      d.triggerChar = ch;
      return null;
    });
    this.renderFormatsArea();
  }

  // ========== 词库参考：主区入口卡片 + 二级页（词库格式说明） ==========

  /** 主区渲染：词库参考卡片——标题栏（词库格式说明入口）+ 一句话描述 */
  private renderReferenceOverview(): void {
    const { containerEl } = this;
    const area = containerEl.createEl('div', { cls: 'blfc-lib-area' });

    // —— 标题栏：词库参考 + 进入二级页入口 ——
    const header = area.createEl('div', { cls: 'blfc-lib-header' });
    header.createEl('span', { text: '词库参考', cls: 'blfc-lib-title' });
    const viewBtn = header.createEl('button', {
      text: '查看 ›',
      title: '词库文件的格式说明',
      cls: 'blfc-lib-entry-btn',
    });
    viewBtn.addEventListener('click', () => this.goToReference());

    // —— 一句话描述（点标题栏右侧入口进入完整说明） ——
    const descRow = area.createEl('div', { cls: 'blfc-fmt-entry' });
    descRow.style.padding = '2px 8px 4px';
    descRow.createEl('span', {
      text: '词库文件（.md）的书写格式：章节标题、词条分隔（显示|插入|描述）、列表标记与 YAML 元数据。',
      cls: 'blfc-fmt-hint',
    });
  }

  /** 渲染「词库参考」二级页面：仅保留词库 .md 文件格式说明（替换整页内容） */
  private renderReferenceSubpage(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');

    // 顶部返回栏
    const nav = containerEl.createEl('div', { cls: 'blfc-fmt-subnav' });
    const backBtn = nav.createEl('button', { text: '返回', cls: 'blfc-fmt-btn' });
    backBtn.addEventListener('click', () => this.backToOverview());
    nav.createEl('span', { text: '词库参考', cls: 'blfc-fmt-subnav-crumb' });
    nav.createEl('span', { text: '› 词库格式说明', cls: 'blfc-fmt-subnav-crumb' });

    containerEl.createEl('h3', { text: '词库格式说明' });
    containerEl.createEl('div', {
      text: '词库是一个普通 Markdown 文件：一级标题为词库名，二级标题为类别（可自由命名），类别下逐行写词条。',
      cls: 'blfc-fmt-hint',
    });

    const doc = containerEl.createEl('div', { cls: 'blfc-ref-doc' });

    doc.createEl('h4', { text: '词库文件格式：' });
    doc.createEl('pre').createEl('code', {
      text: `# 我的词库

## 角色
主角|林风|普通少年，意外获得修仙传承
师尊|玄天真人|元婴期修士，严厉但护短

## 常用词
天材地宝|天材地宝|珍贵的修炼资源
机缘巧合|机缘巧合|意外的机遇

## 英语单词
happy|happy|快乐的
sad|sad|悲伤的`,
    });

    doc.createEl('h4', { text: '格式说明：' });
    const ul = doc.createEl('ul');
    const addLi = (html: string): void => {
      ul.createEl('li').innerHTML = html;
    };
    addLi('<strong>简单格式：</strong><code>词条</code>（显示与插入文本相同）');
    addLi('<strong>增强格式：</strong><code>显示文本|插入文本</code>');
    addLi('<strong>带描述：</strong><code>显示文本|插入文本|描述</code>（描述可选，仅提示用）');
    addLi('支持列表标记（<code>-</code> 或 <code>*</code>）开头');
    addLi('支持 YAML 元数据（文件开头用 <code>---</code> 包裹）');
    addLi('类别（<code>##</code>）可自由命名；<code>###</code> 三级标题归入最近一个二级类别，不另起类别');
  }

  // ========== 词库管理：主区（配置卡片）+ 二级页（词库列表） ==========

  /** 主区渲染：词库管理卡片——标题栏（词库列表入口）+ 词库文件夹路径设置（含刷新按钮） */
  private renderLibraryOverview(): void {
    const { containerEl } = this;
    const area = containerEl.createEl('div', { cls: 'blfc-lib-area' });

    // —— 标题栏：词库管理 + 词库列表入口（二级页） ——
    const header = area.createEl('div', { cls: 'blfc-lib-header' });
    header.createEl('span', { text: '词库管理', cls: 'blfc-lib-title' });
    const listBtn = header.createEl('button', {
      text: '词库列表 ›',
      title: '查看全部词库并切换当前词库',
      cls: 'blfc-lib-entry-btn',
    });
    listBtn.addEventListener('click', () => this.goToLibraryList());

    // —— 词库文件夹：路径输入 + 刷新按钮 ——
    const folderItem = area.createEl('div', { cls: 'blfc-lib-folder-line' });
    folderItem.createEl('label', { text: '词库文件夹', cls: 'blfc-lib-config-label' });
    const folderInput = folderItem.createEl('input', {
      type: 'text',
      placeholder: '例如: 我的剧本库 或 /我的剧本/词库',
      cls: 'blfc-lib-folder-input',
    });
    folderInput.value = this.plugin.settings.libraryFolder || '';
    folderInput.addEventListener('change', async () => {
      this.plugin.settings.libraryFolder = folderInput.value.trim();
      await this.plugin.saveSettings();
      await this.plugin.libraryManager.loadLibraries();
      this.renderLibraryTable();
    });
    const refreshBtn = folderItem.createEl('button', {
      text: '刷新',
      cls: 'blfc-lib-refresh-btn',
    });
    refreshBtn.addEventListener('click', async () => {
      await this.plugin.libraryManager.reloadLibraries();
      new Notice('词库已刷新');
      this.renderLibraryTable();
    });
  }

  /** 渲染「词库列表」二级页面（替换整页内容；返回栏样式与分组二级页一致） */
  private renderLibraryListSubpage(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');

    // 顶部返回栏
    const nav = containerEl.createEl('div', { cls: 'blfc-fmt-subnav' });
    const backBtn = nav.createEl('button', { text: '返回', cls: 'blfc-fmt-btn' });
    backBtn.addEventListener('click', () => this.backToOverview());
    nav.createEl('span', { text: '词库管理', cls: 'blfc-fmt-subnav-crumb' });
    nav.createEl('span', { text: '› 词库列表', cls: 'blfc-fmt-subnav-crumb' });

    containerEl.createEl('h3', { text: '词库列表' });
    containerEl.createEl('div', {
      text: '点击词库行可切换当前词库；● = 当前使用。',
      cls: 'blfc-fmt-hint',
    });

    this.libraryTableContainer = containerEl.createEl('div', { cls: 'blfc-lib-table-wrap' });
    this.renderLibraryTable();
  }

  // 渲染词库表格
  private renderLibraryTable(): void {
    if (!this.libraryTableContainer) return;
    this.libraryTableContainer.empty();

    const libraries = this.plugin.libraryManager.getAvailableLibraries();
    const activeLibrary = this.plugin.libraryManager.activeLibrary;

    if (libraries.length === 0) {
      this.libraryTableContainer.createEl('p', {
        text: this.plugin.settings.libraryFolder
          ? `在 "${this.plugin.settings.libraryFolder}" 中没有找到词库文件`
          : '请先设置词库文件夹',
        cls: 'blfc-lib-empty',
      });
      return;
    }

    const table = this.libraryTableContainer.createEl('table', { cls: 'blfc-lib-table' });
    const thead = table.createEl('thead');
    const headRow = thead.createEl('tr');
    ['词库', '词条', '颜色', '图标', '当前'].forEach((h, i) => {
      const th = headRow.createEl('th', { text: h });
      if (i === 1) th.addClass('blfc-col-num');
      else if (i === 2 || i === 4) th.addClass('blfc-col-center');
    });

    const tbody = table.createEl('tbody');
    libraries.forEach((libraryName) => {
      const info = this.plugin.libraryManager.getLibraryInfo(libraryName);
      const isActive = activeLibrary === libraryName;

      const tr = tbody.createEl('tr', { cls: 'blfc-lib-row' });
      if (isActive) tr.addClass('blfc-row-active');
      tr.addEventListener('click', async () => {
        const ok = await this.plugin.libraryManager.setActiveLibrary(libraryName);
        if (!ok) return;
        await this.plugin.buildSmartCompletionIndex();
        this.plugin.updateStatusBar();
        if (this.plugin.quickPanel) this.plugin.quickPanel.refresh();
        this.renderLibraryTable();
      });

      tr.createEl('td', { text: libraryName, cls: 'blfc-col-name' });
      tr.createEl('td', { text: info ? String(info.itemCount) : '0', cls: 'blfc-col-num' });

      // 颜色列：取色器直接改写 settings.libraryColors 并实时刷新彩条
      const tdColor = tr.createEl('td', { cls: 'blfc-col-center' });
      const colorInput = tdColor.createEl('input', {
        type: 'color',
        cls: 'blfc-lib-color',
      });
      const currentColor =
        this.plugin.settings.libraryColors[libraryName] ||
        DEFAULT_LIBRARY_PALETTE[
          libraries.indexOf(libraryName) % DEFAULT_LIBRARY_PALETTE.length
        ];
      colorInput.value = currentColor;
      colorInput.addEventListener('click', (e) => e.stopPropagation());
      colorInput.addEventListener('input', () => {
        this.plugin.settings.libraryColors[libraryName] = colorInput.value;
        void this.plugin.saveSettings();
        if (this.plugin.quickPanel) this.plugin.quickPanel.refresh();
      });

      // 图标列：粘贴 lucide 图标名 / Emoji / <svg>… 原始字符串
      const tdIcon = tr.createEl('td');
      const iconInput = tdIcon.createEl('input', {
        type: 'text',
        cls: 'blfc-lib-icon',
        placeholder: '图标名 / Emoji / <svg>',
      });
      iconInput.value = this.plugin.settings.libraryIcons?.[libraryName] || '';
      iconInput.addEventListener('click', (e) => e.stopPropagation());
      iconInput.addEventListener('input', () => {
        const v = iconInput.value.trim();
        if (v) {
          this.plugin.settings.libraryIcons[libraryName] = v;
        } else {
          delete this.plugin.settings.libraryIcons[libraryName];
        }
        void this.plugin.saveSettings();
        if (this.plugin.quickPanel) this.plugin.quickPanel.refresh();
      });

      // 失焦时即时校验：ASCII 图标名无法被 setIcon 解析则红框提示
      // （CI-* 等第三方插件图标需其来源插件已启用/加载；也可换 lucide 内置名或 Emoji）
      iconInput.addEventListener('blur', () => {
        const v = iconInput.value.trim();
        if (!v || !/^[a-z0-9][a-z0-9-]*$/i.test(v)) {
          iconInput.classList.remove('blfc-lib-icon-err');
          iconInput.title = '';
          return;
        }
        const probe = document.createElement('span');
        try {
          setIcon(probe, v);
        } catch (e) {
          void e;
        }
        if (probe.querySelector('svg')) {
          iconInput.classList.remove('blfc-lib-icon-err');
          iconInput.title = '';
        } else {
          iconInput.classList.add('blfc-lib-icon-err');
          iconInput.title = '无法解析此图标名：请确认来源插件已启用（CI-* 需 Custom Icons 插件），或改用 lucide 内置图标名 / Emoji';
        }
      });

      const tdCurrent = tr.createEl('td', { cls: 'blfc-col-center' });
      tdCurrent.createEl('span', {
        text: isActive ? '●' : '○',
        cls: isActive ? 'blfc-dot-on' : 'blfc-dot-off',
      });
    });
  }
}
