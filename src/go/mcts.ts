/* ────────────────────────────────────────────────────────────
 *  go/mcts.ts — PUCT 蒙特卡洛树搜索（AlphaZero 风格，神经网络引导）
 *
 *  与 KataGo 同源的思路：
 *   · 每个节点用网络给出的策略当先验 P，用网络胜率当价值 V，不做随机模拟
 *   · 选择用 PUCT：Q + c·P·sqrt(ΣN)/(1+N)，另加 FPU（未访问子节点取父节点均值再降一点）
 *   · 批量评估：一次前向算若干叶子，GPU 才不会因为单样本小批次空转
 *   · 虚拟损失：同一批内先按「输」记一次，避免整批都扑向同一个子节点
 *
 *  树节点不存棋盘：搜索时沿路径在同一个 GoBoard 上 play/undo，节点只记
 *  统计量与着法。这样 19 路、2000 访问的内存也只有几 MB。
 *
 *  局面超级劫在搜索内部不判（只判简单劫）——与 KataGo 的实战配置一致，
 *  真正的超级劫判定留在对局层（控制器维护历史哈希）。
 * ──────────────────────────────────────────────────────────── */

import { GoBoard, opponent, type GoColor } from './rules';
import { policyFromLogits, type GoEvaluator, type GoPositionInput } from './evaluate';
import type { FeatureMove } from './features';

/** 搜索选项 */
export interface GoSearchOptions {
  /** 访问次数上限 */
  maxVisits: number;
  /** 时间上限（毫秒，0 表示不限） */
  maxTimeMs: number;
  /** 一次前向评估几个叶子 */
  batchSize: number;
  /** PUCT 常数 */
  cPuct: number;
  /** 根节点策略温度：>1 更平（更愿意尝试次优），1 不变 */
  rootPolicyTemperature: number;
  /** 根节点先验里混入的均匀噪声比例（0~1，制造多样性） */
  rootNoise: number;
  /** 最终选点温度：0 = 直接取访问最多的一手；>0 = 按访问次数^温度 采样 */
  moveTemperature: number;
}

export function defaultSearchOptions(): GoSearchOptions {
  return {
    maxVisits: 200,
    maxTimeMs: 3000,
    batchSize: 8,
    cPuct: 1.2,
    rootPolicyTemperature: 1,
    rootNoise: 0,
    moveTemperature: 0,
  };
}

/** 搜索请求（一个待搜索的局面） */
export interface GoSearchRequest {
  size: number;
  /** 棋子：0 空 1 黑 2 白 */
  stones: Uint8Array;
  koPoint: number;
  toMove: GoColor;
  komi: number;
  /** 最近若干手（时间顺序，最后一项是最近一手） */
  recentMoves: readonly FeatureMove[];
  /** 上一手 / 上上手局面的征子掩码 */
  prevLaddered?: Uint8Array | null;
  prevPrevLaddered?: Uint8Array | null;
}

/** 候选点（给界面显示用） */
export interface GoCandidateInfo {
  /** 棋盘索引；area 表示虚手 */
  move: number;
  visits: number;
  /** 该手之后「轮走方」的胜率（0~1） */
  winProb: number;
  /** 黑方视角目差 */
  scoreLead: number;
  prior: number;
}

export interface GoSearchResult {
  /** 选中的着法（-1 = 虚手） */
  move: number;
  visits: number;
  ms: number;
  /** 根节点胜率（轮走方视角） */
  winProb: number;
  /** 根节点目差（黑视角） */
  scoreLead: number;
  candidates: GoCandidateInfo[];
  /** 黑视角归属（长度 area），来自根节点评估 */
  ownership: Float32Array;
  /** 主变（着法索引，虚手为 area） */
  pv: number[];
}

