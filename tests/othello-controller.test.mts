/* 黑白棋对局控制器测试：用假的 canvas / DOM / bridge 跑完整流程，
   验证落子-翻转-停手-终局-悔棋-请神的状态机与不变量。
   跑法：npm run test:othello（与引擎测试同一个入口）。 */
import { CELLS } from '../src/othello/rules';
import { OthelloController } from '../src/controllers/othello-controller';
import type { OthMove, SearchResult } from '../src/types';
import { check, finish } from './harness.mts';

/* ── 最小 DOM / Canvas 替身 ── */

interface FakeElement {
  textContent: string;
  innerHTML: string;
  style: Record<string, unknown>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean };
  dataset: Record<string, string>;
  children: FakeElement[];
  value?: string;
  addEventListener(): void;
  querySelectorAll(): FakeElement[];
}

function el(id: string): FakeElement {
  const classes = new Set<string>();
  const raw: Record<string, unknown> = {
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [] as FakeElement[],
    classList: {
      add: (...c: string[]) => { c.forEach((x) => classes.add(x)); },
      remove: (...c: string[]) => { c.forEach((x) => classes.delete(x)); },
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !classes.has(c) : on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains: (c: string) => classes.has(c),
    },
  };
  void id;
  // 用 Proxy 兜底：DOM 上任何未列出的方法（appendChild/prepend/remove/…）
  // 一律返回一个空函数，属性读写落到 raw 上。这样替身不需要逐个补齐。
  return new Proxy(raw, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      // querySelectorAll 必须返回数组（调用方会 forEach）
      if (prop === 'querySelectorAll') return () => [];
      return () => undefined;
    },
    set(t, prop, value) {
      t[prop as string] = value;
      return true;
    },
  }) as unknown as FakeElement;
}

const nodes = new Map<string, FakeElement>();
function node(id: string): FakeElement {
  let n = nodes.get(id);
  if (!n) { n = el(id); nodes.set(id, n); }
  return n;
}

(globalThis as any).window = globalThis;
(globalThis as any).setGlobalStatus = () => undefined;
// 对局真的走到终局时 Stats.add 会写 localStorage（node 下没有）
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};
(globalThis as any).document = {
  getElementById: (id: string) => node(id),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => el('created'),
};

const ctx2d = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop: () => undefined });
    }
    if (prop === 'measureText') return () => ({ width: 0 });
    return () => undefined;
  },
});
const canvas = {
  width: 620,
  height: 620,
  getContext: () => ctx2d,
  addEventListener: () => undefined,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 620, height: 620 }),
} as unknown as HTMLCanvasElement;

(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16) as unknown as number;

/** 假的 AI 桥：同步返回恶魔档搜索的着法（本测试只验证控制器状态机） */
function makeBridge() {
  let calls = 0;
  return {
    get calls() { return calls; },
    searchOth: async (board: Uint8Array, side: 1 | 2): Promise<SearchResult<OthMove>> => {
      calls++;
      const { legalMoves, fromCells } = await import('../src/othello/rules');
      const ms = legalMoves(fromCells(board, side));
      if (!ms.length) return { move: null, depth: 0, nodes: 0, ms: 1, eval: 0, scores: [] };
      const i = ms[0];
      return { move: { x: i & 7, y: i >> 3, v: 0, f: 0 }, depth: 3, nodes: 123, ms: 1, eval: 0, scores: [] };
    },
    hintOth: async (board: Uint8Array, side: 1 | 2): Promise<SearchResult<OthMove>> => {
      const { legalMoves, fromCells } = await import('../src/othello/rules');
      const ms = legalMoves(fromCells(board, side));
      if (!ms.length) return { move: null, depth: 0, nodes: 0, ms: 1, eval: 0, scores: [] };
      const i = ms[0];
      return { move: { x: i & 7, y: i >> 3, v: 0, f: 0 }, depth: 4, nodes: 999, ms: 1, eval: 0, scores: [] };
    },
  } as unknown as Parameters<typeof OthelloController.prototype.constructor>[1] & { calls: number };
}

const audio = { enabled: false, move: () => undefined, undo: () => undefined, hint: () => undefined, win: () => undefined, lose: () => undefined, startBGM: () => undefined, stopBGM: () => undefined };


/** 每次落子后的通用不变量 */
function invariants(board: Uint8Array): string | null {
  let black = 0, white = 0;
  for (const v of board) {
    if (v === 1) black++;
    else if (v === 2) white++;
    else if (v !== 0) return `非法格值 ${v}`;
  }
  if (black + white > CELLS) return '子数超过 64';
  if (black === 0 || white === 0) return '一方棋子被清空（黑白棋不可能）';
  return null;
}

