/* ────────────────────────────────────────────────────────────
 *  go/features.ts — KataGo v7 输入编码（22 个空间平面 + 19 个全局通道）
 *
 *  平面布局（与 KataGo cpp/neuralnet/nninputs.cpp fillRowV7 对齐）：
 *    0      在盘内（本实现按棋盘原尺寸推理，故恒为 1）
 *    1 / 2  轮走方 / 对方棋子
 *    3/4/5  气数恰为 1 / 2 / 3 的棋子
 *    6      劫禁着点
 *    7/8    保留（原版为「上一手后的气」等，本实现留 0）
 *    9..13  最近五手（9 = 对方上一手，10 = 我方上一手，交替）
 *    14     被征吃的棋子（当前局面）
 *    15     被征吃的棋子（上一手局面）
 *    16     被征吃的棋子（上上 hand 局面）
 *    17     可逃出征子的走点
 *    18/19  区域归属（pass-alive）本方 / 对方
 *    20/21  保留
 *  全局通道：0..4 最近五手是否为虚手；5 贴目/20；6/7 劫规则；
 *    8 允许自填眼；9 数目法；10/11 还棋头；14 上一手虚手；
 *    15/16 让子补偿；17 按钮；18 贴目奇偶波。
 *
 *  棋盘按原尺寸推理（9 路就送 9×9 张量），这也是参考实现的作法：
 *  卷积网络对分辨率不敏感，而计算量随边长平方下降，9 路只剩 19 路的
 *  约 22%。gpool/价值头的棋盘尺寸缩放因子改用真实边长。
 * ──────────────────────────────────────────────────────────── */

import { WHITE, floodGroup, geometryFor, type GoColor } from './rules';
import { computeAreaMap } from './area';
import { computeLadderFeatures } from './life';

/** 空间平面数（KataGo v7） */
export const NUM_SPATIAL_PLANES = 22;
/** 全局通道数 */
export const NUM_GLOBAL_PLANES = 19;

/** KataGo NNPos::KOMI_CLIP_RADIUS */
const KOMI_CLIP_RADIUS = 20;

/** 规则集对特征的影响（本平台固定使用中国规则：数子 + 简单劫 + 禁止自填） */
export interface FeatureRules {
  /** 数子（area）还是数目（territory） */
  scoring: 'area' | 'territory';
  /** 劫规则：simple / positional / situational */
  ko: 'simple' | 'positional' | 'situational';
  /** 还棋头：none / seki / all */
  tax: 'none' | 'seki' | 'all';
  /** 是否允许多子自杀 */
  multiStoneSuicideLegal: boolean;
}

export const CHINESE_FEATURE_RULES: FeatureRules = {
  scoring: 'area',
  ko: 'simple',
  tax: 'none',
  multiStoneSuicideLegal: false,
};

/** 最近一手（按时间顺序，最后一项是最近一手；move = -1 表示虚手） */
export interface FeatureMove {
  move: number;
  color: GoColor;
}

export interface FeatureScratch {
  size: number;
  libertyMap: Uint8Array;
  areaMap: Uint8Array;
  laddered: Uint8Array;
  workingMoves: Uint8Array;
}

export function createFeatureScratch(size: number): FeatureScratch {
  const area = size * size;
  return {
    size,
    libertyMap: new Uint8Array(area),
    areaMap: new Uint8Array(area),
    laddered: new Uint8Array(area),
    workingMoves: new Uint8Array(area),
  };
}

export interface FeatureInput {
  size: number;
  /** 棋子：0 空 1 黑 2 白 */
  stones: Uint8Array;
  /** 劫禁着点，-1 表示无 */
  koPoint: number;
  /** 轮走方 */
  toMove: GoColor;
  /** 最近若干手（时间顺序） */
  recentMoves: readonly FeatureMove[];
  /** 贴目（白方补偿） */
  komi: number;
  rules?: FeatureRules;
  /** 上一手局面的征子掩码（平面 15） */
  prevLaddered?: Uint8Array | null;
  /** 上上手局面的征子掩码（平面 16） */
  prevPrevLaddered?: Uint8Array | null;
  /** 最近五手中最多编码几手（KataGo maxHistory，默认 5） */
  maxHistory?: number;
  /** 末局提示：虚手会终局时是否对网络隐藏（KataGo enablePassingHacks） */
  enablePassingHacks?: boolean;
  /** 输出：长度 size*size*22（NHWC） */
  outSpatial: Float32Array;
  /** 输出：长度 19 */
  outGlobal: Float32Array;
  /**
   * 可选输出：本局面的「被征吃棋子」掩码（长度 area）。
   * 搜索把它存在节点上，供子节点填平面 15（上一手局面的征子）。
   */
  ladderedOut?: Uint8Array | null;
  scratch?: FeatureScratch;
}

