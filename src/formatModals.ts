/**
 * 模板库相关弹窗：菜单（FuzzySuggest）/ 条目编辑 / JSON 导入导出
 *
 * v3：条目 = 名称 + 分组 + 文本；不再有 type / context 等概念。
 */
import { App, FuzzySuggestModal, Modal, Notice, Setting } from 'obsidian';
import type { Editor } from 'obsidian';
import type { SimpleScriptCompleter } from './main';
import type { FormatItem, FormatRenderResult, Suggestion } from './types';
import { renderFormatTemplate } from './formatEngine';

/** 取活动编辑器（命令 / 菜单插入用） */
export function getActiveEditor(app: App): Editor | null {
  const active = app.workspace.activeEditor as { editor?: Editor } | null;
  return active && active.editor ? active.editor : null;
}

/** 渲染结果 → 可读说明（条目编辑实时预览用） */
function describeRender(r: FormatRenderResult): string {
  if (!r.text) return '（空文本）';
  let s = JSON.stringify(r.text).replace(/^"|"$/g, '').replace(/\\n/g, '↵\n');
  if (r.selectFrom != null && r.selectTo != null) {
    s += `\n⏺ 默认词「${r.text.slice(r.selectFrom, r.selectTo)}」插入后将被选中`;
  } else if (r.cursorOffset != null) {
    s += `\n⏺ $0 光标落点：偏移 ${r.cursorOffset}`;
  }
  return s;
}

/** 模板菜单：FuzzySuggest 列出绑定分组条目，选中即插入当前光标处 */
export class FormatSuggestModal extends FuzzySuggestModal<Suggestion> {
  constructor(
    app: App,
    private plugin: SimpleScriptCompleter,
    private groupIds: string[],
  ) {
    super(app);
    this.setPlaceholder('选择要插入的模板…');
  }

  getItems(): Suggestion[] {
    return this.plugin.formatsManager.expandGroups(this.groupIds);
  }

  getItemText(item: Suggestion): string {
    return item.display || item.name || '';
  }

  onChooseItem(item: Suggestion): void {
    const editor = getActiveEditor(this.app);
    if (!editor) {
      new Notice('没有活动的编辑器');
      return;
    }
    this.plugin.insertFormatItem(editor, null, item, 0);
  }
}

/** 条目编辑弹窗（新增 / 修改模板条目：名称 + 分组 + 文本） */
export class FormatItemEditModal extends Modal {
  constructor(
    app: App,
    private plugin: SimpleScriptCompleter,
    private item: FormatItem,
    private onSave: (item: FormatItem) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');
    const isNew = this.item.id.startsWith('custom-');
    contentEl.createEl('h3', { text: isNew ? '添加模板' : '编辑模板' });

    new Setting(contentEl)
      .setName('名称')
      .setDesc('菜单中显示的条目名')
      .addText((t) => {
        t.setValue(this.item.name).onChange((v) => {
          this.item.name = v;
        });
      });

    const groups = this.plugin.formatsManager.file.groups;
    new Setting(contentEl)
      .setName('所属分组')
      .setDesc('该条目出现在哪个分组下（可稍后调整）')
      .addDropdown((d) => {
        groups.forEach((g) => d.addOption(g.id, g.name));
        const cur = groups.some((g) => g.id === this.item.group)
          ? this.item.group
          : groups[0]?.id || '';
        d.setValue(cur).onChange((v) => {
          this.item.group = v;
        });
        if (cur) this.item.group = cur;
      });

    new Setting(contentEl)
      .setName('文本')
      .setDesc(
        '支持变量 {date} {time} {datetime} {selection}（剧本条目另有 {episode} {scene} {scenetype}）；' +
          '$0 插入后光标落点；${0:默认词} 落点并选中；\\{ \\$ \\\\ 转义字面量。',
      )
      .addTextArea((ta) => {
        ta.setValue(this.item.text)
          .onChange((v) => {
            this.item.text = v;
          })
          .inputEl.rows = 3;
      });

    // 实时渲染预览（场景编号以 1.1 示范）
    const previewWrap = contentEl.createEl('div', { cls: 'blfc-fmt-edit-preview' });
    previewWrap.createEl('div', {
      text: '插入效果预览（场景编号以 1.1 示范）：',
      cls: 'blfc-fmt-edit-preview-label',
    });
    const previewBody = previewWrap.createEl('pre', {
      cls: 'blfc-fmt-edit-preview-body',
    });
    const refreshPreview = () => {
      const r = renderFormatTemplate(this.item.text, {
        sceneType: 'int',
        getSceneNumber: () => '1.1',
      });
      previewBody.textContent = describeRender(r);
    };
    refreshPreview();
    const textarea = contentEl.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) textarea.addEventListener('input', refreshPreview);

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('保存').setCta().onClick(() => {
          if (!this.item.name.trim()) {
            new Notice('名称不能为空');
            return;
          }
          if (!this.item.text.trim()) {
            new Notice('文本不能为空');
            return;
          }
          this.onSave({
            ...this.item,
            name: this.item.name.trim(),
            text: this.item.text,
            group: this.item.group,
          });
          this.close();
        }),
      )
      .addButton((btn) => btn.setButtonText('取消').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** JSON 导入导出弹窗（textarea，规避剪贴板权限差异） */
export class FormatsTransferModal extends Modal {
  private mode: 'export' | 'import';

  constructor(
    app: App,
    private plugin: SimpleScriptCompleter,
    mode: 'export' | 'import',
  ) {
    super(app);
    this.mode = mode;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');
    const isExport = this.mode === 'export';
    contentEl.createEl('h3', { text: isExport ? '导出模板配置' : '导入模板配置' });
    contentEl.createEl('p', {
      text: isExport
        ? '复制以下 JSON 保存或分享。'
        : '粘贴 formats.json 内容后点击导入（旧版文件会自动迁移为无内置 v4 结构）。',
      cls: 'blfc-fmt-transfer-desc',
    });
    const ta = contentEl.createEl('textarea', {
      cls: 'blfc-fmt-transfer-textarea',
    });
    if (isExport) {
      ta.value = this.plugin.formatsManager.exportJson();
      ta.readOnly = true;
    }
    ta.rows = 18;
    ta.addEventListener('keydown', (e) => e.stopPropagation());

    new Setting(contentEl)
      .addButton((btn) => {
        if (isExport) {
          btn.setButtonText('复制全部').onClick(() => {
            ta.select();
            document.execCommand('copy');
            new Notice('已复制到剪贴板');
          });
        } else {
          btn
            .setButtonText('导入')
            .setCta()
            .onClick(() => {
              const res = this.plugin.formatsManager.importJson(ta.value);
              new Notice(res.message);
              if (res.ok) this.close();
            });
        }
        return btn;
      })
      .addButton((btn) => btn.setButtonText('关闭').onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
