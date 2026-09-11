/* tornado 核心逻辑单测：成长公式、通关计数、可食性、screenToWorld */
import { TornadoGame, TIERS, TORNADO_VIEW } from '../src/tornado/game';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ok  ${msg}`); }
  else { fail++; console.error(`FAIL  ${msg}`); }
}

console.log('— TIERS 数据 —');
assert(TIERS.length === 6, '六个量级');
for (const t of TIERS) {
  const bait = t.pool.filter((p) => p.s < t.baseR);
  assert(bait.length >= 1, `${t.name}: 至少 1 个开局可食物 (${bait.length})`);
}

console.log('— 每关生成与通关进度 —');
for (let tier = 0; tier < TIERS.length; tier++) {
  const g = new TornadoGame();
  g.tier = tier;
  g.restartTier();
  assert(g.total === g.objects.length, `T${tier + 1} total 对齐实际生成数 ${g.total}`);
  assert(g.total > 0 && g.total <= TIERS[tier].count, `T${tier + 1} 生成数合理 ${g.total}`);
  const baitAlive = g.objects.filter((o) => !o.dead && o.r < g.r);
  assert(baitAlive.length >= 1, `T${tier + 1} 开局至少 1 个可吃`);
}

console.log('— 吃小成长 —');
{
  const g = new TornadoGame();
  g.reset();
  const r0 = g.r;
  const small = g.objects.filter((o) => !o.dead && o.r < g.r).sort((a, b) => a.r - b.r)[0];
  g.x = small.x; g.y = small.y;
  for (let i = 0; i < 30; i++) g.update(0.033, { kx: 0, ky: 0, tx: null, ty: null });
  assert(g.eaten >= 1, '吞掉至少 1 个物体');
  assert(g.r > r0, `体型增长 ${r0.toFixed(1)} → ${g.r.toFixed(1)}`);
}

console.log('— screenToWorld 与相机一致 —');
{
  const g = new TornadoGame();
  g.reset();
  g.x = g.world / 2; g.y = g.world / 2;
  const w = g.screenToWorld(TORNADO_VIEW / 2, TORNADO_VIEW / 2);
  assert(Math.abs(w.x - g.x) < 1 && Math.abs(w.y - g.y) < 1, '视心映射到玩家附近');
}

console.log('— 严格大于才可吃（相等弹开）—');
{
  const g = new TornadoGame();
  g.tier = 3; // 国家，baseR 53
  g.restartTier();
  const same = g.objects.find((o) => o.r >= g.r);
  if (same) {
    const r0 = g.r;
    g.x = same.x; g.y = same.y;
    for (let i = 0; i < 5; i++) g.update(0.033, { kx: 0, ky: 0, tx: null, ty: null });
    assert(!same.dead, '≥baseR 的物体不会被吞');
    assert(g.r === r0, '体型未因弹开增长');
  } else {
    assert(true, '本局无 ≥ baseR 物体（跳过）');
  }
}

console.log('— 地形覆盖与 R_MAX —');
{
  const g = new TornadoGame();
  g.tier = 5;
  g.restartTier();
  const world = g.world;
  let cover = 0;
  for (const t of g.terrain) cover += Math.PI * t.r * t.r;
  const ratio = cover / (world * world);
  assert(ratio < 0.18, `地球关障碍覆盖 ${(ratio * 100).toFixed(1)}% < 18%`);
  const maxTr = Math.max(...g.terrain.map((t) => t.r), 0);
  assert(maxTr <= 130, `障碍半径上限 ${maxTr.toFixed(0)} ≤ 130`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
