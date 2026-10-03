/**
 * 插件设置面板
 */
import { Modal, Notice, PluginSettingTab, Setting, SettingPage, setIcon } from 'obsidian';
import type { App, ExtraButtonComponent, SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem } from 'obsidian';
import { FormatItemEditModal, FormatsTransferModal } from './formatModals';
import { DONATE_CODES, type DonateCode } from './donate';
import type { SimpleScriptCompleter } from './main';
import type { BLFormatCompleterSettings, FormatItem, ItemFormat } from './types';
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
    contentEl.createDiv({ text: '打开以下分组：', cls: 'blfc-fmt-edit-preview-label' });
    const listEl = contentEl.createDiv({ cls: 'blfc-fmt-group-pick' });
    this.groups.forEach((g) => {
      const label = listEl.createEl('label', { cls: 'blfc-fmt-group-pick-item' });
      const cb = label.createEl('input', { type: 'checkbox' });
      cb.checked = this.picked.has(g.id);
      label.createSpan({ text: g.name });
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
          .setDestructive()
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

/** 收款码等图片的放大预览：把 Data URI 铺满弹窗，便于手机扫码。Esc / 点击遮罩关闭。 */
class ImagePreviewModal extends Modal {
  constructor(
    app: App,
    private src: string,
    private label: string,
  ) {
    super(app);
    this.modalEl.addClass('blfc-image-preview-modal');
    this.titleEl.setText(label);
  }

  override onOpen(): void {
    const box = this.contentEl.createDiv({ cls: 'blfc-image-preview-box' });
    box.createEl('img', {
      cls: 'blfc-image-preview',
      attr: { src: this.src, alt: this.label },
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 词条格式 JSON 导入 / 导出弹窗（textarea，规避剪贴板权限差异） */
class ItemFormatsTransferModal extends Modal {
  constructor(
    app: App,
    private plugin: SimpleScriptCompleter,
    private onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');
    contentEl.createEl('h3', { text: '词条格式 导入 / 导出' });
    contentEl.createEl('p', {
      text: '上方是当前配置（itemFormats.json）：可直接复制备份；粘贴一份配置后点「导入」即覆盖。',
      cls: 'blfc-fmt-transfer-desc',
    });

    const ta = contentEl.createEl('textarea', { cls: 'blfc-fmt-transfer-textarea' });
    ta.value = this.plugin.itemFormatsManager.exportJson();
    ta.rows = 16;
    ta.addEventListener('keydown', (e) => e.stopPropagation());

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('复制配置').onClick(() => {
          ta.select();
          document.execCommand('copy');
          new Notice('已复制到剪贴板');
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText('导入')
          .setCta()
          .onClick(() => {
            const res = this.plugin.itemFormatsManager.importJson(ta.value);
            new Notice(res.message);
            if (res.ok) {
              this.onDone();
              this.close();
            }
          }),
      )
      .addButton((btn) => btn.setButtonText('关闭').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 设置页里的一个二级页：分组配置 / 词库列表 / 词条格式 / 词库参考 */
type SubpageMode =
  | { kind: 'group'; groupId: string }
  | { kind: 'libraryList' }
  | { kind: 'itemFormats' }
  | { kind: 'reference' };

/**
 * 二级页正文（1.13+ 声明式设置 API 的 page 载荷）。
 * 四种二级页共用这一个类，按 mode 渲染对应页面；渲染代码沿用改造前的实现，
 * 只是渲染目标从 tab 的 containerEl 换成 SettingPage 的 containerEl（页内逻辑不变）。
 * 注：1.13 没有公开的「代码跳转子页面」API，页面之间的切换全部交给框架的入口行。
 */
class InFlowSubpage extends SettingPage {
  private libraryTableContainer!: HTMLElement;

  constructor(
    private app: App,
    private plugin: SimpleScriptCompleter,
    private mode: SubpageMode,
    /** 数据变化后刷新插件设置页的定义（分组增删改 / 词条格式增删 / 词库切换等） */
    private onDataChanged: () => void,
  ) {
    super();
    this.title = InFlowSubpage.titleOf(plugin, mode);
  }

  /** 框架页面标题栏文案 */
  private static titleOf(plugin: SimpleScriptCompleter, mode: SubpageMode): string {
    switch (mode.kind) {
      case 'group':
        return plugin.formatsManager.groupById(mode.groupId)?.name ?? '分组设置';
      case 'libraryList':
        return '词库列表';
      case 'itemFormats':
        return '词条格式';
      case 'reference':
        return '词库格式说明';
    }
  }

  override display(): void {
    switch (this.mode.kind) {
      case 'group':
        this.renderGroupSubpage(this.mode.groupId);
        return;
      case 'libraryList':
        this.renderLibraryListSubpage();
        return;
      case 'itemFormats':
        this.renderItemFormatsSubpage();
        return;
      case 'reference':
        this.renderReferenceSubpage();
        return;
    }
  }

  /** 渲染分组设置二级页面（替换整页内容） */
  private renderGroupSubpage(groupId: string): void {
    const fm = this.plugin.formatsManager;
    const group = fm.groupById(groupId);
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');
    if (!group) {
      containerEl.createDiv({
        text: '该分组已不存在（可能刚被删除）。点上方返回回到设置页。',
        cls: 'blfc-fmt-empty',
      });
      return;
    }

    // —— 专属触发符 ——
    const triggerRow = containerEl.createDiv({ cls: 'blfc-fmt-entry' });
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
    containerEl.createDiv({
      text: '空 = 跟随全局默认；多组可用同一触发符（合并弹出）；不同触发符禁止互为前缀（如 @ 与 @@）。',
      cls: 'blfc-fmt-hint',
    });

    // —— 改名 ——
    const renameBtn = containerEl.createEl('button', {
      text: '重命名分组…',
      cls: 'blfc-fmt-btn blfc-fmt-btn-ren',
    });
    renameBtn.addEventListener('click', () => {
      new SimpleTextModal(this.app, '重命名分组', '分组名', group.name, (name) => {
        void fm.mutate((d) => {
          const g = d.groups.find((x) => x.id === groupId);
          if (g) g.name = name;
          return null;
        });
        this.title = `${name.trim()} · 分组设置`;
        this.onDataChanged();
      }).open();
    });

    // —— 直达命令（本组绑定关系，槽位全局共享） ——
    containerEl.createDiv({ cls: 'blfc-fmt-subhead' }).textContent = '直达命令';
    containerEl.createDiv({
      text: '勾选 = 本组由该命令弹出。命令可绑定多个分组；需重载插件后命令才出现在命令面板 / 快捷键里。',
      cls: 'blfc-fmt-hint',
    });
    const quickBox = containerEl.createDiv({ cls: 'blfc-fmt-qc-box' });
    const reRenderQuick = () => {
      quickBox.empty();
      const qcs = [...fm.file.quickCommands].sort((a, b) => a.slot - b.slot);
      if (qcs.length === 0) {
        quickBox.createDiv({ text: '还没有直达命令，点下方「+ 添加」创建。', cls: 'blfc-fmt-empty' });
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
        row.createSpan({ text: `直达 ${q.slot} · ${q.name}`, cls: 'blfc-fmt-qc-name' });
        const bound = q.groupIds.length;
        row.createSpan({ text: `已绑 ${bound} 组`, cls: 'blfc-fmt-count' });
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
    containerEl.createDiv({ cls: 'blfc-fmt-subhead' }).textContent = '模板条目';
    const itemsBox = containerEl.createDiv({ cls: 'blfc-fmt-items' });
    const addBtn = containerEl.createEl('button', {
      text: '+ 添加模板到本组',
      cls: 'blfc-fmt-btn blfc-fmt-btn-add',
    });

    const reRenderItems = () => {
      itemsBox.empty();
      const items = fm.file.items.filter((i) => i.group === groupId);
      if (items.length === 0) {
        itemsBox.createDiv({ text: '（空组）', cls: 'blfc-fmt-empty' });
      }
      items.forEach((item, rowIdx) => {
        const row = itemsBox.createDiv({ cls: 'blfc-fmt-item-row' });
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
        row.createSpan({
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
      cls: 'blfc-fmt-btn blfc-fmt-btn-danger',
    });
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
          // 1.13 无公开的「代码跳页」API：就地提示已删除，并刷新设置页上的分组入口
          this.onDataChanged();
          const { containerEl } = this;
          containerEl.empty();
          containerEl.addClass('blfc-plugin');
          containerEl.createDiv({
            text: `分组「${group.name}」已删除。点上方返回回到设置页。`,
            cls: 'blfc-fmt-empty',
          });
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


  /** 渲染「词库参考」二级页面：仅保留词库 .md 文件格式说明（替换整页内容） */
  private renderReferenceSubpage(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');

    containerEl.createDiv({
      text: '词库是一个普通 Markdown 文件：一级标题为词库名，二级标题为类别（可自由命名），类别下逐行写词条。',
      cls: 'blfc-fmt-hint',
    });

    const doc = containerEl.createDiv({ cls: 'blfc-ref-doc' });

    new Setting(doc).setName('词库文件格式：').setHeading();
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

    new Setting(doc).setName('格式说明：').setHeading();
    const ul = doc.createEl('ul');
    type LiPart = string | { tag: 'strong' | 'code'; text: string };
    const addRich = (parts: LiPart[]): void => {
      const li = ul.createEl('li');
      parts.forEach((p) => {
        if (typeof p === 'string') li.append(p);
        else li.createEl(p.tag, { text: p.text });
      });
    };
    addRich([
      '词条写法由你在「词条格式」里配置的模板决定，不再固定。默认提供三条：',
      { tag: 'code', text: '词条' },
      '、',
      { tag: 'code', text: '显示文本|插入文本' },
      '、',
      { tag: 'code', text: '显示文本|插入文本|描述' },
    ]);
    addRich([
      '模板里 ',
      { tag: 'code', text: '{显示}' },
      ' ',
      { tag: 'code', text: '{插入}' },
      ' ',
      { tag: 'code', text: '{描述}' },
      ' 是字段占位符，其余字符自动成为分隔符',
    ]);
    addRich(['支持列表标记（', { tag: 'code', text: '-' }, ' 或 ', { tag: 'code', text: '*' }, '）开头']);
    addRich(['支持 YAML 元数据（文件开头用 ', { tag: 'code', text: '---' }, ' 包裹）']);
    addRich(['类别（', { tag: 'code', text: '##' }, '）可自由命名；', { tag: 'code', text: '###' }, ' 三级标题归入最近一个二级类别，不另起类别']);
  }

  /** 词条格式变更后：重载词库（按新模板重新解析）并重建补全索引 */
  private async afterItemFormatsChanged(): Promise<void> {
    await this.plugin.libraryManager.reloadLibraries();
    await this.plugin.buildSmartCompletionIndex();
    if (this.plugin.quickPanel) this.plugin.quickPanel.refresh();
    this.onDataChanged();
  }

  /** 交换格式顺序（决定解析优先级） */
  private async moveItemFormat(index: number, delta: number): Promise<void> {
    await this.plugin.itemFormatsManager.mutate((draft) => {
      const target = index + delta;
      if (target < 0 || target >= draft.formats.length) return;
      const [moved] = draft.formats.splice(index, 1);
      draft.formats.splice(target, 0, moved);
    });
    await this.afterItemFormatsChanged();
  }

  /** 渲染「词条格式」二级页面（替换整页内容） */
  private renderItemFormatsSubpage(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');

    containerEl.createDiv({
      cls: 'blfc-fmt-hint',
      text: '一行词条怎么切分，完全由下面的模板决定：{显示} {插入} {描述} 是字段占位符，模板里的其他字符自动成为分隔符。解析时自上而下尝试，第一条匹配的生效 —— 精确的模板放前面，宽松的（如只有 {显示}）垫底。',
    });
    containerEl.createDiv({
      cls: 'blfc-fmt-hint',
      text: '字段缺省时的回退：未写 {插入} → 取显示文本；未写 {描述} → 空。删光全部格式后，词库将解析不出任何词条。',
    });

    // —— 示例词条：所有格式的实时预览共用这一行 ——
    const sampleRow = containerEl.createDiv({ cls: 'blfc-ifmt-sample' });
    sampleRow.createEl('label', { text: '示例词条', cls: 'blfc-ifmt-label' });
    const sampleInput = sampleRow.createEl('input', {
      type: 'text',
      cls: 'blfc-ifmt-sample-input',
      placeholder: '贴一行词库里的词条，实时看它被哪条格式命中',
    });
    sampleInput.value = '天材地宝|天材地宝|珍贵的修炼资源';

    const listWrap = containerEl.createDiv({ cls: 'blfc-ifmt-list' });

    const renderList = (): void => {
      listWrap.empty();
      const formats = this.plugin.itemFormatsManager.formats;
      const sample = sampleInput.value;

      if (formats.length === 0) {
        listWrap.createEl('p', {
          cls: 'blfc-lib-empty',
          text: '还没有任何词条格式。点下面的「新增格式」开始。',
        });
      }

      const hitId =
        this.plugin.itemFormatsManager.explainLine(sample).find((e) => e.matched)?.format.id ??
        null;

      formats.forEach((fmt, index) => {
        this.renderItemFormatRow(listWrap, fmt, index, formats.length, sample, hitId, renderList);
      });

      const actions = listWrap.createDiv({ cls: 'blfc-ifmt-actions' });

      const addBtn = actions.createEl('button', { text: '+ 新增格式', cls: 'mod-cta' });
      addBtn.addEventListener('click', () => {
        void (async () => {
          await this.plugin.itemFormatsManager.mutate((draft) => {
            draft.formats.push({
              id: this.plugin.itemFormatsManager.newCustomId(),
              name: '新格式',
              template: '{显示}|{插入}',
            });
          });
          await this.afterItemFormatsChanged();
          renderList();
        })();
      });

      const transferBtn = actions.createEl('button', { text: '导入 / 导出' });
      transferBtn.addEventListener('click', () => {
        new ItemFormatsTransferModal(this.app, this.plugin, () => {
          void (async () => {
            await this.afterItemFormatsChanged();
            renderList();
          })();
        }).open();
      });

      // 解析失败提示：模板改动后可能有行没人认领，给出示例便于定位
      const failCount = this.plugin.libraryManager.parseFailureCount;
      if (failCount > 0) {
        const samples = this.plugin.libraryManager.parseFailures.slice(0, 5);
        const warn = listWrap.createDiv({ cls: 'blfc-ifmt-warn' });
        warn.setText(
          `⚠ 当前词库有 ${failCount} 行未被任何格式匹配（已跳过）` +
            (samples.length ? `：${samples.join(' ｜ ')}` : ''),
        );
      }
    };

    sampleInput.addEventListener('input', renderList);
    renderList();
  }

  /** 渲染单条格式：名称 / 模板 / 排序删除 / 逐条实时预览 */
  private renderItemFormatRow(
    parent: HTMLElement,
    fmt: ItemFormat,
    index: number,
    total: number,
    sample: string,
    hitId: string | null,
    refresh: () => void,
  ): void {
    const row = parent.createDiv({ cls: 'blfc-ifmt-row' });
    if (fmt.id === hitId) row.addClass('blfc-ifmt-row-hit');

    const top = row.createDiv({ cls: 'blfc-ifmt-row-top' });

    const nameInput = top.createEl('input', {
      type: 'text',
      cls: 'blfc-ifmt-name',
      placeholder: '格式名称',
    });
    nameInput.value = fmt.name;

    const tplInput = top.createEl('input', {
      type: 'text',
      cls: 'blfc-ifmt-tpl',
      placeholder: '{显示}|{插入}|{描述}',
    });
    tplInput.value = fmt.template;

    const preview = row.createDiv({ cls: 'blfc-ifmt-preview' });

    /** 只刷新本行预览：不落盘、不重建列表 */
    const previewLine = (): void => {
      const template = tplInput.value.trim();
      const check = this.plugin.itemFormatsManager.validateTemplate(template);
      preview.removeClass('blfc-ifmt-preview-err');
      if (!check.ok) {
        preview.setText(`模板无效：${check.message}`);
        preview.addClass('blfc-ifmt-preview-err');
        return;
      }
      const parsed = this.plugin.itemFormatsManager.parseLineWithTemplate(template, sample);
      if (!parsed) {
        preview.setText('未命中该示例行');
        return;
      }
      preview.setText(
        `命中 → 显示「${parsed.display}」· 插入「${parsed.insert}」· 描述「${
          parsed.description || '（空）'
        }」`,
      );
    };

    // 字段快捷插入：在光标处补 {显示} / {插入} / {描述}
    const fieldBox = top.createDiv({ cls: 'blfc-ifmt-fields' });
    (['显示', '插入', '描述'] as const).forEach((field) => {
      const fieldBtn = fieldBox.createEl('button', {
        text: `{${field}}`,
        cls: 'blfc-ifmt-field-btn',
        title: `在光标处插入 {${field}}`,
      });
      fieldBtn.addEventListener('click', () => {
        const pos = tplInput.selectionStart ?? tplInput.value.length;
        tplInput.value = tplInput.value.slice(0, pos) + `{${field}}` + tplInput.value.slice(pos);
        previewLine();
        tplInput.focus();
      });
    });

    const ops = top.createDiv({ cls: 'blfc-ifmt-ops' });
    const upBtn = ops.createEl('button', { text: '↑', title: '上移（更优先）' });
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      void (async () => {
        await this.moveItemFormat(index, -1);
        refresh();
      })();
    });
    const downBtn = ops.createEl('button', { text: '↓', title: '下移' });
    downBtn.disabled = index === total - 1;
    downBtn.addEventListener('click', () => {
      void (async () => {
        await this.moveItemFormat(index, 1);
        refresh();
      })();
    });
    const delBtn = ops.createEl('button', { text: '删除', cls: 'blfc-ifmt-del' });
    delBtn.addEventListener('click', () => {
      void (async () => {
        await this.plugin.itemFormatsManager.mutate((draft) => {
          draft.formats = draft.formats.filter((x) => x.id !== fmt.id);
        });
        await this.afterItemFormatsChanged();
        refresh();
      })();
    });

    /** 落盘（失焦 / 回车触发）：校验通过才写入 */
    const commit = (): void => {
      const template = tplInput.value.trim();
      const check = this.plugin.itemFormatsManager.validateTemplate(template);
      if (!check.ok) {
        previewLine();
        return;
      }
      const name = nameInput.value.trim() || '未命名格式';
      void (async () => {
        await this.plugin.itemFormatsManager.mutate((draft) => {
          const target = draft.formats.find((x) => x.id === fmt.id);
          if (target) {
            target.name = name;
            target.template = template;
          }
        });
        await this.afterItemFormatsChanged();
        refresh();
      })();
    };

    tplInput.addEventListener('input', previewLine);
    tplInput.addEventListener('change', commit);
    nameInput.addEventListener('change', commit);

    previewLine();
  }

  /** 渲染「词库列表」二级页面（替换整页内容；返回栏样式与分组二级页一致） */
  private renderLibraryListSubpage(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('blfc-plugin');

    containerEl.createDiv({
      text: '点击词库行可切换当前词库；● = 当前使用。',
      cls: 'blfc-fmt-hint',
    });

    this.libraryTableContainer = containerEl.createDiv({ cls: 'blfc-lib-table-wrap' });
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
      tr.addEventListener('click', () => {
        void (async () => {
          const ok = await this.plugin.libraryManager.setActiveLibrary(libraryName);
          if (!ok) return;
          await this.plugin.buildSmartCompletionIndex();
          if (this.plugin.quickPanel) this.plugin.quickPanel.refresh();
          this.renderLibraryTable();
          this.onDataChanged();
        })();
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
        // 探测 span 挂 body 后立即移除（同步任务内完成，无视觉闪动）
        const probe = document.body.createSpan();
        try {
          setIcon(probe, v);
        } catch (e) {
          void e;
        }
        const ok = !!probe.querySelector('svg');
        probe.remove();
        if (ok) {
          iconInput.classList.remove('blfc-lib-icon-err');
          iconInput.title = '';
        } else {
          iconInput.classList.add('blfc-lib-icon-err');
          iconInput.title = '无法解析此图标名：请确认来源插件已启用（ci-* 需 custom icons 插件），或改用 lucide 内置图标名 / emoji';
        }
      });

      const tdCurrent = tr.createEl('td', { cls: 'blfc-col-center' });
      tdCurrent.createSpan({
        text: isActive ? '●' : '○',
        cls: isActive ? 'blfc-dot-on' : 'blfc-dot-off',
      });
    });
  }
}

/** 布尔设置项的键名（toggle 用） */
type BoolSettingKey = {
  [K in keyof BLFormatCompleterSettings]: BLFormatCompleterSettings[K] extends boolean ? K : never;
}[keyof BLFormatCompleterSettings];

/** 数值设置项的键名（slider 用） */
type NumberSettingKey = {
  [K in keyof BLFormatCompleterSettings]: BLFormatCompleterSettings[K] extends number ? K : never;
}[keyof BLFormatCompleterSettings];

/**
 * 插件设置页（1.13+ 声明式设置 API）。
 * 1.13 起 PluginSettingTab.display() 已废弃，设置项改由 getSettingDefinitions() 描述：
 * 全部设置项直接铺在本页；需要独立一页的内容（分组配置 / 词库列表 / 词条格式 / 词库参考）
 * 以 page 入口行的形式出现，点击进入 {@link InFlowSubpage}。
 */
export class SimpleScriptSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: SimpleScriptCompleter) {
    super(app, plugin);
  }

  /** 读取单个设置项（声明式 control 用） */
  override getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /** 写入并持久化设置项：走 plugin.saveSettings() 以保留其副作用（如悬浮面板的创建/销毁） */
  override async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.group('基本设置', [
        this.toggle('启用插件', '启用或禁用格式补全功能', 'enabled'),
        this.toggle('自动对话建议', '在角色名后自动建议插入对话格式', 'autoDialogue'),
      ]),

      this.group('智能补全', [
        this.toggle(
          '使用 Enter 提交词条',
          '开启后，弹窗中按 Enter 直接确认高亮的候选；关闭后 Enter 仅作换行，需用鼠标点击候选来确认',
          'enableEnterSubmit',
        ),
        this.toggle('启用智能补全', '启用智能补全功能', 'enableSmartCompletion'),
        this.toggle('启用上下文感知', '根据光标位置自动提供相关补全建议', 'enableContextAware'),
        this.toggle(
          '启用最小触发',
          '在特定格式位置（如场景标题、角色名）即使没有输入也显示建议',
          'enableMinimalTrigger',
        ),
        this.toggle(
          '搜索类弹窗中也补全',
          '命令面板 / 快速切换 / 第三方 SuggestModal 等「搜索类」弹窗内也触发补全。'
            + '第三方插件把普通输入框做成 SuggestModal 时可开启；默认关闭以免命令名被剧本候选刷屏',
          'enableInSearchPrompt',
        ),
        this.toggle('启用拼音匹配', '启用拼音首字母匹配功能', 'enablePinyin'),
        this.slider('智能补全最小触发长度', '输入多少个字符后开始智能补全建议', 'smartMinLength', 1, 5, 1),
        this.slider('智能补全最大建议数', '智能补全最多显示多少个建议', 'smartMaxSuggestions', 5, 20, 1),
      ]),

      this.group('组合建议', [
        this.toggle(
          '启用场景/对话组合建议',
          '生成「场景×时间」「角色×台词」的组合词条；词库较大时组合项可能淹没真实词条，可关闭',
          'enableCombos',
        ),
        this.slider(
          '组合建议最大条数',
          '组合词条的上限，超出部分自动截断（仅启用组合建议时生效）',
          'comboMaxItems',
          20,
          200,
          10,
        ),
      ]),

      this.group('快捷悬浮面板', [
        this.toggle('启用快捷悬浮面板', '在编辑器界面显示词库快捷操作面板', 'enableQuickPanel'),
        this.toggle('词库更新自动刷新', '修改词库文件后自动刷新当前词库（无需手动操作）', 'enableAutoRefresh'),
        this.toggle('自动刷新后显示通知', '词库自动刷新后显示简短通知', 'showAutoRefreshNotice'),
      ]),

      this.group('格式模板', this.formatItems(), 'blfc-fmt-compact'),
      this.group('词库管理', this.libraryItems()),
      this.group('词条格式', [this.itemFormatsEntry()]),
      this.group('词库参考', [
        {
          type: 'page',
          name: '词库参考',
          desc: '词库文件（.md）的书写格式：章节标题、词条分隔（显示|插入|描述）、列表标记与 YAML 元数据',
          page: () => this.page({ kind: 'reference' }),
        },
      ]),
      this.group('调试', [
        {
          name: '测试功能',
          desc: '测试当前词库加载情况',
          action: () => this.showLibraryTest(),
        },
      ]),

      ...this.donateGroups(),
    ];
  }

  /**
   * 「打赏支持」分组：把打赏收款码渲染成可折叠区块（默认收起，点击展开）。
   * 收款码以 Base64 Data URI 内联在 src/donate.ts，构建时打包进 main.js；
   * 未配置任何图片时不生成该分组。
   */
  private donateGroups(): SettingDefinitionItem[] {
    const codes: DonateCode[] = DONATE_CODES.filter((c) => c.src.trim().length > 0);
    if (codes.length === 0) return [];
    return [
      {
        type: 'group',
        items: [
          {
            name: '打赏支持',
            aliases: ['打赏', '赞赏', '捐赠', '收款码', 'donate', 'sponsor'],
            render: (setting) => {
              setting.settingEl.addClass('blfc-donate-row');
              const details = setting.settingEl.createEl('details', { cls: 'blfc-donate' });
              const summary = details.createEl('summary', { cls: 'blfc-donate-summary' });
              const chevron = summary.createSpan({ cls: 'blfc-donate-chevron' });
              setIcon(chevron, 'chevron-right');
              summary.createSpan({ cls: 'blfc-donate-label', text: '打赏支持' });
              summary.createSpan({
                cls: 'blfc-donate-hint',
                text: '如果这个插件对你有帮助，欢迎请作者喝杯咖啡',
              });
              const body = details.createDiv({ cls: 'blfc-donate-body' });
              const list = body.createDiv({ cls: 'blfc-donate-codes' });
              for (const code of codes) {
                const fig = list.createEl('figure', { cls: 'blfc-donate-code' });
                // 不用 <button> 包裹 <img>：Obsidian 全局按钮样式会限制高度并裁切二维码
                const img = fig.createEl('img', {
                  attr: {
                    src: code.src,
                    alt: code.alt,
                    role: 'button',
                    tabindex: '0',
                    title: '点击放大',
                    'aria-label': `${code.alt}，点击放大`,
                  },
                });
                const openPreview = () =>
                  new ImagePreviewModal(this.app, code.src, code.label).open();
                img.addEventListener('click', openPreview);
                img.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPreview();
                  }
                });
                fig.createEl('figcaption', { text: `${code.label} · 点击放大` });
              }
            },
          },
        ],
      },
    ];
  }

  /* ---------------- 定义构造小工具 ---------------- */

  private group(
    heading: string,
    items: SettingGroupItem[],
    cls?: string,
    extraButtons?: ((component: ExtraButtonComponent) => unknown)[],
  ): SettingDefinitionItem {
    const def: SettingDefinitionGroup = { type: 'group', heading, items };
    if (cls) def.cls = cls;
    if (extraButtons) def.extraButtons = extraButtons;
    return def;
  }

  private toggle(name: string, desc: string, key: BoolSettingKey): SettingDefinition {
    return { name, desc, control: { type: 'toggle', key, defaultValue: this.plugin.settings[key] } };
  }

  private slider(
    name: string,
    desc: string,
    key: NumberSettingKey,
    min: number,
    max: number,
    step: number,
  ): SettingDefinition {
    return {
      name,
      desc,
      control: { type: 'slider', key, min, max, step, defaultValue: this.plugin.settings[key] },
    };
  }

  /** 建一个二级页（数据变化后刷新本页定义，让入口行的描述保持最新） */
  private page(mode: SubpageMode): SettingPage {
    return new InFlowSubpage(this.app, this.plugin, mode, () => this.update());
  }

  /* ---------------- 格式模板 ---------------- */

  /** 默认触发符 + 各分组入口 + 新建 / 导出 / 导入 */
  private formatItems(): SettingGroupItem[] {
    const fm = this.plugin.formatsManager;
    const items: SettingGroupItem[] = [
      {
        name: '默认触发符',
        desc: '输入后弹出模板菜单；未设专属触发符的分组由它弹出，支持多字符（如 ##）',
        render: (setting) => {
          const input = setting.controlEl.createEl('input', {
            type: 'text',
            value: fm.triggerChar,
            placeholder: '@',
            cls: 'blfc-fmt-trigger-input',
          });
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') this.commitTriggerChar(input.value);
          });
          input.addEventListener('blur', () => this.commitTriggerChar(input.value));
        },
      },
    ];

    const groups = fm.file.groups;
    if (groups.length === 0) {
      items.push({ name: '暂无分组', desc: '点下方「新建分组」开始。' });
    } else {
      groups.forEach((g) => {
        const count = fm.file.items.filter((i) => i.group === g.id).length;
        items.push({
          type: 'page',
          name: g.name,
          desc: `${count} 条 · 触发 ${g.trigger ?? fm.triggerChar}`,
          page: () => this.page({ kind: 'group', groupId: g.id }),
        });
      });
    }

    items.push({
      name: '新建分组',
      desc: '分组把模板归到同一个菜单下，条目在分组页里增删',
      action: () => {
        new SimpleTextModal(this.app, '新建分组', '分组名，如：周报模板', '', (name) => {
          const g = { id: fm.newCustomId('grp'), name };
          void fm.mutate((d) => {
            d.groups.push(g);
            return null;
          });
          this.update();
        }).open();
      },
    });
    // 导出 / 导入合并为可折叠的「高级」区块，减少列表纵向占用
    items.push({
      name: '高级：导出 / 导入',
      desc: '备份或批量替换 formats.json 配置',
      render: (setting) => {
        setting.settingEl.empty();
        setting.settingEl.addClass('blfc-fmt-advanced-row');
        const details = setting.settingEl.createEl('details', { cls: 'blfc-fmt-advanced' });
        details.createEl('summary', { text: '高级：导出 / 导入' });
        const tools = details.createDiv({ cls: 'blfc-fmt-tools' });
        const exportBtn = tools.createEl('button', { text: '导出配置…', cls: 'blfc-fmt-btn' });
        exportBtn.addEventListener('click', () => new FormatsTransferModal(this.app, this.plugin, 'export').open());
        const importBtn = tools.createEl('button', { text: '导入配置…', cls: 'blfc-fmt-btn' });
        importBtn.addEventListener('click', () =>
          new FormatsTransferModal(this.app, this.plugin, 'import', () => this.update()).open(),
        );
      },
    });
    return items;
  }

  /** 修改全局默认触发符：与所有分组专属触发符一起做前缀冲突校验 */
  private commitTriggerChar(value: string): void {
    const fm = this.plugin.formatsManager;
    const ch = value.trim();
    if (!ch) {
      new Notice('默认触发符不能为空');
      this.update();
      return;
    }
    const others = fm.currentTriggerValues().filter((c) => c !== fm.triggerChar);
    const check = fm.validateTriggerSet([...others, ch]);
    if (!check.ok) {
      new Notice(check.message);
      this.update();
      return;
    }
    void fm.mutate((d) => {
      d.triggerChar = ch;
      return null;
    });
    this.update();
  }

  /* ---------------- 词库管理 ---------------- */

  /** 词库文件夹（保持自绘输入框 + 刷新按钮）+ 词库列表入口 */
  private libraryItems(): SettingGroupItem[] {
    const s = this.plugin.settings;
    const libraries = this.plugin.libraryManager.getAvailableLibraries();
    const active = this.plugin.libraryManager.activeLibrary;
    return [
      {
        name: '词库文件夹',
        desc: '存放词库 .md 文件的 vault 内相对路径（如 我的剧本库）',
        render: (setting) => {
          const input = setting.controlEl.createEl('input', {
            type: 'text',
            placeholder: '例如: 我的剧本库 或 /我的剧本/词库',
            cls: 'blfc-lib-folder-input',
          });
          input.value = s.libraryFolder || '';
          input.addEventListener('change', () => {
            s.libraryFolder = input.value.trim();
            void (async () => {
              await this.plugin.saveSettings();
              await this.plugin.libraryManager.loadLibraries();
              this.update();
            })();
          });
          const refreshBtn = setting.controlEl.createEl('button', {
            text: '刷新',
            cls: 'blfc-lib-refresh-btn',
          });
          refreshBtn.addEventListener('click', () => {
            void (async () => {
              await this.plugin.libraryManager.reloadLibraries();
              new Notice('词库已刷新');
              this.update();
            })();
          });
        },
      },
      {
        type: 'page',
        name: '词库列表',
        desc: libraries.length === 0
          ? '尚未找到词库文件'
          : `共 ${libraries.length} 个词库${active ? `，当前使用「${active}」` : '，尚未选择当前词库'}`,
        page: () => this.page({ kind: 'libraryList' }),
      },
    ];
  }

  /* ---------------- 词条格式 / 调试 ---------------- */

  /** 词条格式入口（描述里带上当前格式概览） */
  private itemFormatsEntry(): SettingGroupItem {
    const formats = this.plugin.itemFormatsManager.formats;
    return {
      type: 'page',
      name: '词条格式',
      desc: formats.length === 0
        ? '当前没有任何词条格式 —— 词库将解析不出任何词条，点此配置'
        : `共 ${formats.length} 条，按顺序尝试、第一条匹配的生效：${formats.map((f) => f.template).join('　/　')}`,
      page: () => this.page({ kind: 'itemFormats' }),
    };
  }

  /** 调试：把当前词库加载情况整段弹出来 */
  private showLibraryTest(): void {
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
  }
}
