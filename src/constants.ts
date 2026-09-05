/**
 * InFlow 常量定义
 */
import type { BLFormatCompleterSettings } from './types';

/**
 * 章节标题 → 规范类别键的别名表（中英归一化）。
 * 词库章节标题可能是中文（角色/场景/功法…）也可能是英文（characters/scenes…），
 * 必须统一映射到 CATEGORY_TYPE_MAP 的规范键，否则 buildSmartCompletionIndex 里
 * `CATEGORY_TYPE_MAP[category]` 取不到值、类别键变成原始中文 → 上下文过滤/组合项/自动识别全部失效。
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  // 基础类别
  '角色': 'characters',
  '人物': 'characters',
  '场景': 'scenes',
  '地点': 'scenes',
  '时间段': 'times',
  '时间': 'times',
  '动作': 'actions',
  '行为': 'actions',
  '台词': 'dialogues',
  '对白': 'dialogues',
  // 修仙玄幻
  '功法': 'skills',
  '法术': 'skills',
  '法宝': 'artifacts',
  '法器': 'artifacts',
  '招式': 'techniques',
  '技能': 'techniques',
  '门派': 'organizations',
  '组织': 'organizations',
  '势力': 'organizations',
  '秘境': 'locations',
  '洞府': 'locations',
  '特殊地点': 'locations',
  // 影视制作：镜头语言（剧本 / 分镜场景高频，单独成类以便参与上下文过滤）
  '景别': 'shot',
  '景深': 'shot',
  '拍摄方式': 'camera',
  '运镜': 'camera',
  '镜头运动': 'camera',
  '摄影机运动': 'camera',
  '拍摄角度': 'angle',
  '机位角度': 'angle',
  '角度': 'angle',
  '剪辑技巧': 'editing',
  '剪辑': 'editing',
  '转场技巧': 'editing',
  '光学与镜头质感': 'optics',
  '镜头质感': 'optics',
  '光学': 'optics',
  '光线与氛围': 'lighting',
  '光线': 'lighting',
  '布光': 'lighting',
  '光影': 'lighting',
  '色彩与影调': 'color',
  '影调': 'color',
  '色调': 'color',
  '构图方式': 'composition',
  '构图': 'composition',
  '风格参考': 'style',
  '美学风格': 'style',
  '导演风格': 'style',
  // 其他
  '常用词': 'commonWords',
  '常用修饰词': 'commonWords',
  '修饰词': 'commonWords',
  '高频词': 'commonWords',
  '事件': 'events',
  '情节': 'events',
  '情感': 'emotions',
  '情绪': 'emotions',
  '音效': 'sounds',
  '声音': 'sounds',
  '转场': 'transitions',
  '转场效果': 'transitions',
  // 英语（覆盖用户实际写法：「常用单词 / 基础单词 / 日常短语」等，
  // 归为 english* 类别后，与中文共用统一的 smartMinLength 触发阈值）
  '英语单词': 'englishWords',
  '英文单词': 'englishWords',
  '常用单词': 'englishWords',
  '基础单词': 'englishWords',
  '单词': 'englishWords',
  '英语词组': 'englishPhrases',
  '英文词组': 'englishPhrases',
  '常用词组': 'englishPhrases',
  '常用短语': 'englishPhrases',
  '日常短语': 'englishPhrases',
  '短语': 'englishPhrases',
  '英语习语': 'englishIdioms',
  '英文习语': 'englishIdioms',
  // 英文原名（保持兼容；多词标题会被 detectCategory 转成下划线形式）
  'characters': 'characters',
  'scenes': 'scenes',
  'times': 'times',
  'actions': 'actions',
  'dialogues': 'dialogues',
  'skills': 'skills',
  'artifacts': 'artifacts',
  'techniques': 'techniques',
  'commonwords': 'commonWords',
  'common_words': 'commonWords',
  'organizations': 'organizations',
  'locations': 'locations',
  'events': 'events',
  'emotions': 'emotions',
  'sounds': 'sounds',
  'transitions': 'transitions',
  'englishwords': 'englishWords',
  'english_words': 'englishWords',
  'englishphrases': 'englishPhrases',
  'english_phrases': 'englishPhrases',
  'englishidioms': 'englishIdioms',
  'english_idioms': 'englishIdioms',
  // 影视制作英文原名（detectCategory 会保留括号内容，如「拍摄方式 (Camera Movement)」→
  // "拍摄方式_(camera_movement)"，括号内英文是第二条匹配线索）
  'shot': 'shot',
  'shots': 'shot',
  'shot_size': 'shot',
  'camera': 'camera',
  'camera_movement': 'camera',
  'angle': 'angle',
  'camera_angle': 'angle',
  'editing': 'editing',
  'editing_techniques': 'editing',
  'optics': 'optics',
  'optics_&_lens_look': 'optics',
  'lens': 'optics',
  'lighting': 'lighting',
  'lighting_&_atmosphere': 'lighting',
  'color': 'color',
  'color_&_tone': 'color',
  'composition': 'composition',
  'style': 'style',
  'style_references': 'style',
  'common_modifiers': 'commonWords',
};

/** 上下文类型与词库类别的映射 */
/** 镜头语言类：场景标题行与动作行都会用到，集中定义避免三处上下文各写一遍 */
const CAMERA_LANGUAGE_CATS = [
  'shot',
  'camera',
  'angle',
  'editing',
  'optics',
  'lighting',
  'color',
  'composition',
  'style',
];

