/* 军棋规则引擎自测：esbuild 打包后 node 运行 */
import {
  randomBoard, randomLayout, legalMoves, allJqMoves, resolve, hasAnyMove, isCamp, isHQ, sideOfNode,
  idx, rowOf, colOf, canMoveType, validateLayout, layoutComplete, autofillLayout,
  makeJqMove, undoJqMove, ownHalf,
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
  b[idx(2, 2)] = mk('r', '连长'); // 中心行营，四斜+四直邻
  const mv = legalMoves(b, idx(2, 2));
  check('普通子公路只走一步', mv.every((i) => Math.abs(rowOf(i) - 2) + Math.abs(colOf(i) - 2) <= 2) && mv.length <= 8 && mv.length >= 4, JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
}

// ── 行营保护 ──
console.log('== 行营 ==');
{
  const b = empty();
  b[idx(2, 2)] = mk('b', '排长');   // 蓝方行营内
  b[idx(3, 1)] = mk('r', '司令');    // 红方紧邻
  const mv = legalMoves(b, idx(3, 1));
  check('行营内敌子不可被攻击', !mv.includes(idx(2, 2)), JSON.stringify(mv.map(i => [rowOf(i), colOf(i)])));
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
}

// ── 不可动子 ──
{
  check('地雷/军旗不可动', !canMoveType('地雷') && !canMoveType('军旗') && canMoveType('工兵'));
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
    // 随手放 6 个普通子
    const types: PType[] = ['司令', '军长', '师长', '旅长', '团长', '营长'];
    types.forEach((t, k2) => { b[idx(6 + (k2 % 4), k2 % 5)] = { id: k2, side: 'r', type: t }; });
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
  // 揭棋评估：暗子按期望值计（不享受前进加分；明子正常计）
  const bh = empty();
  bh[idx(11, 1)] = { ...mk('r', '司令'), hidden: true };
  bh[idx(0, 1)] = mk('b', '司令');
  const bo = empty();
  bo[idx(11, 1)] = mk('r', '司令');
  bo[idx(0, 1)] = mk('b', '司令');
  const evHidden = evaluate(bh, true);
  const evOpen = evaluate(bo, false);
  // 红司令(11,1) adv=5 → +15；蓝司令(0,1) adv=5 → +15；双方明司令抵消为 0
  const expHidden = HIDDEN_VAL - (600 + 15);
  check('揭棋暗子按期望值评估', evOpen === 0 && Math.abs(evHidden - expHidden) < 0.01, `hidden=${evHidden} open=${evOpen} exp=${expHidden}`);
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