/**
 * 填充 KataGo v7 输入平面。outSpatial / outGlobal 由调用方复用，
 * 避免每次评估都分配几十 KB。
 */
export function fillFeatures(args: FeatureInput): void {
  const { size, stones, koPoint, toMove, recentMoves, komi } = args;
  const rules = args.rules ?? CHINESE_FEATURE_RULES;
  const area = size * size;
  const spatial = args.outSpatial;
  const global = args.outGlobal;
  spatial.fill(0);
  global.fill(0);

  const idx = (x: number, y: number, c: number): number => (y * size + x) * NUM_SPATIAL_PLANES + c;

  // 平面 0：在盘内。按原尺寸推理时每一点都在盘内（KataGo 会补到 19 路并把盘外标 0）
  for (let pos = 0; pos < area; pos++) spatial[pos * NUM_SPATIAL_PLANES] = 1;

  // 平面 6：劫禁着点
  if (koPoint >= 0 && koPoint < area) {
    spatial[idx(koPoint % size, (koPoint / size) | 0, 6)] = 1;
  }

  const scratch = args.scratch && args.scratch.size === size ? args.scratch : createFeatureScratch(size);
  computeLibertyMapInto(stones, size, scratch.libertyMap);

  const plaColor = toMove;
  const oppColor = (toMove === 1 ? 2 : 1) as GoColor;

  // 平面 1/2：双方棋子；平面 3/4/5：气数 1/2/3
  for (let pos = 0; pos < area; pos++) {
    const v = stones[pos];
    if (v === 0) continue;
    const x = pos % size;
    const y = (pos / size) | 0;
    spatial[idx(x, y, v === plaColor ? 1 : 2)] = 1;
    const l = scratch.libertyMap[pos];
    if (l === 1) spatial[idx(x, y, 3)] = 1;
    else if (l === 2) spatial[idx(x, y, 4)] = 1;
    else if (l === 3) spatial[idx(x, y, 5)] = 1;
  }

  // 平面 14/17：征子；15/16 由调用方给出上一手/上上手的征子掩码
  const ladder = computeLadderFeatures(stones, size, koPoint, toMove);
  if (args.ladderedOut) args.ladderedOut.set(ladder.laddered);
  for (let pos = 0; pos < area; pos++) {
    const x = pos % size;
    const y = (pos / size) | 0;
    if (ladder.laddered[pos]) spatial[idx(x, y, 14)] = 1;
    if (args.prevLaddered && args.prevLaddered[pos]) spatial[idx(x, y, 15)] = 1;
    if (args.prevPrevLaddered && args.prevPrevLaddered[pos]) spatial[idx(x, y, 16)] = 1;
    if (ladder.workingMoves[pos]) spatial[idx(x, y, 17)] = 1;
  }

  // 平面 18/19：区域归属（数子法下的 pass-alive 区域），同时用于判断终局是否领先
  const hasAreaFeature = rules.scoring === 'area' && rules.tax === 'none';
  let boardScoreForPla = 0;
  if (hasAreaFeature) {
    const areaMap = computeAreaMap(stones, size);
    scratch.areaMap.set(areaMap);
    for (let pos = 0; pos < area; pos++) {
      const v = areaMap[pos];
      if (v === 0) continue;
      const x = pos % size;
      const y = (pos / size) | 0;
      if (v === plaColor) {
        spatial[idx(x, y, 18)] = 1;
        boardScoreForPla += 1;
      } else {
        spatial[idx(x, y, 19)] = 1;
        boardScoreForPla -= 1;
      }
    }
    void oppColor;
  }

  /* 贴目：平局按半胜处理（drawEquivalentWinsForWhite = 0.5，故通常无修正） */
  const drawEquivalentWinsForWhite = 0.5;
  const integerResult = Math.trunc(komi) === komi;
  const drawAdjustment = integerResult ? drawEquivalentWinsForWhite - 0.5 : 0;
  const whiteKomiAdjusted = komi + drawAdjustment;
  const selfKomi = toMove === WHITE ? whiteKomiAdjusted : -whiteKomiAdjusted;

  /* 终局遮蔽：末手为虚手、且本方并不领先时，隐藏「再虚手就终局」的信号，
     免得网络直接把局面判死（KataGo enablePassingHacks） */
  const lastMove = recentMoves.length > 0 ? recentMoves[recentMoves.length - 1] : null;
  const passWouldEndGame = !!lastMove && lastMove.move < 0;
  const finalPhaseAndGameEndWouldNotBeWin = hasAreaFeature && boardScoreForPla + selfKomi <= 0;
  const friendlyPassOk = rules.scoring === 'area';
  const suppressHistory =
    passWouldEndGame &&
    ((args.enablePassingHacks ?? true) && finalPhaseAndGameEndWouldNotBeWin ||
      // 数子法下「友好的虚手」：任何节点都隐藏终局信号
      friendlyPassOk && hasAreaFeature);

  // 平面 9..13 + 全局 0..4：最近五手，必须严格交替（从轮走方角度看）
  const historyPlanes = [9, 10, 11, 12, 13];
  const expected: GoColor[] = [oppColor, plaColor, oppColor, plaColor, oppColor];
  const maxHistory = Math.max(0, Math.min(5, args.maxHistory ?? 5));
  if (!suppressHistory) {
    for (let i = 0; i < maxHistory; i++) {
      const m = recentMoves[recentMoves.length - 1 - i];
      if (!m) break;
      if (m.color !== expected[i]) break;
      if (m.move < 0) {
        global[i] = 1;
      } else {
        spatial[idx(m.move % size, (m.move / size) | 0, historyPlanes[i])] = 1;
      }
    }
  }

  // 全局 5：贴目（KataGo 会截断到 盘面 + 20）
  const komiClipBound = area + KOMI_CLIP_RADIUS;
  const clampedSelfKomi = Math.max(-komiClipBound, Math.min(komiClipBound, selfKomi));
  global[5] = clampedSelfKomi / 20;

  // 全局 6/7：劫规则
  if (rules.ko === 'positional') {
    global[6] = 1;
    global[7] = 0.5;
  } else if (rules.ko === 'situational') {
    global[6] = 1;
    global[7] = -0.5;
  }
  // 全局 8：允许多子自杀
  if (rules.multiStoneSuicideLegal) global[8] = 1;
  // 全局 9：数目法
  if (rules.scoring === 'territory') global[9] = 1;
  // 全局 10/11：还棋头
  if (rules.tax === 'seki') {
    global[10] = 1;
  } else if (rules.tax === 'all') {
    global[10] = 1;
    global[11] = 1;
  }
  // 全局 14：上一手是虚手（含终局判定被遮蔽的情况）
  global[14] = !suppressHistory && passWouldEndGame ? 1 : 0;

  // 全局 18：数子法下的贴目奇偶波
  if (rules.scoring === 'area') {
    const boardAreaIsEven = area % 2 === 0;
    let komiFloor: number;
    if (boardAreaIsEven) komiFloor = Math.floor(clampedSelfKomi / 2) * 2;
    else komiFloor = Math.floor((clampedSelfKomi - 1) / 2) * 2 + 1;

    let delta = clampedSelfKomi - komiFloor;
    if (delta < 0) delta = 0;
    if (delta > 2) delta = 2;
    let wave: number;
    if (delta < 0.5) wave = delta;
    else if (delta < 1.5) wave = 1 - delta;
    else wave = delta - 2;
    global[18] = wave;
  }
}