interface GoNode {
  /** 父节点落子到此的手（area = 虚手） */
  move: number;
  /** 该节点轮走方 */
  toMove: GoColor;
  parent: GoNode | null;
  /** 从根到该节点的深度（根为 0） */
  depth: number;
  /** 访问次数（含根节点评估那一次） */
  visits: number;
  /** 该节点轮走方视角的胜率累计 */
  winSum: number;
  /** 黑视角目差累计（目差是黑视角，不随轮走方翻转） */
  scoreSum: number;
  /** 是否已展开（叶子 = 未展开）；已终局节点记为 expanded 且无子 */
  expanded: boolean;
  terminal: boolean;
  /** 终局节点的定值（轮走方视角胜率）与其目差 */
  terminalValue: number;
  terminalScore: number;
  /** 该节点的征子掩码（供子节点特征平面 15 使用） */
  laddered: Uint8Array | null;
  /** 合法着法掩码（长度 area，1 = 合法） */
  legal: Uint8Array | null;
  /** 先验概率（长度 area+1，末位虚手） */
  priors: Float32Array | null;
  /** 各着法的统计（下标 = 着法，末位虚手）——父节点持有，省内存 */
  childVisits: Int32Array | null;
  /** 各着法的价值累计（父节点轮走方视角） */
  childWinSum: Float32Array | null;
  /** 各着法的目差累计（黑视角） */
  childScoreSum: Float32Array | null;
  childNodes: (GoNode | null)[] | null;
  /** 本节点评估得到的黑视角归属（仅根节点保留） */
  ownership: Float32Array | null;
}

/** 虚拟损失：先按「输」计（赢率 0）占位，避免同一批全扑向同一个子节点 */
const VIRTUAL_LOSS_WIN = 0;

/** 一次叶子选择的结果 */
interface LeafPick {
  node: GoNode;
  path: GoNode[];
  /** 该叶子的局面（拷贝出来，便于批内多个叶子并存） */
  position: GoPositionInput;
}

const PASS_MOVE_INDEX = (area: number): number => area;

function createNode(parent: GoNode | null, move: number, toMove: GoColor, depth: number): GoNode {
  return {
    move,
    toMove,
    parent,
    depth,
    visits: 0,
    winSum: 0,
    scoreSum: 0,
    expanded: false,
    terminal: false,
    terminalValue: 0.5,
    terminalScore: 0,
    laddered: null,
    legal: null,
    priors: null,
    childVisits: null,
    childWinSum: null,
    childScoreSum: null,
    childNodes: null,
    ownership: null,
  };
}

export interface GoSearchHooks {
  /** 每轮进度（已访问次数） */
  onProgress?: (visits: number) => void;
  /** 返回 true 时尽快结束搜索（用于玩家重开/悔棋时打断） */
  shouldStop?: () => boolean;
}

/** PUCT 搜索器：每次 run 独立建树（不做跨手复用），与本站其它引擎的「无状态」风格一致 */
export class GoSearcher {
  constructor(
    private readonly evaluator: GoEvaluator,
    private readonly options: GoSearchOptions,
  ) {}

