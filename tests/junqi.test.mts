/* 军棋规则引擎自测：esbuild 打包后 node 运行 */
import {
  randomBoard, randomLayout, legalMoves, allJqMoves, resolve, hasAnyMove, isCamp, isHQ, sideOfNode, ADJ,
  idx, rowOf, colOf, canMoveType, validateLayout, layoutComplete, autofillLayout,
  makeJqMove, undoJqMove, ownHalf, DRAW_NO_CAPTURE, MAX_MOVES,
  type Board, type Piece, type Side, type PType,
} from '../src/junqi/rules';
import { findBestMove, evaluate, HIDDEN_VAL } from '../src/junqi/ai';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}
const mk = (side: Side, type: PType, id = 1): Piece => ({ id, side, type });
const empty = (): Board => new Array(60).fill(null);

// ── 布阵合法性 ──
console.log('== 布阵 ==');
{
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const b = randomBoard();
    const counts: Record<string, number> = {};
    let rFlagInHQ = false, bFlagInHQ = false;
    let mineOk = true, campOccupied = false, total = 0;
    for (let i = 0; i < 60; i++) {
      const p = b[i];
      if (!p) continue;
      total++;
      counts[p.side + p.type] = (counts[p.side + p.type] || 0) + 1;
      if (isCamp(i)) campOccupied = true;
      if (p.type === '军旗') {
        if (!isHQ(i)) mineOk = false;
        if (p.side === 'r') rFlagInHQ = true; else bFlagInHQ = true;
      }
      if (p.type === '地雷') {
        const r = rowOf(i);
        const back = p.side === 'r' ? r >= 10 : r <= 1;
        if (!back) mineOk = false;
      }
    }
    const want: Record<string, number> = {
      司令: 1, 军长: 1, 师长: 2, 旅长: 2, 团长: 2, 营长: 2, 连长: 3, 排长: 3, 工兵: 3, 炸弹: 2, 地雷: 3, 军旗: 1,
    };
    let countsOk = total === 50;
    for (const s of ['r', 'b'] as Side[]) for (const t in want) if (counts[s + t] !== want[t]) countsOk = false;
    if (!countsOk || !mineOk || campOccupied || !rFlagInHQ || !bFlagInHQ) bad++;
  }
  check('300 次随机布阵全部合法（数量/军旗入营/地雷后两行/行营空）', bad === 0, `bad=${bad}`);
}

