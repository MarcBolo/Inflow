/**
 * 词库相关模态框：创建词库 / 切换词库
 */
import { Modal } from 'obsidian';
import type { App } from 'obsidian';

/** 创建新词库的输入模态框 */
export class LibraryCreationModal extends Modal {
  constructor(app: App, private callback: (libraryName: string) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');

    contentEl.createEl('h3', { text: '创建新词库' });

    const inputEl = contentEl.createEl('input', {
      type: 'text',
      placeholder: '请输入词库名称',
      cls: 'blfc-lib-name-input',
    });

    inputEl.style.width = '100%';
    inputEl.style.padding = '8px';
    inputEl.style.margin = '10px 0';
    inputEl.style.border = '1px solid var(--background-modifier-border)';
    inputEl.style.borderRadius = '4px';

    setTimeout(() => inputEl.focus(), 100);

    const buttonContainer = contentEl.createEl('div', { cls: 'blfc-modal-btn-container' });
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '10px';
    buttonContainer.style.marginTop = '15px';

    const cancelButton = buttonContainer.createEl('button', { text: '取消' });
    cancelButton.onclick = () => this.close();

    const confirmButton = buttonContainer.createEl('button', { text: '创建' });
    confirmButton.onclick = () => this.submit(inputEl.value);

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit(inputEl.value);
    });
  }

  private submit(raw: string): void {
    const libraryName = raw.trim();
    if (libraryName) this.callback(libraryName);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 词库切换模态框 */
export class LibrarySwitcherModal extends Modal {
  constructor(
    app: App,
    private libraries: string[],
    private currentLibrary: string | null,
    private callback: (libraryName: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('blfc-plugin');

    contentEl.createEl('h3', { text: '切换词库' });

    if (this.libraries.length === 0) {
      contentEl.createEl('p', { text: '没有找到词库文件。请在设置中指定词库文件夹。' });
      return;
    }

    const list = contentEl.createEl('div', { cls: 'blfc-lib-list' });

    this.libraries.forEach((library) => {
      const item = list.createEl('div', { cls: 'blfc-lib-item' });

      if (library === this.currentLibrary) {
        item.addClass('blfc-is-active');
      }

      item.createEl('div', { text: library, cls: 'blfc-lib-name' });

      item.onclick = () => {
        this.callback(library);
        this.close();
      };
    });

    const buttonContainer = contentEl.createEl('div', { cls: 'blfc-modal-btn-container' });
    const cancelButton = buttonContainer.createEl('button', { text: '取消' });
    cancelButton.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