  async run(req: GoSearchRequest, hooks: GoSearchHooks = {}): Promise<GoSearchResult> {
    const started = Date.now();
    const size = req.size;
    const area = size * size;
    const passIdx = PASS_MOVE_INDEX(area);
    const board = GoBoard.from(size, req.stones, req.toMove);
    board.koPoint = req.koPoint;

    // 路径上的最近五手（供特征的历史平面使用）
    const history: FeatureMove[] = req.recentMoves.slice(-5);

    const root = createNode(null, passIdx, req.toMove, 0);
    let totalVisits = 0;
    let lastProgress = 0;

    // 根节点先评估一次：拿先验 + 胜率 + 归属
    const rootPos: GoPositionInput = {
      size,
      stones: board.stones.slice(),
      koPoint: board.koPoint,
      toMove: board.toMove,
      recentMoves: history.slice(),
      komi: req.komi,
      prevLaddered: req.prevLaddered ?? null,
      prevPrevLaddered: req.prevPrevLaddered ?? null,
    };
    const rootEval = await this.evaluator.evaluateOne(rootPos);
    this.expand(root, rootPos, rootEval.policyLogits, req.komi);
    const rootOwnership = rootEval.ownership;
    // 根节点自身也算一次访问（视角 = 根节点轮走方）
    root.visits = 1;
    root.winSum = root.toMove === 1 ? rootEval.blackWinProb : 1 - rootEval.blackWinProb;
    root.scoreSum = rootEval.blackScoreLead;
    totalVisits = 1;

    const deadline = this.options.maxTimeMs > 0 ? started + this.options.maxTimeMs : Infinity;

    while (totalVisits < this.options.maxVisits && Date.now() < deadline) {
      if (hooks.shouldStop?.()) break;

      // ── 1. 收集一批叶子 ──
      const picks: LeafPick[] = [];
      const batchTarget = Math.max(1, this.options.batchSize);
      for (let i = 0; i < batchTarget; i++) {
        if (totalVisits + picks.length + 1 > this.options.maxVisits) break;
        if (Date.now() >= deadline) break;
        const pick = this.selectLeaf(board, root, history, req);
        if (!pick) break;
        picks.push(pick);
      }
      if (picks.length === 0) break;

      // ── 2. 批量评估（终局叶子不需要网络） ──
      const needEval = picks.filter((p) => !p.node.terminal && !p.node.expanded);
      let evals: Awaited<ReturnType<GoEvaluator['evaluate']>> = [];
      if (needEval.length > 0) {
        evals = await this.evaluator.evaluate(needEval.map((p) => p.position));
      }

      // ── 3. 回传（统计口径：子节点侧统计存在父节点的 childXxx 数组里） ──
      let evalIdx = 0;
      for (const pick of picks) {
        const leaf = pick.node;
        let leafValue: number; // 叶子轮走方视角胜率
        let leafScore: number; // 黑视角目差

        if (leaf.terminal) {
          leafValue = leaf.terminalValue;
          leafScore = leaf.terminalScore;
        } else if (leaf.expanded) {
          // 已展开却成了叶子（罕见）：用它自己的统计均值
          leafValue = leaf.visits > 0 ? leaf.winSum / leaf.visits : 0.5;
          leafScore = leaf.visits > 0 ? leaf.scoreSum / leaf.visits : 0;
        } else {
          const r = evals[evalIdx++];
          leafValue = leaf.toMove === 1 ? r.blackWinProb : 1 - r.blackWinProb;
          leafScore = r.blackScoreLead;
          this.expand(leaf, pick.position, r.policyLogits, req.komi);
        }

        // 叶子自身
        leaf.visits++;
        leaf.winSum += leafValue;
        leaf.scoreSum += leafScore;

        // 沿路径回传：v = 「该父节点轮走方视角」的胜率
        let v = 1 - leafValue;
        let s = leafScore;
        let moveFromParent = leaf.move;
        for (let i = pick.path.length - 2; i >= 0; i--) {
          const parent = pick.path[i];
          // childVisits 已在下降时 +1（虚拟损失），这里补上真实价值
          parent.childWinSum![moveFromParent] += v;
          parent.childScoreSum![moveFromParent] += s;
          parent.visits++;
          parent.winSum += v;
          parent.scoreSum += s;
          moveFromParent = parent.move;
          v = 1 - v;
        }
        totalVisits++;
      }

      if (hooks.onProgress && totalVisits - lastProgress >= 16) {
        lastProgress = totalVisits;
        hooks.onProgress(totalVisits);
      }
      if (Date.now() >= deadline) break;
    }

    // ── 选点 ──
    const candidates = this.rootCandidates(root, area);
    const move = this.pickRootMove(candidates, area);
    const best = candidates.find((c) => c.move === move);
    const pv = this.extractPv(root, area, 8);

    return {
      move: move === passIdx ? -1 : move,
      visits: totalVisits,
      ms: Date.now() - started,
      winProb: best ? best.winProb : 0.5,
      scoreLead: best ? best.scoreLead : 0,
      candidates,
      ownership: rootOwnership,
      pv,
    };
  }

