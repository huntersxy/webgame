/* ────────────────────────────────────────────────────────────
 *  xqnn/search.ts — 神经网络 × α-β 的融合搜索
 *
 *  ── 为什么不是纯 AlphaZero 式 PUCT ──
 *  实测（tests 里保留了同一套 fixture 与对抗脚本）：这个 8.7MB 的网络
 *  **策略头很可靠、价值头很弱**——红方白多一个车时，价值头输出几乎不变。
 *  纯 PUCT 只靠「策略先验 + 价值头叶子评估」去对抗经典引擎的 40 万节点
 *  α-β，实测 0:6 全败（价值信号不可用，200 次访问也没有静态搜索兜底）。
 *
 *  ── 所以改成各取所长的融合 ──
 *  ① **战术由 α-β 负责**：复用项目里已经调好的引擎
 *     （src/xiangqi/search.ts，迭代加深 + PVS + 静态搜索 + 置换表），
 *     findBestMove 会把**全部**根着法的 α-β 分数交出来。
 *  ② **先验由网络负责**：策略头的 logit（走法表下标对齐）作为根着法的
 *     加分项，权重按难度递减——简单档几乎照着人类棋谱选，恶魔档只在
 *     近乎等价的着法之间微调。
 *  ③ **形势由网络补充**：对每个根着法的**后继局面**跑一次网络，取价值
 *     头（换成我方视角）作为小幅修正。放在后继局面上才有区分度——根
 *     局面的价值对所有着法都是同一个常数，加不加都不影响着法选择。
 *
 *  一次求着只需要「根局面 1 次 + 后继局面 1 批」前向，浏览器里通常在
 *  几十毫秒内完成，不会拖慢落子。
 * ──────────────────────────────────────────────────────────── */

import type { Difficulty, GameMode, SearchResult, XqBoard, XqMove, XqSide } from '../types';
import { findBestMove, MATE } from '../xiangqi/search';
import { COLS, legalMoves, makeMove } from '../xiangqi/rules';
import { encodeBoard, actionIndex } from './encoding';
import type { XqEvaluatorLike } from './evaluate';

/** 难度档：α-β 用项目原有的四档配置，网络只调「掺入多少」 */
export interface XqnnLevel {
  name: string;
  /** 策略先验权重：根着法评分里，1 个 logit 折合多少评估分 */
  policyWeight: number;
  /** 价值头权重：后继局面的网络价值折合多少评估分（±1 → ±valueWeight） */
  valueWeight: number;
  /**
   * 网络修正的**硬窗口**：`policyWeight·先验 + valueWeight·价值` 会被夹在
   * ±window 之内。这是关键的安全阀 —— 高难度档窗口只有 25/8 分，网络只能
   * 在「α-β 认为几乎等价」的着法之间表达偏好，绝不可能顶掉一个战术上
   * 明显更好的着法；低难度档窗口放大到 300/140 分，让网络（人类棋谱训练）
   * 主导选择，得到"像人但很弱"的简单档。
   *
   * 实测（每档 8~10 局，对手就是同一套 α-β，只关掉网络项作对照）：
   *   网络项清零 2:1:5（五五开）· 只留策略 0:7:1 · 只留价值 0:3:5 ·
   *   全部打开（窗口 70）0:5:3。结论：这个网络**不适合给深搜的着法加分**，
   *   所以高难度档把窗口收到 25/8，网络只做近似等价着法的偏好与变化。
   */
  window: number;
  /**
   * 只在前 N 手（ply）启用网络修正；超出后按纯 α-β 的结果走。
   * 0 = 全程启用（低难度档用的就是这种"网络风格"）。
   */
  openingPlies: number;
  /** 根着法采样的温度：0 = 直接取最高分；越大越随机（高斯尺度 = sigma） */
  temperature: number;
  /** 采样的高斯尺度（评估分）：只在该窗口内的着法之间随机 */
  sigma: number;
}