/**
 * 每点所属棋块的气数（只对棋子有效；空点为 0）。
 * 封顶 4：平面 3/4/5 分别要「恰为 1 / 2 / 3 气」，若把 4 气以上也记成 3，
 * 平面 5 会把大片厚棋全点亮（参考实现同样是 `>=4 → 4`）。
 */
export function computeLibertyMapInto(stones: Uint8Array, size: number, out: Uint8Array): void {
  const geo = geometryFor(size);
  const area = size * size;
  out.fill(0);
  const visited = new Uint8Array(area);
  const group = new Int16Array(area);
  const libs = new Int16Array(area);
  for (let p = 0; p < area; p++) {
    if (stones[p] === 0 || visited[p]) continue;
    const info = floodGroup(stones, geo, p, group, libs);
    const capped = info.libLen >= 4 ? 4 : info.libLen;
    for (let k = 0; k < info.groupLen; k++) {
      visited[group[k]] = 1;
      out[group[k]] = capped;
    }
  }
}

/** 便捷封装：一次性算出空间/全局输入（内部会分配缓冲，适合非热路径） */
export function encodeFeatures(args: Omit<FeatureInput, 'outSpatial' | 'outGlobal'>): {
  spatial: Float32Array;
  global: Float32Array;
} {
  const spatial = new Float32Array(args.size * args.size * NUM_SPATIAL_PLANES);
  const global = new Float32Array(NUM_GLOBAL_PLANES);
  fillFeatures({ ...args, outSpatial: spatial, outGlobal: global });
  return { spatial, global };
}