  /**
   * 从根下降选一个叶子：沿途记虚拟损失，返回叶子节点与沿路节点。
   * 下降结束后棋盘停在叶子局面（调用方负责撤销）。
   */
  private selectLeaf(board: GoBoard, root: GoNode, history: FeatureMove[], req: GoSearchRequest): LeafPick | null {
    const area = board.area;
    let node = root;
    const path: GoNode[] = [];
    const undoCount: number[] = [];

    for (;;) {
      if (node.terminal) break;
      if (!node.expanded) break;
      if (!node.legal || !node.priors) break;

      const child = this.selectChild(node, area);
      if (child < 0) break; // 选择器保证有解，兜底直接当叶子
      // 虚拟损失：这一手先按「输」占位，同批内不会重复扑向同一条边
      node.childVisits![child] += 1;
      node.childWinSum![child] += VIRTUAL_LOSS_WIN;
      node.childScoreSum![child] += 0;
      path.push(node);

      const isPass = child === area;
      if (!board.play(isPass ? -1 : child)) {
        // 理论上不该出现（合法掩码已过滤）；兜底把这手屏蔽掉再当叶子
        node.legal![child] = 0;
        node.priors![child] = 0;
        node.childVisits![child] -= 1;
        path.pop();
        break;
      }
      undoCount.push(1);
      history.push({ move: isPass ? -1 : child, color: node.toMove });

      let next = node.childNodes![child];
      if (!next) {
        next = createNode(node, child, opponent(node.toMove), node.depth + 1);
        node.childNodes![child] = next;
        // 终局判定：连续两次虚手 → 数目定胜负
        if (isPass && board.passes >= 2) {
          const score = board.score('chinese', req.komi);
          const blackWins = score.winner === 1;
          next.terminal = true;
          next.expanded = true;
          next.terminalValue = next.toMove === 1 ? (blackWins ? 1 : 0) : blackWins ? 0 : 1;
          next.terminalScore = blackWins ? score.margin : -score.margin;
        }
      }
      node = next;
    }

    // 收集叶子局面（拷贝出来，批内多个叶子并存；顺便把征子掩码挂到节点上）
    if (!node.laddered) node.laddered = new Uint8Array(board.area);
    const position: GoPositionInput = {
      size: board.size,
      stones: board.stones.slice(),
      koPoint: board.koPoint,
      toMove: board.toMove,
      recentMoves: history.slice(-5),
      komi: req.komi,
      prevLaddered: node.parent?.laddered ?? req.prevLaddered ?? null,
      prevPrevLaddered: node.parent?.parent?.laddered ?? req.prevPrevLaddered ?? null,
      ladderedOut: node.laddered,
    };

    // 立刻把棋盘退回根，下一轮好重新下降
    for (let i = 0; i < undoCount.length; i++) {
      board.undo();
      history.pop();
    }

    path.push(node);
    return { node, path, position };
  }

  /**
   * PUCT 选择：返回子着法索引（area = 虚手）。
   * 未访问的子节点用父节点均值折扣作 FPU，先验为 0 的着法也不会被完全
   * 排除（极端局面下网络可能把某些点压到 0 概率）。
   */
  private selectChild(node: GoNode, area: number): number {
    const legal = node.legal!;
    const priors = node.priors!;
    const childVisits = node.childVisits!;
    const childWinSum = node.childWinSum!;
    const sqrtParent = Math.sqrt(Math.max(1, node.visits));
    const parentQ = node.visits > 0 ? node.winSum / node.visits : 0.5;

    let bestMove = -1;
    let bestScore = -Infinity;
    let unvisited = -1;
    let bestPriorMove = -1;
    let bestPrior = -1;

    for (let m = 0; m <= area; m++) {
      const isPass = m === area;
      if (!isPass && !legal[m]) continue;
      const n = childVisits[m];
      const p = priors[m];
      if (n === 0) {
        if (unvisited < 0) unvisited = m;
        if (p > bestPrior) {
          bestPrior = p;
          bestPriorMove = m;
        }
      }
      // 子节点未访问时用父节点均值（FPU）稍作折扣
      const q = n > 0 ? childWinSum[m] / n : parentQ - 0.1;
      const u = this.options.cPuct * p * (sqrtParent / (1 + n));
      const score = q + u;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }

    // 先验全为 0 的极端情形也要给出着法：优先没走过的、先验最高的
    if (bestMove < 0) return bestPriorMove >= 0 ? bestPriorMove : unvisited;
    return bestMove;
  }

