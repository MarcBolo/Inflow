/**
 * 场景编号生成器 - 负责场景自动编号、集数识别与重编号
 */
import type { EditorLike, EpisodeRange, RenumberResult } from './types';

/** 集数标题匹配（支持 中文数字 与 阿拉伯数字） */
const EPISODE_TITLE_RE = /^#+\s*第\s*([零一二三四五六七八九十百千万\d]+|[0-9]+)\s*集/;

const CHINESE_NUMBERS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  百: 100,
  千: 1000,
  万: 10000,
};

/** 场景标题匹配：## 1.1 场景描述 */
const SCENE_LINE_RE = /^(##\s*)(\d+\.\d+)(\s*[^\s].*)$/;

export class SceneNumberGenerator {
  /** 获取下一个场景编号（形如 1.1 / 1.2） */
  getNextSceneNumber(editor: EditorLike, cursor: { line: number; ch: number }): string {
    const episode = this.detectCurrentEpisode(editor, cursor);
    const maxSceneNumber = this.getMaxSceneNumberInEpisode(editor, episode);
    return `${episode}.${maxSceneNumber + 1}`;
  }

  /** 从光标位置向上回溯，识别当前所属集数 */
  detectCurrentEpisode(editor: EditorLike, cursor: { line: number; ch: number }): number {
    let currentLine = cursor.line;

    while (currentLine >= 0) {
      const lineContent = editor.getLine(currentLine).trim();
      const episodeMatch = lineContent.match(EPISODE_TITLE_RE);
      if (episodeMatch) {
        return this.chineseToNumber(episodeMatch[1]);
      }
      currentLine--;
    }

    return 1;
  }

  /** 中文数字转阿拉伯数字（含混合型如"一百二十三"） */
  chineseToNumber(chinese: string): number {
    if (/^\d+$/.test(chinese)) return parseInt(chinese, 10);

    let total = 0;
    let temp = 0;

    for (let i = 0; i < chinese.length; i++) {
      const char = chinese[i];
      const value = CHINESE_NUMBERS[char];

      if (value === undefined) {
        const num = parseInt(chinese, 10);
        return isNaN(num) ? 1 : num;
      }

      if (value < 10) {
        temp = value;
      } else if (value === 10) {
        total += (temp === 0 ? 1 : temp) * value;
        temp = 0;
      } else {
        // 百 / 千 / 万
        total += (temp === 0 ? 1 : temp) * value;
        temp = 0;
      }
    }

    total += temp;
    return total === 0 ? 1 : total;
  }

  /** 获取当前集内已存在的最大场景号 */
  getMaxSceneNumberInEpisode(editor: EditorLike, episode: number): number {
    let maxSceneNumber = 0;
    const lineCount = editor.lineCount();

    const range = this.findEpisodeRange(editor, episode);
    if (!range) return 0;

    for (let i = range.start; i <= range.end; i++) {
      const lineContent = editor.getLine(i);
      const sceneMatch = lineContent.match(/^##\s*(\d+)\.(\d+)\s*[^\s]/);
      if (sceneMatch) {
        const sceneEp = parseInt(sceneMatch[1], 10);
        const sceneNum = parseInt(sceneMatch[2], 10);
        if (sceneEp === episode && sceneNum > maxSceneNumber) {
          maxSceneNumber = sceneNum;
        }
      }
    }

    return maxSceneNumber;
  }

  /** 重编号当前光标所在集 */
  renumberCurrentEpisode(editor: EditorLike): RenumberResult {
    const cursor = editor.getCursor();
    const episode = this.detectCurrentEpisode(editor, cursor);
    const episodeRange = this.findEpisodeRange(editor, episode);

    if (!episodeRange) return { success: false, renumberedScenes: 0 };

    return this.renumberScenesInRange(editor, episode, episodeRange.start, episodeRange.end);
  }

  /** 重编号全部集的全部场景 */
  renumberAllEpisodes(editor: EditorLike): RenumberResult {
    const episodes = this.findAllEpisodes(editor);

    let totalRenumbered = 0;
    let episodesRenumbered = 0;

    for (const episodeInfo of episodes) {
      const result = this.renumberScenesInRange(
        editor,
        episodeInfo.episode,
        episodeInfo.startLine,
        episodeInfo.endLine
      );
      if (result.success) {
        totalRenumbered += result.renumberedScenes;
        episodesRenumbered++;
      }
    }

    return {
      success: totalRenumbered > 0,
      renumberedScenes: totalRenumbered,
      totalRenumbered,
      episodesRenumbered,
    };
  }

  /**
   * 单次遍历求所有集的标题行与行区间（O(n)）。
   * 旧实现为每集各做一次全文档扫描，重编号全部集时为 O(n·E)。
   */
  private findEpisodeBoundaries(editor: EditorLike): Array<{
    episode: number;
    titleLine: number;
    startLine: number;
    endLine: number;
  }> {
    const lineCount = editor.lineCount();
    const titles: Array<{ episode: number; line: number }> = [];
    for (let i = 0; i < lineCount; i++) {
      const m = editor.getLine(i).trim().match(EPISODE_TITLE_RE);
      if (m) titles.push({ episode: this.chineseToNumber(m[1]), line: i });
    }
    return titles.map((t, idx) => {
      const endLine = idx + 1 < titles.length ? titles[idx + 1].line - 1 : lineCount - 1;
      return { episode: t.episode, titleLine: t.line, startLine: t.line, endLine };
    });
  }

  /** 查找指定集数在文档中的行区间 */
  findEpisodeRange(editor: EditorLike, episode: number): EpisodeRange | null {
    const b = this.findEpisodeBoundaries(editor).find((x) => x.episode === episode);
    return b ? { start: b.startLine, end: b.endLine } : null;
  }

  /** 在指定行区间内按顺序重编号场景 */
  renumberScenesInRange(editor: EditorLike, episode: number, startLine: number, endLine: number): RenumberResult {
    let sceneCounter = 1;
    let renumberedScenes = 0;

    for (let i = startLine; i <= endLine; i++) {
      const lineContent = editor.getLine(i);
      const sceneMatch = lineContent.match(SCENE_LINE_RE);
      if (sceneMatch) {
        const prefix = sceneMatch[1];
        const oldNumber = sceneMatch[2];
        const suffix = sceneMatch[3];

        const newNumber = `${episode}.${sceneCounter}`;

        if (oldNumber !== newNumber && editor.setLine) {
          editor.setLine(i, `${prefix}${newNumber}${suffix}`);
          renumberedScenes++;
        }

        sceneCounter++;
      }
    }

    return {
      success: renumberedScenes > 0,
      renumberedScenes,
    };
  }

  /** 列出文档中所有集及其区间（基于单次遍历结果，O(n)） */
  findAllEpisodes(editor: EditorLike): Array<{ episode: number; startLine: number; endLine: number }> {
    return this.findEpisodeBoundaries(editor).map((b) => ({
      episode: b.episode,
      startLine: b.startLine,
      endLine: b.endLine,
    }));
  }
}