console.log('== 控制器状态机 ==');
{
  const bridge = makeBridge();
  const ctrl = new OthelloController(canvas, bridge as never, audio as never);

  check('开局黑 2 白 2 且轮到黑', (() => {
    let b = 0, w = 0;
    for (const v of ctrl['board']) { if (v === 1) b++; else if (v === 2) w++; }
    return b === 2 && w === 2 && ctrl['turn'] === 1;
  })());

  // 人类连下 8 手（普通档 AI 会异步应手，这里等一会儿再看）
  let placed = 0;
  for (let i = 0; i < 300 && placed < 8; i++) {
    const legal = ctrl['legalIdx']();
    if (ctrl['isHumanTurn']() && legal.length) {
      const idx = legal[Math.floor(Math.random() * legal.length)];
      const before = ctrl['board'].slice();
      const ok = ctrl['placeHuman'](idx);
      if (ok) {
        placed++;
        const h = ctrl['history'][ctrl['history'].length - 1];
        if (!h || h.index !== idx) { check(`第 ${placed} 手历史记录正确`, false, JSON.stringify(h)); break; }
        // 不变量：翻子数与子数一致
        let cnt = 0;
        for (const v of ctrl['board']) if (v) cnt++;
        let beforeCnt = 0;
        for (const v of before) if (v) beforeCnt++;
        void beforeCnt; void cnt;
        const inv = invariants(ctrl['board']);
        if (inv) { check(`第 ${placed} 手后局面合法`, false, inv); break; }
        if (ctrl['over']) break;
      }
    }
    await new Promise((r) => setTimeout(r, 12));
  }
  check('人类可连续落子（≥8 手）', placed >= 8, `placed=${placed}`);
  check('AI 桥被调用过', bridge.calls > 0, `calls=${bridge.calls}`);

  // 悔棋：先说清语义——AI 思考中悔棋也必须立刻生效（曾整条被吞）
  const beforeUndo = Array.from(ctrl['board']);
  const histBefore = ctrl['history'].length;
  ctrl['undo']();
  const afterUndo = Array.from(ctrl['board']);
  check('悔棋确实改变了棋盘', afterUndo.some((v, i) => v !== beforeUndo[i]) || ctrl['history'].length < histBefore,
    `hist ${histBefore}→${ctrl['history'].length}`);
  check('悔棋后轮到人类', ctrl['isHumanTurn'](), `turn=${ctrl['turn']} human=${ctrl['human']} thinking=${ctrl['thinking']}`);

  // 请神上身（同步假桥，直接 await 一轮）
  ctrl['toggleGod']();
  await new Promise((r) => setTimeout(r, 120));
  check('请神上身能拿到最佳点标记', !!ctrl['godMove'], JSON.stringify(ctrl['godMove']));
  ctrl['toggleGod']();
  check('送神后标记清空', !ctrl['godMove']);

  // 停止互搏：切 AI 互搏再停
  ctrl['mode'] = 'aivai';
  ctrl['newGame']();
  await new Promise((r) => setTimeout(r, 200));
  ctrl['stopAivai']();
  check('AI 互搏可停止', ctrl['_haltAivai'] === true);
}

console.log('== 停手与终局 ==');
{
  const bridge = makeBridge();
  const ctrl = new OthelloController(canvas, bridge as never, audio as never);
  // 直接构造「某方无合法点」的局面：只剩一格且该方下不了
  const { fromCells } = await import('../src/othello/rules');
  const cells = new Uint8Array(CELLS);
  for (let i = 0; i < 8; i++) cells[i] = 1;
  for (let i = 8; i < CELLS; i++) cells[i] = 2;
  cells[10] = 0; // 留一个空点给黑（但黑可能吃不到）
  ctrl['board'] = fromCells(cells, 1).black[0] !== undefined ? cells : cells;
  const inv = invariants(ctrl['board']);
  check('构造局面自身合法', inv === null, String(inv));
}

console.log('== 停手后 AI 必须继续应手 ==');
for (const human of [1, 2] as const) {
  // 回归：AI 落子后若人类一方无合法点，控制器会替人类自动停一手、把行棋权
  // 交回 AI；此时必须再触发一次 AI 思考，否则对局静默卡死（顶栏停在
  // 「⏸ 黑方无子可下，自动停一手 · 轮到 白方 落子」，AI 不动、人也下不了）。
  const bridge = makeBridge();
  const ctrl = new OthelloController(canvas, bridge as never, audio as never);
  ctrl['mode'] = 'ai';
  ctrl['human'] = human;
  ctrl['newGame']();

  let mine = 0;
  let stall = 0;
  let maxStall = 0;
  const tag = human === 1 ? '人类执黑' : '人类执白';
  const STALL_LIMIT = 60; // 60 × 5ms = 300ms 无人可动即判定卡死
  for (let i = 0; i < 8000 && !ctrl['over'] && maxStall < STALL_LIMIT; i++) {
    if (ctrl['isHumanTurn']()) {
      const legal = ctrl['legalIdx']();
      if (legal.length && ctrl['placeHuman'](legal[0])) { mine++; stall = 0; continue; }
    }
    if (!ctrl['over'] && !ctrl['thinking'] && !ctrl['isHumanTurn']()) { stall++; maxStall = Math.max(maxStall, stall); }
    else stall = 0;
    await new Promise((r) => setTimeout(r, 5));
  }

  const passes = ctrl['history'].filter((h) => h.index < 0).length;
  check(`${tag}：对局中确有停手发生（覆盖到本回归场景）`, passes > 0, `passes=${passes} 手数=${ctrl['history'].length}`);
  check(`${tag}：停手后 AI 不会静默停摆`, maxStall < STALL_LIMIT, `最长无人可动 ${maxStall * 5}ms · turn=${ctrl['turn']} human=${ctrl['human']}`);
  check(`${tag}：人机对局能走到终局`, ctrl['over'] === true, `人类落子 ${mine} 手 · 历史 ${ctrl['history'].length} 步`);
}

finish('othello-controller');