  /**
   * 展开节点：写入合法掩码与先验。
   * 必须用「该节点自己的局面」算合法性——回传阶段棋盘早已退回根节点，
   * 拿当前 board 算会得到根节点的合法点（曾导致子节点先验/合法点全错）。
   */
  private expand(node: GoNode, position: GoPositionInput, logits: Float32Array, komi: number): void {
    void komi;
    const area = node.legal?.length ?? position.size * position.size;
    const board = GoBoard.from(position.size, position.stones, position.toMove);
    board.koPoint = position.koPoint;

    const legal = new Uint8Array(area);
    for (let i = 0; i < area; i++) if (board.isLegal(i)) legal[i] = 1;

    let probs = policyFromLogits(logits, area, legal);

    // 根节点可选的策略温度与噪声（低难度用来制造变化）
    if (node.depth === 0) {
      const temp = this.options.rootPolicyTemperature;
      if (temp !== 1) probs = applyPolicyTemperature(probs, area, temp);
      const noise = this.options.rootNoise;
      if (noise > 0) probs = mixUniformNoise(probs, area, noise, legal);
    }

    node.legal = legal;
    node.priors = probs;
    node.childVisits = new Int32Array(area + 1);
    node.childWinSum = new Float32Array(area + 1);
    node.childScoreSum = new Float32Array(area + 1);
    node.childNodes = new Array<GoNode | null>(area + 1).fill(null);
    node.expanded = true;
  }

  /** 根节点候选点（按访问次数排序） */
  private rootCandidates(root: GoNode, area: number): GoCandidateInfo[] {
    const out: GoCandidateInfo[] = [];
    if (!root.childVisits || !root.legal || !root.priors) return out;
    for (let m = 0; m <= area; m++) {
      const n = root.childVisits[m];
      if (n <= 0) continue;
      out.push({
        move: m,
        visits: n,
        winProb: root.childWinSum![m] / n,
        scoreLead: root.childScoreSum![m] / n,
        prior: root.priors[m],
      });
    }
    out.sort((a, b) => b.visits - a.visits);
    return out;
  }

  /** 最终选点：温度 0 取访问最多，温度 >0 按访问次数采样 */
  private pickRootMove(candidates: GoCandidateInfo[], area: number): number {
    if (candidates.length === 0) return area; // 只能虚手
    const temp = this.options.moveTemperature;
    if (temp <= 0) return candidates[0].move;

    const weights = candidates.map((c) => Math.pow(c.visits, 1 / Math.max(0.05, temp)));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return candidates[0].move;
    let r = Math.random() * sum;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i].move;
    }
    return candidates[candidates.length - 1].move;
  }

  /** 沿访问最多的子节点走出一条主变 */
  private extractPv(root: GoNode, area: number, maxLen: number): number[] {
    const pv: number[] = [];
    let node: GoNode | null = root;
    for (let i = 0; i < maxLen; i++) {
      if (!node || !node.childVisits) break;
      let best = -1;
      let bestVisits = 0;
      for (let m = 0; m <= area; m++) {
        const n = node.childVisits[m];
        if (n > bestVisits) {
          bestVisits = n;
          best = m;
        }
      }
      if (best < 0) break;
      pv.push(best);
      node = node.childNodes ? node.childNodes[best] : null;
    }
    return pv;
  }
}

/** 策略温度：p^(1/T) 后归一化（T>1 变平，T<1 变尖） */
function applyPolicyTemperature(probs: Float32Array, area: number, temperature: number): Float32Array {
  const out = new Float32Array(area + 1);
  const t = Math.max(0.05, temperature);
  let sum = 0;
  for (let i = 0; i <= area; i++) {
    const v = Math.pow(Math.max(probs[i], 1e-12), 1 / t);
    out[i] = v;
    sum += v;
  }
  if (sum > 0) for (let i = 0; i <= area; i++) out[i] /= sum;
  return out;
}

/** 与均匀分布混合：p' = (1-eps)·p + eps·uniform(合法着法) */
function mixUniformNoise(probs: Float32Array, area: number, eps: number, legal: Uint8Array): Float32Array {
  const out = new Float32Array(area + 1);
  let count = 1; // 虚手
  for (let i = 0; i < area; i++) if (legal[i]) count++;
  const uni = 1 / count;
  const keep = 1 - eps;
  for (let i = 0; i <= area; i++) {
    const isLegal = i === area || legal[i] === 1;
    out[i] = isMoveAllowed(isLegal) ? keep * probs[i] + eps * uni : 0;
  }
  return out;
}

function isMoveAllowed(isLegal: boolean): boolean {
  return isLegal;
}
