#!/usr/bin/env node
/**
 * release.mjs — InFlow 一键发版脚本（Node ≥ 18，零第三方依赖）
 *
 * 一键完成：版本升级 → 变更内容收集 → 构建 main.js → 提交/tag → push → GitHub Release。
 * 同时兼容「首次发布」：无 v<当前版本> tag 时默认发布当前版本（如 1.0.0）。
 *
 * 用法：
 *   node release.mjs                     # 智能默认：无 tag 发当前版本，否则 patch 升级
 *   node release.mjs --bump minor        # 显式 major|minor|patch 升级
 *   node release.mjs --to 1.1.0          # 显式指定目标版本
 *   node release.mjs --notes "说明文本"    # 指定本次发布说明（跳过变更内容自动收集）
 *   node release.mjs --dry-run           # 演练：只打印将执行的改动，不落盘/不推送
 *   node release.mjs --skip-build        # 跳过 npm run build（不建议）
 *   node release.mjs --create-remote     # 远端 origin 不存在时用 gh 创建并绑定
 *
 * 变更内容收集优先级：
 *   1) --notes 显式提供
 *   2) CHANGELOG.md 的 ## [Unreleased] 有内容 → 提升为本次条目
 *   3) CHANGELOG.md 已有 ## [x.y.z] 条目（首发的历史条目）→ 直接采用
 *   4) 自上个 tag 起的 git log（按 Conventional Commit 分组）→ 生成条目
 *   以上皆无 → 中止并提示
 *
 * 前置条件：
 *   - git 仓库已 init、工作区干净（有未提交改动会中止）
 *   - 推远端 / 发版需已登录 GitHub CLI：gh auth login
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SEMVER = /^\d+\.\d+\.\d+$/;
const log = (m = '') => console.log(m);
const step = (m) => log(`\n▶ ${m}`);
const ok = (m) => log(`  ✔ ${m}`);
const warn = (m) => log(`  ⚠ ${m}`);

/* ---------------- 基础工具 ---------------- */

function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: opts.shell === true,
    ...opts,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
const git = (args, opts = {}) => run('git', args, opts);
const gh = (args, opts = {}) => run('gh', args, opts);
const must = (r, msg) => { if (r.status !== 0) throw new Error(`${msg}\n${r.stderr || r.stdout}`); return r; };

function readJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
}
function writeJson(file, obj) {
  writeFileSync(join(ROOT, file), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function assertSemver(v, label) {
  if (!SEMVER.test(v)) throw new Error(`${label}「${v}」不是合法的 x.y.z 版本号`);
  return v;
}
function bumpVersion(v, kind) {
  const [maj, min, pat] = v.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`--bump 只支持 major | minor | patch，收到「${kind}」`);
}

/* ---------------- 参数解析 ---------------- */

function parseArgs(argv) {
  const a = { bump: null, to: null, notes: null, dryRun: false, skipBuild: false, createRemote: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = (d) => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${x} 缺少值`); i++; return v; };
    if (x === '--to') a.to = val();
    else if (x === '--bump') a.bump = val();
    else if (x === '--notes') a.notes = val();
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--skip-build') a.skipBuild = true;
    else if (x === '--create-remote') a.createRemote = true;
    else if (x === '--force' || x === '-f') a.force = true;
    else if (x === '-h' || x === '--help') a.help = true;
    else if (x.startsWith('-')) throw new Error(`未知参数 ${x}（--help 查看用法）`);
    else throw new Error(`多余位置参数 ${x}（--help 查看用法）`);
  }
  if (a.bump && a.to) throw new Error('--bump 与 --to 互斥，只能给一个');
  return a;
}

const HELP = `InFlow 一键发版脚本

用法:
  node release.mjs [--to x.y.z | --bump major|minor|patch] [--notes "文本"] [--dry-run] [--skip-build] [--create-remote] [--force]

规则:
  不带 --to/--bump 时：当前版本无 v<版本> tag → 发布当前版本（首次发布）；已有 → patch 升级。
变更内容收集: --notes > CHANGELOG Unreleased 提升 > CHANGELOG 同版本条目 > git log 分组。
远端动作需 gh 登录: gh auth login（仅 push/发版需要，--dry-run 不需要）。`;

/* ---------------- CHANGELOG 处理 ---------------- */

/** 解析 CHANGELOG：prefix 为第一个 ## 前的头部，entries 为 { headingRaw, body } */
function parseChangelog(text) {
  const lines = text.split('\n');
  const headIdx = [];
  lines.forEach((l, i) => { if (/^## /.test(l)) headIdx.push(i); });
  const prefix = headIdx.length ? lines.slice(0, headIdx[0]).join('\n').trim() : text.trim();
  const entries = headIdx.map((s, k) => ({
    headingRaw: lines[s].slice(3).trim(),
    body: lines.slice(s + 1, k + 1 < headIdx.length ? headIdx[k + 1] : lines.length).join('\n').trim(),
  }));
  return { prefix, entries };
}
function serializeChangelog(prefix, entries) {
  const head = prefix ? prefix + '\n\n' : '';
  const body = entries
    .map((e) => `## ${e.headingRaw}` + (e.body ? '\n\n' + e.body : ''))
    .join('\n\n');
  return head + body.trimEnd() + '\n';
}
const entryVer = (headingRaw) => {
  const m = headingRaw.match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
};

/** 依据优先级收集发布说明；可能改写 CHANGELOG.md。返回 { notes, changelogChanged } */
function collectNotes(next, changelogFile, argv) {
  if (argv.notes) return { notes: argv.notes.trim(), changelogChanged: false };

  if (!existsSync(changelogFile)) throw new Error(`找不到 ${changelogFile}，请用 --notes 提供发布说明`);
  const { prefix, entries } = parseChangelog(readFileSync(changelogFile, 'utf8'));

  // 2) Unreleased 有内容 → 提升
  const uIdx = entries.findIndex((e) => /^\[Unreleased\]/i.test(e.headingRaw));
  if (uIdx >= 0 && entries[uIdx].body) {
    const notes = entries[uIdx].body;
    const nextEntries = [
      { headingRaw: '[Unreleased]', body: '' },
      { headingRaw: `[${next}] - ${today()}`, body: notes },
      ...entries.filter((_, i) => i !== uIdx),
    ];
    writeFileSync(changelogFile, serializeChangelog(prefix, nextEntries), 'utf8');
    ok(`CHANGELOG：已将 [Unreleased] 提升为 [${next}] - ${today()}`);
    return { notes, changelogChanged: true };
  }

  // 3) 已存在同版本历史条目（首次发布直接采用）
  const sameIdx = entries.findIndex((e) => entryVer(e.headingRaw) === next);
  if (sameIdx >= 0 && entries[sameIdx].body) {
    ok(`CHANGELOG：采用既有 [${next}] 条目作为发布说明`);
    return { notes: entries[sameIdx].body, changelogChanged: false };
  }

  // 4) 自上个 tag 起 git log 分组
  const desc = git(['describe', '--tags', '--abbrev=0']);
  if (desc.status === 0 && desc.stdout) {
    const last = desc.stdout.split('\n')[0];
    const lines = git(['log', '--oneline', '--no-merges', `${last}..HEAD`]).stdout.split('\n').filter(Boolean);
    if (lines.length) {
      const groups = { feat: [], fix: [], chore: [], docs: [], refactor: [], perf: [], other: [] };
      for (const l of lines) {
        const m = l.match(/^[a-f0-9]+\s+(feat|fix|chore|docs|refactor|perf)(?:\([^)]*\))?[!:]?\s+(.*)/i);
        const k = m ? m[1].toLowerCase() : 'other';
        const text = m ? m[2] : l.replace(/^[a-f0-9]+\s+/, '');
        (groups[k] || groups.other).push(text.replace(/[.!。]$/, ''));
      }
      const label = { feat: '### 新增', fix: '### 修复', chore: '### 其他', docs: '### 文档', refactor: '### 重构', perf: '### 性能' };
      const parts = [];
      for (const k of ['feat', 'fix', 'perf', 'refactor', 'docs', 'chore', 'other']) {
        if (groups[k].length) parts.push(`${label[k] || '### 其他'}\n\n${groups[k].map((t) => `- ${t}`).join('\n')}`);
      }
      const notes = parts.join('\n\n');
      const nextEntries = [
        { headingRaw: '[Unreleased]', body: '' },
        { headingRaw: `[${next}] - ${today()}`, body: notes },
        ...entries.filter((_, i) => i !== uIdx),
      ];
      writeFileSync(changelogFile, serializeChangelog(prefix, nextEntries), 'utf8');
      ok(`CHANGELOG：由 git log（${last}..HEAD）生成 [${next}] 条目`);
      return { notes, changelogChanged: true };
    }
  }

  throw new Error(
    `无法自动生成发布说明：请在 CHANGELOG.md 的 [Unreleased] 下写本次改动，或传 --notes "说明"`
  );
}

/* ---------------- 主流程 ---------------- */

function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help) { log(HELP); return; }
  const dry = argv.dryRun;

  // 0. 仓库前置
  step('前置检查');
  must(git(['rev-parse', '--is-inside-work-tree']), '当前目录不是 git 仓库：请先 git init');
  const dirty = git(['status', '--porcelain']).stdout;
  if (dirty) throw new Error('工作区有未提交改动，发版前请先提交你的日常修改（避免把杂项卷进发版 commit）');
  const branch = git(['branch', '--show-current']).stdout || 'HEAD';
  ok(`git 仓库 OK（分支 ${branch}）`);

  const manifest = readJson('manifest.json');
  const cur = assertSemver(manifest.version, 'manifest.json version');
  const tags = git(['tag', '--list']).stdout.split('\n').filter(Boolean);

  // 1. 目标版本
  step('确定版本');
  let next;
  if (argv.to) next = assertSemver(argv.to, '--to');
  else if (argv.bump) next = bumpVersion(cur, argv.bump);
  else next = tags.includes(`v${cur}`) ? bumpVersion(cur, 'patch') : cur; // 首次发布当前版本
  if (!SEMVER.test(next)) throw new Error(`非法目标版本 ${next}`);
  if (tags.includes(`v${next}`)) throw new Error(`tag v${next} 已存在：如需再发请升级版本`);
  ok(`当前 ${cur} → 目标 ${next}${next === cur ? '（首次发布当前版本）' : ''}`);

  // 2. 发布说明
  step('收集发布说明');
  const { notes, changelogChanged } = collectNotes(next, 'CHANGELOG.md', argv);
  const notePreview = notes.split('\n').slice(0, 8).map((l) => `  | ${l}`).join('\n');
  log(notePreview.length ? `发布说明（预览前 8 行）:\n${notePreview}` : `发布说明: ${notes}`);
  if (!dry && changelogChanged) ok('CHANGELOG.md 已更新');

  // 3. 更新版本字段
  step('同步版本字段');
  const manifest2 = { ...manifest, version: next };
  writeJson('manifest.json', manifest2);
  ok('manifest.json → ' + next);
  if (existsSync('package.json')) {
    const pj = JSON.parse(readFileSync('package.json', 'utf8'));
    if (pj.version) { pj.version = next; writeJson('package.json', pj); ok('package.json → ' + next); }
  }
  if (existsSync('versions.json')) {
    const vj = JSON.parse(readFileSync('versions.json', 'utf8'));
    const updated = { [next]: manifest2.minAppVersion };
    for (const k of Object.keys(vj)) if (k !== next) updated[k] = vj[k];
    const changed = JSON.stringify(updated) !== JSON.stringify(vj);
    writeJson('versions.json', updated);
    if (changed) ok(`versions.json 新增 ${next} → ${manifest2.minAppVersion}`);
    else ok('versions.json 无变化');
  }

  if (dry) {
    log('\n[--dry-run] 演练结束：以上为将执行的改动，未写入未推送。');
    return;
  }

  // 4. 构建
  if (!argv.skipBuild) {
    step('构建 main.js（npm run build）');
    const r = run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
    must(r, '构建失败');
    ok('构建完成');
  }

  // 5. 提交 + tag
  step('提交与打 tag');
  const files = ['manifest.json', 'package.json', 'versions.json', 'CHANGELOG.md', 'main.js', 'styles.css'].filter((f) => existsSync(f));
  git(['add', ...files]);
  if (git(['status', '--porcelain']).stdout) {
    must(git(['commit', '-m', `Release v${next}`]), 'commit 失败');
    ok(`已提交: Release v${next}`);
  } else {
    warn('无文件变更，跳过空提交');
  }
  must(git(['tag', `v${next}`]), '创建 tag 失败');
  ok(`已打 tag: v${next}`);

  // 6. 远端
  step('推送远端');
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote.status !== 0) {
    const repo = detectRepoId();
    const authed = gh(['auth', 'status']).status === 0;
    if (!argv.createRemote || !authed) {
      log(`\n⚠ 本地未配置 origin 远端，且未满足自动创建条件。请手动执行其一：`);
      log(`  git remote add origin https://github.com/${repo}.git`);
      log(`  git push -u origin ${branch}`);
      log(`  git push origin v${next}`);
      log(`  gh release create v${next} manifest.json main.js styles.css --title "v${next}" --notes "见 CHANGELOG.md"`);
      return;
    }
    const exist = gh(['repo', 'view', repo, '--json', 'name']);
    if (exist.status === 0) {
      git(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
      ok(`远端已存在 ${repo}，origin 已绑定`);
    } else {
      must(gh(['repo', 'create', repo, '--public', '--source', '.', '--remote', 'origin']), 'gh repo create 失败');
      ok(`已创建远端仓库 ${repo} 并绑定 origin`);
    }
  } else {
    ok(`origin → ${remote.stdout}`);
  }
  const forceArgs = argv.force ? ['--force'] : [];
  must(git(['push', '-u', ...forceArgs, 'origin', branch]), 'push 分支失败');
  must(git(['push', ...forceArgs, 'origin', `v${next}`]), 'push tag 失败');
  ok('分支与 tag 已推送');

  // 7. GitHub Release
  step('创建 GitHub Release');
  const authed = gh(['auth', 'status']).status === 0;
  if (!authed) {
    log(`\n⚠ gh 未登录，Release 未创建。登录后执行：`);
    log(`  gh auth login`);
    log(`  gh release create v${next} manifest.json main.js styles.css --title "v${next}" --notes "见 CHANGELOG.md"`);
    return;
  }
  const notesFile = join(tmpdir(), `inflow-release-${next}.md`);
  writeFileSync(notesFile, notes + '\n', 'utf8');
  try {
    const assets = ['manifest.json', 'main.js', 'styles.css'].filter((f) => existsSync(f));
    must(gh(['release', 'create', `v${next}`, ...assets, '--title', `v${next}`, '--notes-file', notesFile]), 'gh release create 失败');
    ok(`Release v${next} 已发布`);
  } finally {
    rmSync(notesFile, { force: true });
  }

  log(`\n🎉 v${next} 发布完成！`);
  log(`后续（社区商店上架，按需执行）：在 https://github.com/obsidianmd/obsidian-releases 提交 PR，`);
  log(`在 community-plugins.json 注册（若已注册则仅需提交版本更新 PR），并确认 Release tag 与 manifest.json 版本一致。`);
}

/** 从 package.json / manifest.json 推导 owner/repo */
function detectRepoId() {
  for (const file of ['package.json', 'manifest.json']) {
    try {
      const j = readJson(file);
      const u = j.repository?.url || j.authorUrl || '';
      const m = u.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (m) return `${m[1]}/${m[2]}`;
    } catch { /* 忽略 */ }
  }
  return 'MarcBolo/Inflow';
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`\n✖ 发版中止: ${e.message}`);
  process.exit(1);
}