// ── 铁路直线滑行 ──
console.log('== 铁路 ==');
{
  const b = empty();
  // 边列 0 是铁路，放一个师长在 (0,0)，前线 (5,0) 之间无阻挡
  b[idx(0, 0)] = mk('r', '师长');
  const mv = legalMoves(b, idx(0, 0));
  // 沿列 0 向下到 (4,0)（(5,0) 也是铁路但需连续；边列铁路贯穿全列）
  check('师长沿边列铁路长距离滑行', mv.includes(idx(3, 0)) && mv.includes(idx(5, 0)), JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
  // 铁路滑行不拐弯：可达本列任意远端，但邻列只能靠"公路一步"到 (0,1)，不能直达 (0,3)
  check('铁路不拐弯（不能横向直达远处）', !mv.includes(idx(0, 3)) && mv.includes(idx(0, 1)), JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
}
{
  const b = empty();
  b[idx(5, 1)] = mk('r', '旅长');
  b[idx(5, 3)] = mk('r', '排长');
  // (5,1) 沿前线铁路向右，被 (5,3) 挡住：可达 (5,2)、吃 (5,3)? 同方不可吃，故止于 (5,2)
  const mv = legalMoves(b, idx(5, 1));
  check('前线铁路被己方子阻挡', mv.includes(idx(5, 2)) && !mv.includes(idx(5, 4)), JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
}

// ── 工兵铁路拐弯 ──
console.log('== 工兵 ==');
{
  const b = empty();
  b[idx(0, 0)] = mk('r', '工兵');
  const mv = legalMoves(b, idx(0, 0));
  // 工兵可沿铁路网拐弯到达远处铁路节点，例如 (11,0) 或前线 (5,4)
  check('工兵铁路可拐弯到远端', mv.includes(idx(5, 4)) && mv.includes(idx(11, 0)), `${mv.length} 落点`);
}

// ── 公路一步 ──
console.log('== 公路 ==');
{
  const b = empty();
  b[idx(3, 2)] = mk('r', '连长'); // 中心行营，四斜（行营链）+四直邻
  const mv = legalMoves(b, idx(3, 2));
  check('普通子公路只走一步', mv.every((i) => Math.abs(rowOf(i) - 3) + Math.abs(colOf(i) - 2) <= 2) && mv.length <= 8 && mv.length >= 4, JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
}

// ── 行营保护 ──
console.log('== 行营 ==');
{
  const b = empty();
  b[idx(2, 1)] = mk('b', '排长');   // 蓝方行营内
  b[idx(1, 0)] = mk('r', '司令');    // 红方经斜线紧邻
  const mv = legalMoves(b, idx(1, 0));
  check('行营内敌子不可被攻击（斜线邻接）', !mv.includes(idx(2, 1)), JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
  const b2 = empty();
  b2[idx(4, 1)] = mk('b', '排长');   // 蓝方前线侧行营
  b2[idx(5, 0)] = mk('r', '司令');   // 红方前线角
  check('行营内敌子不可被攻击（前线斜线）', !legalMoves(b2, idx(5, 0)).includes(idx(4, 1)));
}

// ── 棋盘结构 ──
console.log('== 棋盘结构 ==');
{
  // 标准梅花行营：蓝方 2/3/4 排，红方镜像 9/8/7 排，各 5 个
  const blueCamps = [[2, 1], [2, 3], [3, 2], [4, 1], [4, 3]].map(([r, c]) => idx(r, c));
  const redCamps = [[9, 1], [9, 3], [8, 2], [7, 1], [7, 3]].map(([r, c]) => idx(r, c));
  const allCamps = [...blueCamps, ...redCamps];
  check('行营为标准梅花形（每方 5 个）', allCamps.every(isCamp) && [...Array(60).keys()].filter(isCamp).length === 10);
  // 行营不在大本营行、不在前线行
  check('行营不在前线/大本营排', allCamps.every((i) => rowOf(i) !== 5 && rowOf(i) !== 6 && rowOf(i) !== 0 && rowOf(i) !== 11));
  // 每方 16 条斜线：行营菱形四角各 4 条斜线（含边列节点 (3,0)/(3,4) 入营），中心 4 条
  const deg = (i: number) => ADJ[i].length;
  check('行营中心 (3,2)/(8,2) 有 8 条邻边（4 斜 + 4 直）', deg(idx(3, 2)) === 8 && deg(idx(8, 2)) === 8);
  check('行营四角各有 8 条邻边（4 斜 + 4 直）', [[2, 1], [2, 3], [4, 1], [4, 3]].every(([r, c]) => deg(idx(r, c)) === 8) && [[7, 1], [7, 3], [9, 1], [9, 3]].every(([r, c]) => deg(idx(r, c)) === 8));
  {
    // 斜线 = 非铁路且行/列同时变化的边；双向计数 64 = 每方 16 条
    let diag = 0;
    ADJ.forEach((edges, i) => edges.forEach((e) => {
      if (!e.rail && rowOf(i) !== rowOf(e.to) && colOf(i) !== colOf(e.to)) diag++;
    }));
    check('每方斜线恰 16 条（双向计数 64）', diag === 64, `diag=${diag}`);
  }
  // 前线角 (5,0) 应有斜线通 (4,1)；(1,0) 应有斜线通 (2,1)
  const hasEdge = (a: number, bb: number) => ADJ[a].some((e) => e.to === bb && !e.rail);
  check('前线与第 1 排都有斜线入行营', hasEdge(idx(5, 0), idx(4, 1)) && hasEdge(idx(1, 0), idx(2, 1)) && hasEdge(idx(6, 4), idx(7, 3)) && hasEdge(idx(10, 4), idx(9, 3)));
  // 边列节点 (3,0) 经斜线通向两营（行营逃逸线 / 边路入营）
  check('第 3 排边列节点双向斜线入营', hasEdge(idx(2, 1), idx(3, 0)) && hasEdge(idx(4, 1), idx(3, 0)) && hasEdge(idx(2, 3), idx(3, 4)) && hasEdge(idx(4, 3), idx(3, 4)));
  // 三座桥在第 1/3/5 列（0 起：0/2/4），其余列不能过河
  const cross = (c: number, rail: boolean) => ADJ[idx(5, c)].some((e) => e.to === idx(6, c) && e.rail === rail);
  const anyCross = (c: number) => ADJ[idx(5, c)].some((e) => e.to === idx(6, c));
  check('桥在第 1/3/5 列且为铁路', cross(0, true) && cross(2, true) && cross(4, true));
  check('第 2/4 列不能过河', !anyCross(1) && !anyCross(3));
  // 边列铁路贯穿全列（0→11 无缝）
  const railVert = (r: number, c: number) => ADJ[idx(r, c)].some((e) => e.to === idx(r + 1, c) && e.rail);
  check('边列铁路贯穿含河段', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((r) => railVert(r, 0) && railVert(r, 4)));
  // 边数总账：横向 12×4=48、纵向 53（河中只连第 1/3/5 列）、行营斜线 32
  {
    let rail = 0, plain = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      for (const e of ADJ[i]) {
        const key = i < e.to ? `${i}-${e.to}` : `${e.to}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (e.rail) rail++; else plain++;
      }
    }
    check('边总数 133（横向 48 + 纵向 53 + 斜线 32）', rail + plain === 133, `rail=${rail} plain=${plain}`);
    check('铁路 31 条（前线两行 8 + 左右边列 20 + 三座桥 3）', rail === 31, `rail=${rail}`);
    check('公路 102 条', plain === 102, `plain=${plain}`);
    // 铁路网必须连通，否则工兵无法全网机动
    const start = idx(5, 0);
    const vis = new Set<number>([start]);
    const q = [start];
    while (q.length) {
      const n = q.shift()!;
      for (const e of ADJ[n]) if (e.rail && !vis.has(e.to)) { vis.add(e.to); q.push(e.to); }
    }
    let railNodes = 0;
    for (let i = 0; i < 60; i++) if (ADJ[i].some((e) => e.rail)) railNodes++;
    check('铁路节点 30 且全网连通', railNodes === 30 && vis.size === 30, `节点=${railNodes} 连通=${vis.size}`);
  }
  // 每方 25 个可布子点（6 行 × 5 列 − 5 行营），与 25 枚编制吻合
  check('可布子点共 50（每方 25）', [...Array(60).keys()].filter((i) => !isCamp(i)).length === 50);
}

// ── 战斗结算 ──
console.log('== 战斗 ==');
{
  check('大吃小', resolve(mk('r', '师长'), mk('b', '旅长')).d === true);
  check('小撞大吃人', resolve(mk('r', '旅长'), mk('b', '师长')).a === true);
  check('同级同尽', (() => { const r = resolve(mk('r', '团长'), mk('b', '团长')); return r.a && r.d; })());
  check('炸弹互炸', (() => { const r = resolve(mk('r', '炸弹'), mk('b', '司令')); return r.a && r.d; })());
  check('司令撞炸弹同尽', (() => { const r = resolve(mk('r', '司令'), mk('b', '炸弹')); return r.a && r.d; })());
  check('工兵挖雷', (() => { const r = resolve(mk('r', '工兵'), mk('b', '地雷')); return !r.a && r.d; })());
  check('非工兵撞雷亡', (() => { const r = resolve(mk('r', '司令'), mk('b', '地雷')); return r.a && !r.d; })());
  check('扛旗', resolve(mk('r', '排长'), mk('b', '军旗')).flag === true);
  check('工兵是最弱子（攻排长告负）', (() => { const r = resolve(mk('r', '工兵'), mk('b', '排长')); return r.a && !r.d; })());
  check('大小顺序链完整（司令→…→工兵 逐级压制）', (() => {
    const order: PType[] = ['司令', '军长', '师长', '旅长', '团长', '营长', '连长', '排长', '工兵'];
    return order.every((t, k) => {
      if (k + 1 >= order.length) return true;
      const r = resolve(mk('r', t), mk('b', order[k + 1]));
      return !r.a && r.d;
    });
  })());
}

// ── 不可动子 ──
{
  check('地雷/军旗不可动', !canMoveType('地雷') && !canMoveType('军旗') && canMoveType('工兵'));
}

// ── 大本营驻子不可动 ──
console.log('== 大本营 ==');
{
  const b = empty();
  b[idx(11, 3)] = mk('r', '师长'); // 非军旗驻大本营 (11,3)
  check('大本营驻子不可移动', legalMoves(b, idx(11, 3)).length === 0);
  b[idx(10, 3)] = mk('b', '排长');
  check('大本营驻子仍可被吃', legalMoves(b, idx(10, 3)).includes(idx(11, 3)));
  // 只有旗与雷时仍判无子可动（大本营驻子等同）
  const b2 = empty();
  b2[idx(11, 1)] = mk('r', '军旗');
  b2[idx(11, 3)] = mk('r', '司令'); // 驻大本营，动不了
  b2[idx(0, 2)] = mk('b', '司令');
  check('只剩大本营驻子判无子可动', !hasAnyMove(b2, 'r') && hasAnyMove(b2, 'b'));
}

// ── 无子可动判定 ──
console.log('== 绝杀 ==');
{
  const b = empty();
  b[idx(11, 1)] = mk('r', '军旗');
  b[idx(11, 2)] = mk('r', '地雷');
  b[idx(0, 2)] = mk('b', '司令');
  check('只剩旗雷判无子可动', !hasAnyMove(b, 'r') && hasAnyMove(b, 'b'));
}

// ── 布阵校验 / 补全 ──
console.log('== 摆阵校验 ==');
{
  // 合法随机布阵 → 校验通过且完整
  let okAll = true;
  for (let k = 0; k < 100; k++) {
    const b = randomBoard();
    for (const s of ['r', 'b'] as Side[]) {
      if (validateLayout(b, s) !== null || !layoutComplete(b, s)) okAll = false;
    }
  }
  check('随机布阵通过校验且完整', okAll);
  // 违规：军旗不在大本营
  const b1 = randomBoard();
  const rFlag = b1.findIndex((p) => p?.side === 'r' && p.type === '军旗')!;
  b1[rFlag] = null;
  b1[idx(6, 0)] = { id: 99, side: 'r', type: '军旗' };
  check('军旗不在大本营被拒', validateLayout(b1, 'r') !== null && !layoutComplete(b1, 'r'));
  // 违规：地雷放前排（第 6 排非后两排）
  const b2 = randomBoard();
  const rMine = b2.findIndex((p) => p?.side === 'r' && p.type === '地雷')!;
  const mineT = b2[rMine]!;
  b2[rMine] = null;
  b2[idx(6, 2)] = mineT;
  check('地雷出后两排被拒', validateLayout(b2, 'r') !== null);
  // 违规：炸弹进第一排
  const b3 = randomBoard();
  const rBomb = b3.findIndex((p) => p?.side === 'r' && p.type === '炸弹')!;
  const bombT = b3[rBomb]!;
  b3[rBomb] = null;
  b3[idx(6, 4)] = bombT;
  check('炸弹进第一排被拒', validateLayout(b3, 'r') !== null);
  // 部分布阵 → 补全后完整且合法
  let fillOk = true;
  for (let k = 0; k < 100; k++) {
    const b = new Array(60).fill(null) as Board;
    // 随手放 6 个普通子（避开行营与大本营）
    const spots: Array<[number, number]> = [[6, 0], [6, 2], [7, 0], [7, 2], [9, 0], [9, 4]];
    const types: PType[] = ['司令', '军长', '师长', '旅长', '团长', '营长'];
    spots.forEach(([r, c], k2) => { b[idx(r, c)] = { id: k2, side: 'r', type: types[k2] }; });
    const err = autofillLayout(b, 'r');
    if (err !== null || !layoutComplete(b, 'r')) fillOk = false;
  }
  check('部分布阵补全 100 次全部合法', fillOk);
  // 大本营全被占 → 补全报错
  const b4 = new Array(60).fill(null) as Board;
  b4[idx(11, 1)] = { id: 1, side: 'r', type: '司令' };
  b4[idx(11, 3)] = { id: 2, side: 'r', type: '军长' };
  check('大本营被占时补全报错', autofillLayout(b4, 'r') !== null);
}

// ── 可逆走子（搜索基元） ──
console.log('== 可逆走子 ==');
{
  // 可逆走子：每步先存快照，make→undo 后必须与快照一致，再重新执行推进局面
  let ok = true;
  for (let k = 0; k < 200; k++) {
    const b = randomBoard();
    for (let step = 0; step < 8; step++) {
      const side: Side = step % 2 === 0 ? 'b' : 'r';
      const ms = allJqMoves(b, side);
      if (!ms.length) break;
      const m = ms[(Math.random() * ms.length) | 0];
      const before = b.map((p) => (p ? { ...p } : null));
      const rec = makeJqMove(b, m.from, m.to);
      undoJqMove(b, rec);
      for (let i = 0; i < 60; i++) {
        const a = b[i], e = before[i];
        if ((a && !e) || (!a && e) || (a && e && (a.type !== e.type || a.side !== e.side || !!a.hidden !== !!e.hidden))) { ok = false; break; }
      }
      if (!ok) break;
      makeJqMove(b, m.from, m.to); // 推进局面
    }
    if (!ok) break;
  }
  check('200 局随机走子 make/undo 完全还原', ok);
}

// ── 揭棋（暗棋） ──
console.log('== 揭棋 ==');
{
  // 揭棋只改信息可见性，不改走法：暗置工兵依然可拐弯
  const b = empty();
  b[idx(0, 0)] = { ...mk('r', '工兵'), hidden: true };
  const mv = legalMoves(b, idx(0, 0));
  check('揭棋暗置工兵走法不变（可拐弯）', mv.includes(idx(5, 4)) && mv.includes(idx(11, 0)), `${mv.length} 落点`);
  // 交战翻明：双方同时翻明，undo 完整还原
  const bc = empty();
  const att = { ...mk('r', '师长'), hidden: true };
  const def = { ...mk('b', '连长'), hidden: true };
  bc[idx(6, 0)] = att;   // (6,0)-(5,0) 为桥（铁路）
  bc[idx(5, 0)] = def;
  const recC = makeJqMove(bc, idx(6, 0), idx(5, 0));
  check('交战双方同时翻明', !att.hidden && !def.hidden && recC.attHidden1 === false && recC.defHidden1 === false);
  check('吃子结果正确', !recC.attOut && recC.defOut);
  undoJqMove(bc, recC);
  check('undo 还原翻明位', att.hidden === true && def.hidden === true);
  // 静默移动不翻明
  const bq = empty();
  const mover = { ...mk('r', '师长'), hidden: true };
  bq[idx(6, 0)] = mover;
  makeJqMove(bq, idx(6, 0), idx(6, 1)); // 前线铁路安静走一步
  check('静默移动不翻明', mover.hidden === true);
  // 司令阵亡 → 军旗亮出，undo 还原
  const bf = empty();
  const cmd = { ...mk('r', '司令'), hidden: true };
  bf[idx(6, 0)] = cmd;
  bf[idx(5, 0)] = mk('b', '炸弹');
  bf[idx(11, 1)] = { ...mk('r', '军旗'), hidden: true };
  const recF = makeJqMove(bf, idx(6, 0), idx(5, 0)); // 司令撞炸弹同尽 → 红旗亮出
  check('司令阵亡亮军旗', recF.revealedFlags.length === 1 && recF.revealedFlags[0].side === 'r' && recF.revealedFlags[0].hidden === false && recF.flagNodes[0] === idx(11, 1));
  // 司令对司令同归于尽：两面军旗都要亮
  const bMut: Board = empty();
  bMut[idx(11, 1)] = { ...mk('r', '军旗'), id: 11, hidden: true };
  bMut[idx(0, 1)] = { ...mk('b', '军旗'), id: 12, hidden: true };
  bMut[idx(5, 2)] = { ...mk('r', '司令'), id: 13, hidden: true };
  bMut[idx(6, 2)] = { ...mk('b', '司令'), id: 14, hidden: true };
  const recMut = makeJqMove(bMut, idx(5, 2), idx(6, 2));
  check('双方司令同归于尽 → 两面军旗都亮',
    recMut.attOut && recMut.defOut && recMut.revealedFlags.length === 2
    && bMut[idx(11, 1)]!.hidden === false && bMut[idx(0, 1)]!.hidden === false,
    `亮旗 ${recMut.revealedFlags.length}`);
  undoJqMove(bMut, recMut);
  check('同归于尽后 undo 两面军旗都还原',
    bMut[idx(11, 1)]!.hidden === true && bMut[idx(0, 1)]!.hidden === true);
  undoJqMove(bf, recF);
  check('undo 还原军旗 hidden', bf[idx(11, 1)]!.hidden === true);
  // 和棋常量
  check('无吃子判和步数 = 120 / 总手数 = 500', DRAW_NO_CAPTURE === 120 && MAX_MOVES === 500);
  // 揭棋评估：轮走方始终知晓己方棋子，暗置不改变己方估值
  const bh = empty();
  bh[idx(11, 1)] = { ...mk('r', '司令'), hidden: true };
  bh[idx(0, 1)] = mk('b', '司令');
  const bo = empty();
  bo[idx(11, 1)] = mk('r', '司令');
  bo[idx(0, 1)] = mk('b', '司令');
  // 红司令(11,1) adv=5 → +5×3×0.3=+4.5；蓝司令(0,1) 同；双方抵消为 0
  check('揭棋轮走方知晓己方子力（己方暗置不影响估值）',
    evaluate(bh, 'r') === evaluate(bo, 'r') && evaluate(bo, 'r') === 0,
    `hidden=${evaluate(bh, 'r')} open=${evaluate(bo, 'r')}`);
  // 对方暗子：子力按真值计（阵亡翻明是公开事件 ⇒ 双方剩余子力是公开信息），
  // 但位置项不套用其真实兵种——旧实现整枚按 HIDDEN_VAL≈210 计，是主要偏差来源
  const solo = empty();
  solo[idx(5, 2)] = { ...mk('r', '司令'), hidden: true };
  check('揭棋暗子不再按期望子力值低估（己方视角）', evaluate(solo, 'r') > 590, `v=${evaluate(solo, 'r')}`);
  check('揭棋暗子不再按期望子力值低估（对方视角）', evaluate(solo, 'b') > 590, `v=${evaluate(solo, 'b')}`);
}

// ── AI 自对弈 ──
console.log('== AI ==');
{
  // 合法性：AI 返回的走法必须在合法走法表内
  let legal = true;
  for (let k = 0; k < 8; k++) {
    const b = randomBoard();
    const res = findBestMove(b, 'r', 2, 'ai', false, 0);
    if (!res.move) { legal = false; break; }
    if (!allJqMoves(b, 'r').some((m) => m.from === res.move!.from && m.to === res.move!.to)) legal = false;
  }
  check('AI 走法全部合法（8 局抽查）', legal);
  // 完整对弈：普通 AI 互搏 60 手不崩、不返回空着
  const b = randomBoard();
  let turn: Side = 'r';
  let plies = 0;
  let ended = false;
  const t0 = Date.now();
  while (plies < 60) {
    if (!hasAnyMove(b, turn)) { ended = true; break; }
    const res = findBestMove(b, turn, 1, 'aivai', false, plies);
    if (!res.move) { ended = true; break; }
    const ms = allJqMoves(b, turn);
    if (!ms.some((m) => m.from === res.move!.from && m.to === res.move!.to)) { legal = false; break; }
    makeJqMove(b, res.move.from, res.move.to);
    turn = turn === 'r' ? 'b' : 'r';
    plies++;
  }
  const dt = Date.now() - t0;
  check('简单 AI 互搏 60 手全程合法', legal && plies >= 60, `plies=${plies}`);
  check('简单 AI 单步耗时 < 900ms（60 手共 ' + dt + 'ms）', dt < 54000);
  // 揭棋模式自对弈 20 手
  const b2 = randomBoard();
  for (const p of b2) if (p) p.hidden = true;
  let t2: Side = 'r';
  let ok2 = true;
  for (let i = 0; i < 20 && hasAnyMove(b2, t2); i++) {
    const res = findBestMove(b2, t2, 2, 'ai', true, i);
    if (!res.move) break;
    makeJqMove(b2, res.move.from, res.move.to);
    t2 = t2 === 'r' ? 'b' : 'r';
  }
  check('揭棋 AI 自对弈 20 手不崩', ok2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
