# InFlow

> InFlow 是一枚让词库的灵感流入笔尖 —— Obsidian 写作补全插件。它把你积累的词库变成写作时的即时联想，并把常用格式做成"输入一个符号即可插入"的模板菜单。

- 无任何内置词库与模板预置：内容全部由你自己建立，插件升级**永不注入或覆盖**你的数据

---

## 功能一览

| 能力 | 说明 |
|---|---|
| **词库智能补全** | 输入即联想词库词条：支持中文、英文、**拼音首字母**（`lf` → 林风）、描述文字四路匹配；有精确/前缀/模糊子序列多层召回 |
| **上下文感知** | 识别 `##` 场景标题 / `####` 角色名 / 动作行，只推当前语境相关的词；自定义类别永远可用 |
| **格式模板** | 给常用文本起名字分组，输入触发符（默认 `@`，可分组专属）弹出菜单一键插入；模板支持变量、`$0` 光标定位、多行与转义 |
| **场景自动编号** | `{episode}` `{scene}` 变量自动数集与场次；一键重编号当前集 / 整个文档 |
| **词库彩条** | 编辑器左缘每个词库一条彩条，点击即切换；每条可独立配色、配图标 |
| **时间戳工具** | 光标插时间戳、写 frontmatter、按时间戳新建笔记（3 条命令） |
| **全输入框覆盖** | 补全不止编辑器：任何 input / textarea / 富文本框都能用（Obsidian 标题栏、搜索框等） |
| **自适应排序** | 记录你的选择频次，常用词自动上浮（MRU） |

---

## 安装

社区商店上线前采用手动安装：

1. 下载或构建本插件，得到文件夹 `inflow`（内含 `main.js`、`manifest.json`、`styles.css`）。
2. 放入 vault：`<你的库>/.obsidian/plugins/inflow/`（没有 `plugins` 目录则先开启第三方插件功能生成）。
3. Obsidian → 设置 → 第三方插件 → 刷新列表 → 启用 **InFlow**。

### 从源码构建

```bash
npm install          # 安装依赖
npm run build        # 产物 main.js（production）
npm run dev          # 监听式开发构建
npm run typecheck    # tsc --noEmit 类型检查
```

---

## License

MIT

---

# InFlow (English)

> Let your lexicon flow into your writing — a completion plugin for Obsidian screenwriting / fiction

InFlow is a desktop plugin for Obsidian aimed at **screenwriters, novelists and video-script writers**. It turns the lexicon you build up (characters, locations, dialogue, camera terms, vocabulary…) into instant suggestions while you write, and turns recurring formats such as scene headings and character lines into "type one symbol to insert" template menus.

- Plugin ID: `inflow` | Current version: **1.0.0** | Requires: Obsidian ≥ 0.15.0 (desktop only)
- No built-in lexicon or template presets: you create all the content yourself, and plugin updates **never inject or overwrite** your data

---

## Features

| Capability | Description |
|---|---|
| **Smart lexicon completion** | Start typing to get suggestions from your lexicon: matches Chinese, English, **pinyin initials** (`lf` → 林风) and description text; exact, prefix and fuzzy-subsequence recall tiers |
| **Context awareness** | Detects `##` scene headings / `####` character names / action lines and suggests only what fits the current context; custom categories are always available |
| **Format templates** | Name and group your recurring snippets; typing a trigger character (default `@`, or per-group) opens a menu that inserts them in one click; templates support variables, `$0` cursor placement, multiple lines and escapes |
| **Automatic scene numbering** | The `{episode}` and `{scene}` variables count episodes and scenes automatically; renumber the current episode or the whole document with one command |
| **Lexicon colour strips** | One strip per lexicon along the left edge of the editor — click to switch; every strip can have its own colour and icon |
| **Timestamp tools** | Insert a timestamp at the cursor, write it into frontmatter, or create a note named by timestamp (3 commands) |
| **Every input field** | Completion is not limited to the editor: any input / textarea / rich-text field works (Obsidian title bar, search box, …) |
| **Adaptive ranking** | Your selections are counted, so frequently used entries float to the top (MRU) |

---

## Installation

Until the plugin is available in the community store, install it manually:

1. Download or build the plugin to get an `inflow` folder (containing `main.js`, `manifest.json` and `styles.css`).
2. Put it in your vault: `<your vault>/.obsidian/plugins/inflow/` (if there is no `plugins` folder yet, enable community plugins first to create it).
3. In Obsidian: Settings → Community plugins → reload the list → enable **InFlow**.

### Build from source

```bash
npm install          # install dependencies
npm run build        # production build (main.js)
npm run dev          # watch-mode development build
npm run typecheck    # tsc --noEmit type check
```
---

## 📄 License

MIT