export const XQNN_LEVELS: Record<Difficulty, XqnnLevel> = {
  1: { name: '简单', policyWeight: 220, valueWeight: 60, window: 300, openingPlies: 0, temperature: 0.6, sigma: 90 },
  2: { name: '普通', policyWeight: 120, valueWeight: 40, window: 140, openingPlies: 0, temperature: 0.3, sigma: 40 },
  3: { name: '困难', policyWeight: 60, valueWeight: 25, window: 25, openingPlies: 0, temperature: 0.08, sigma: 10 },
  4: { name: '😈恶魔', policyWeight: 30, valueWeight: 15, window: 8, openingPlies: 0, temperature: 0, sigma: 0 },
};

/** 绝杀分不参与融合：α-β 说这手是将死，网络先验不许把它顶掉 */
const MATE_GUARD = MATE / 2;
/** 慢后端（CPU/WASM）下最多给多少个后继局面跑价值头 */
const SLOW_BACKEND_VALUE_EVALS = 16;

export class XqSearcher {
  constructor(private readonly ev: XqEvaluatorLike) {}

  /** 求一着：α-β 全根着法评分 + 网络策略先验 + 网络价值微调。 */
  async search(board: XqBoard, side: XqSide, difficulty: Difficulty, mode: GameMode, historyLength = 0): Promise<SearchResult<XqMove>> {
    const cfg = XQNN_LEVELS[difficulty];
    const table = this.ev.moves;

    // ① α-β 搜索：拿到全部根着法的分数（行棋方视角）
    //    skipOpeningRandom=true：开局的多样性交给网络先验 + 温度采样，
    //    而不是内置引擎那条「随机挑一手」的捷径（它还会绕过 rootOut）。
    const rootScores: Array<XqMove & { v: number }> = [];
    const ab = findBestMove(board, side, difficulty, mode, historyLength, true, rootScores, true);
    if (!rootScores.length) {
      // 兜底：正常不会走到（skipOpeningRandom 之后所有出口都会填 rootOut）
      return { ...ab, engine: 'xqnn', backend: this.ev.backend ?? undefined, modelName: 'chess_model.onnx' };
    }

    // ② 网络：策略先验（根局面） + 价值头（后继局面）
    const rootEval = await this.ev.evaluateBoard(board, side);

    // 慢后端（CPU/WASM 兜底）下不必给每个后继局面都跑价值头：按先验取前 K 个即可。
    // GPU 后端一次批量很便宜，就全算。
    const backend = this.ev.backend;
    const fastBackend = backend === 'webgpu' || backend === 'webgl' || backend === null;
    const priorOrder = rootScores
      .map((m, i) => {
        const action = actionIndex(m.fy * COLS + m.fx, m.ty * COLS + m.tx);
        return { i, logit: action >= 0 ? rootEval.policy[action] : -Infinity };
      })
      .sort((a, b) => b.logit - a.logit);
    const valuePick = fastBackend ? priorOrder : priorOrder.slice(0, SLOW_BACKEND_VALUE_EVALS);
    const pickSet = new Set(valuePick.map((p) => p.i));

    const valueBoards: XqBoard[] = [];
    const valueOwner: number[] = [];
    for (const p of valuePick) {
      const m = rootScores[p.i];
      const copy = board.map((row) => row.slice()) as XqBoard;
      makeMove(copy, m);
      valueBoards.push(copy);
      valueOwner.push(p.i);
    }

    const childValues = new Float32Array(rootScores.length);
    try {
      const evals = await this.ev.evaluate(valueBoards.map((b) => encodeBoard(b, side === 'r' ? 'b' : 'r')));
      for (let k = 0; k < evals.length; k++) childValues[valueOwner[k]] = -evals[k].value; // 换成我方视角
      void pickSet;
    } catch (err) {
      console.warn('[xqnn] 网络评估失败，退回纯 α-β 结果：', err);
      return { ...ab, engine: 'xqnn', backend: this.ev.backend ?? undefined, modelName: 'chess_model.onnx' };
    }

    // ③ 融合：logit 去均值（只比较相对倾向），绝杀分冻结
    const logits = rootScores.map((m) => {
      const action = actionIndex(m.fy * COLS + m.fx, m.ty * COLS + m.tx);
      return action >= 0 ? rootEval.policy[action] : 0;
    });
    const meanLogit = logits.reduce((a, b) => a + b, 0) / logits.length;

    const blended = rootScores.map((m, i) => {
      // 绝杀不参与融合：α-β 已经算出这手将死，先验不许把它顶掉
      if (Math.abs(m.v) >= MATE_GUARD) return { move: m, score: m.v, mate: true };
      // openingPlies > 0 时，只有开局阶段让网络发言
      if (cfg.openingPlies > 0 && historyLength >= cfg.openingPlies) {
        return { move: m, score: m.v, mate: false };
      }
      const prior = logits[i] - meanLogit;
      const value = childValues[i];
      // 网络修正夹在 ±window 之内：高难度档窗口很小，只能在「α-β 认为
      // 几乎等价」的着法之间表达偏好，永远不会顶掉战术上更好的着法。
      const nn = cfg.policyWeight * prior + cfg.valueWeight * value;
      const clamped = Math.max(-cfg.window, Math.min(cfg.window, nn));
      return { move: m, score: m.v + clamped, mate: false };
    });

    const best = this.pickRoot(blended, cfg);
    const ordered = blended.slice().sort((a, b) => b.score - a.score);
    // 主变：网络没改选时用 α-β 的主变；改选了就只报这一手 —— 否则界面上
    // 会出现「选的是 A，主变却从 B 开始」的错位。
    const sameAsAb = !!ab.move
      && ab.move.fx === best.move.fx && ab.move.fy === best.move.fy
      && ab.move.tx === best.move.tx && ab.move.ty === best.move.ty;

    // 主变：α-β 的主变（网络只影响根节点选择，不产生假的主变）
    return {
      move: best.move,
      depth: ab.depth,
      nodes: ab.nodes,
      ms: ab.ms,
      eval: Math.round(ordered[0].score),
      scores: ordered.slice(0, 6).map((b2) => ({ ...b2.move, v: Math.round(b2.score) })),
      pv: sameAsAb ? ab.pv : [best.move],
      boosted: ab.boosted,
      qd: ab.qd,
      engine: 'xqnn',
      backend: this.ev.backend ?? undefined,
      modelName: 'chess_model.onnx',
    };
  }