export const CONTEXT_CATEGORY_MAP: Record<string, string[]> = {
  // scene_time 旧映射已删除：detectLineContext 从不产出 'scene_time'，属于死映射
  scene_location: ['scene', 'scene_time_combo', 'location', ...CAMERA_LANGUAGE_CATS],
  character_name: ['character'],
  action: ['action', 'technique', 'skill', ...CAMERA_LANGUAGE_CATS],
  // general 不再用 'all' 全放行（否则正文行下上下文感知形同虚设）；
  // 改为宽泛但仍有边界的内容类别，组合类(scene_time_combo/dialogue_combo)与专用类(skill/technique/artifact)不在此列。
  general: [
    'character',
    'scene',
    'time',
    'action',
    'dialogue',
    'commonWords',
    'organization',
    'location',
    'event',
    'emotion',
    'sound',
    'transition',
    'englishWord',
    'englishPhrase',
    'englishIdiom',
    ...CAMERA_LANGUAGE_CATS,
  ],
};

/** 词库类别标识（文件名用）→ 条目类型 */
export const CATEGORY_TYPE_MAP: Record<string, string> = {
  characters: 'character',
  scenes: 'scene',
  times: 'time',
  actions: 'action',
  dialogues: 'dialogue',
  skills: 'skill',
  artifacts: 'artifact',
  techniques: 'technique',
  commonWords: 'commonWords',
  organizations: 'organization',
  locations: 'location',
  events: 'event',
  emotions: 'emotion',
  sounds: 'sound',
  transitions: 'transition',
  englishWords: 'englishWord',
  englishPhrases: 'englishPhrase',
  englishIdioms: 'englishIdiom',
  // 影视制作
  shot: 'shot',
  camera: 'camera',
  angle: 'angle',
  editing: 'editing',
  optics: 'optics',
  lighting: 'lighting',
  color: 'color',
  composition: 'composition',
  style: 'style',
};

/** 类别显示名称映射 */
export const CATEGORY_DISPLAY_MAP: Record<string, string> = {
  characters: '角色',
  scenes: '场景',
  times: '时间段',
  actions: '动作',
  dialogues: '台词',
  skills: '功法',
  artifacts: '法宝',
  techniques: '招式',
  commonWords: '常用词',
  organizations: '组织',
  locations: '特殊地点',
  events: '事件',
  emotions: '情感',
  sounds: '音效',
  transitions: '转场',
  englishWords: '英语单词',
  englishPhrases: '英语词组',
  englishIdioms: '英语习语',
  character: '角色',
  scene: '场景',
  time: '时间段',
  action: '动作',
  dialogue: '台词',
  skill: '功法',
  artifact: '法宝',
  technique: '招式',
  organization: '组织',
  location: '特殊地点',
  event: '事件',
  emotion: '情感',
  sound: '音效',
  transition: '转场',
  englishWord: '英语单词',
  englishPhrase: '英语词组',
  englishIdiom: '英语习语',
  scene_time_combo: '场景+时间',
  dialogue_combo: '角色对话',
  shot: '景别',
  camera: '拍摄方式',
  angle: '拍摄角度',
  editing: '剪辑技巧',
  optics: '镜头质感',
  lighting: '光线氛围',
  color: '色彩影调',
  composition: '构图',
  style: '风格',
};

/** 类型排序顺序 */
export const TYPE_ORDER: Record<string, number> = {
  character: 1,
  scene: 2,
  time: 3,
  action: 4,
  dialogue: 5,
  skill: 6,
  artifact: 7,
  technique: 8,
  scene_time_combo: 9,
  dialogue_combo: 10,
  commonWords: 11,
  englishWord: 12,
  englishPhrase: 13,
  englishIdiom: 14,
  organization: 15,
  location: 16,
  event: 17,
  emotion: 18,
  sound: 19,
  transition: 20,
  // 影视制作类：排在内容类之后、兜底类之前
  shot: 21,
  camera: 22,
  angle: 23,
  composition: 24,
  lighting: 25,
  color: 26,
  optics: 27,
  editing: 28,
  style: 29,
};

/** 默认设置 */
export const DEFAULT_SETTINGS: BLFormatCompleterSettings = {
  enabled: true,
  autoDialogue: true,
  enableSmartCompletion: true,
  enableContextAware: true,
  enableMinimalTrigger: true,
  enablePinyin: true,
  smartMinLength: 1,
  smartMaxSuggestions: 10,
  defaultSceneType: 'int',
  enableQuickPanel: true,
  enableAutoRefresh: true,
  showAutoRefreshNotice: false,
  floatingButtonPosition: { x: 20, y: 60 },
  libraryColors: {},
  libraryIcons: {},
  libraryFolder: '',
  usageStats: {},
  enableCombos: true,
  comboMaxItems: 60,
};

/**
 * 词库彩条默认调色板（顺序即分配顺序）。
 * 词库未显式设置颜色时，按可用词库列表顺序循环取色。
 * 橙 → 蓝 → 绿 → 粉 → 紫 → 青。
 */
export const DEFAULT_LIBRARY_PALETTE: readonly string[] = [
  '#f59e0b',
  '#3b82f6',
  '#10b981',
  '#ec4899',
  '#8b5cf6',
  '#06b6d4',
];

export const WORD_BOUNDARY_RE =
  /[\s.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u2026\u2014\u00b7\uff08\uff09()\[\]{}\u3010\u3011\u300c\u300d\u300e\u300f\u201c\u201d\u2018\u2019\u300a\u300b]/;

/**
 * 智能补全查询词的最大长度。
 * 光标前的「当前词」超过此长度时，从右向左逐字回退试探，
 * 取第一个能命中候选的长度。既支持「我说主角」→ 命中「主角」，
 * 又避免把整句话当作查询词反复过滤。
 */
export const MAX_COMPLETION_QUERY_LEN = 6;

/** 系统预定义类别集合：不在此集合中的类别视为用户自定义类别 */
export const SYSTEM_CATEGORY_SET: Set<string> = new Set([
  'character',
  'scene',
  'time',
  'action',
  'dialogue',
  'skill',
  'artifact',
  'technique',
  'commonWords',
  'organization',
  'location',
  'event',
  'emotion',
  'sound',
  'transition',
  'englishWord',
  'englishPhrase',
  'englishIdiom',
  'scene_time_combo',
  'dialogue_combo',
  // 影视制作
  'shot',
  'camera',
  'angle',
  'editing',
  'optics',
  'lighting',
  'color',
  'composition',
  'style',
]);

/**
 * 拼音首字母判定的「代表字」表：按拼音排序后每个首字母的第一个常用字。
 * 配合 Intl.Collator 的中文拼音排序做二分定位，无需内置整张汉字拼音对照表。
 * 缺 i / u / v —— 普通话中没有以这三个字母开头的音节。
 */
export const PINYIN_BRANCH: ReadonlyArray<readonly [string, string]> = [
  ['a', '啊'],
  ['b', '八'],
  ['c', '擦'],
  ['d', '搭'],
  ['e', '蛾'],
  ['f', '发'],
  ['g', '噶'],
  ['h', '哈'],
  ['j', '击'],
  ['k', '喀'],
  ['l', '垃'],
  ['m', '妈'],
  ['n', '拿'],
  ['o', '哦'],
  ['p', '啪'],
  ['q', '期'],
  ['r', '然'],
  ['s', '撒'],
  ['t', '塌'],
  ['w', '挖'],
  ['x', '昔'],
  ['y', '压'],
  ['z', '匝'],
];