  /** 根着法决策：温度 0 取最高分；否则在 sigma 尺度内做 softmax 采样（低难度更像人） */
  private pickRoot(list: Array<{ move: XqMove; score: number; mate: boolean }>, cfg: XqnnLevel): { move: XqMove; score: number; mate: boolean } {
    let best = list[0];
    for (const item of list) if (item.score > best.score) best = item;
    if (cfg.temperature <= 0 || cfg.sigma <= 0) return best;

    // 绝杀着法优先，不参与采样
    const mating = list.filter((i) => i.mate && i.score > 0);
    if (mating.length) return mating[0];

    const max = best.score;
    const sigma = cfg.sigma;
    const weights = list.map((i) => Math.exp((i.score - max) / sigma));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return best;
    let r = Math.random() * sum;
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i];
    }
    return best;
  }
}

/** 交给外部（测试/自检）用：某局面下网络对各合法着法的先验排序 */
export async function policyRanking(
  ev: XqEvaluatorLike,
  board: XqBoard,
  side: XqSide,
): Promise<Array<{ move: XqMove; logit: number }>> {
  const evalOut = await ev.evaluateBoard(board, side);
  const out: Array<{ move: XqMove; logit: number }> = [];
  for (const m of legalMoves(board, side)) {
    const action = actionIndex(m.fy * COLS + m.fx, m.ty * COLS + m.tx);
    out.push({ move: m, logit: action >= 0 ? evalOut.policy[action] : -Infinity });
  }
  out.sort((a, b) => b.logit - a.logit);
  return out;
}
