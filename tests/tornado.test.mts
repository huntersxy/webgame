/* tornado 核心逻辑单测：成长公式、通关计数、可食性、screenToWorld */
import { TornadoGame, TIERS, TORNADO_VIEW } from '../src/tornado/game';
import { assert, finish } from './harness.mts';


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

console.log('— 转场连续性（屏幕尺寸 / 世界偏移）—');
{
  // dispScreenR 就是屏幕上画出来的龙卷风半径：整个转场里它必须平滑，
  // 换手帧尤其不能跳——那正是玩家抱怨的「转场时突然缩一下」。
  const g = new TornadoGame();
  const DT = 1 / 60;
  let prevR = g.dispScreenR;
  let prevTier = g.tier;
  let prevState = g.state;
  let maxTargetErr = 0;     // 换手瞬间屏幕半径与下一关标称值的偏差
  let maxZoomStep = 0;      // 转场中单帧屏幕半径变化
  let maxHandoffStep = 0;   // 换手所在的那一帧
  let maxOffset = 0;
  let maxShiftStep = 0;
  let prevOff = { x: g.worldOffset.x, y: g.worldOffset.y };
  let sawZoom = false;
  let guard = 0;

  while (g.state !== 'win' && guard++ < 4000) {
    if (g.state === 'play') {
      for (const o of g.objects) if (!o.dead) { o.dead = true; g.eaten++; }
      g.r = Math.min(220, g.r + 6);        // 模拟稳定成长
      // 让龙卷风偏离世界中心：世界偏移补偿与相机连续性都要在偏心位置成立
      g.x = g.world / 2 + (guard % 7 - 3) * 60;
      g.y = g.world / 2 + (guard % 5 - 2) * 70;
    } else {
      sawZoom = true;
    }
    const rBefore = g.dispScreenR;
    const tierBefore = g.tier;
    g.update(DT, { kx: 0, ky: 0, tx: null, ty: null });
    const r = g.dispScreenR;

    if (tierBefore !== g.tier) {
      // 换手帧：屏幕半径应当正好落在新量级的标称值上（延续成立的充要条件）
      const nominal = TIERS[g.tier].baseR * TIERS[g.tier].camScale;
      maxTargetErr = Math.max(maxTargetErr, Math.abs(r - nominal));
      maxHandoffStep = Math.max(maxHandoffStep, Math.abs(r - rBefore));
    } else if (g.state === 'zoom' && prevState === 'zoom') {
      maxZoomStep = Math.max(maxZoomStep, Math.abs(r - rBefore));
    }
    maxOffset = Math.max(maxOffset, Math.hypot(g.worldOffset.x, g.worldOffset.y));
    maxShiftStep = Math.max(maxShiftStep, Math.hypot(g.worldOffset.x - prevOff.x, g.worldOffset.y - prevOff.y));
    prevR = r; prevTier = g.tier; prevState = g.state;
    prevOff = { x: g.worldOffset.x, y: g.worldOffset.y };
  }
  void prevR; void prevTier;

  assert(sawZoom, '确实经历了转场');
  assert(g.state === 'win', '连续通关最终到达 win');
  assert(g.tier === TIERS.length - 1, `最终量级 ${g.tier} = ${TIERS.length - 1}`);
  assert(maxTargetErr < 0.1, `换手瞬间落在下一关标称屏幕半径（最大偏差 ${maxTargetErr.toFixed(4)}px）`);
  assert(maxZoomStep < 0.6, `转场中屏幕半径逐帧平滑（最大 ${maxZoomStep.toFixed(3)}px/帧）`);
  assert(maxHandoffStep < 0.6, `换手帧屏幕半径不跳变（最大 ${maxHandoffStep.toFixed(3)}px）`);
  assert(maxOffset > 50, `换手时确实动用了世界偏移（峰值 ${maxOffset.toFixed(0)}）`);
  assert(maxShiftStep < maxOffset + 1, `世界偏移逐帧连续（最大 ${maxShiftStep.toFixed(1)}/帧）`);
  assert(Math.abs(g.worldOffset.x) < 1e-6 && Math.abs(g.worldOffset.y) < 1e-6, '通关后世界偏移归零');
  assert(Math.abs(g.viewScale - TIERS[TIERS.length - 1].camScale) < 1e-6, `通关后镜头比例尺回到末关值 ${g.viewScale.toFixed(4)}`);
  assert(Math.abs(g.dispScreenR - TIERS[TIERS.length - 1].baseR * TIERS[TIERS.length - 1].camScale) < 1e-6, '通关后屏幕半径 = 末关标称值');
}

console.log('— 屏幕尺度守恒与推远（各量级）—');
{
  // 每关开局：龙卷风屏幕半径从 22px 起，逐关额外推远 1.04 倍——
  // 幅度很小，所以「世界在收小」看得出来、「龙卷风突然缩放」看不出来。
  const perTier = 1.04;
  let prev = 0;
  for (let tier = 0; tier < TIERS.length; tier++) {
    const g = new TornadoGame();
    g.tier = tier;
    g.restartTier();
    const px = g.dispScreenR;
    const expect = 22 * Math.pow(perTier, tier);
    assert(Math.abs(px - expect) < 0.5, `T${tier + 1} 开局屏幕半径 ${px.toFixed(1)}px = 22·${perTier}^${tier}`);
    if (tier > 0) assert(px > prev, `T${tier + 1} 比上一关更推远（世界占比 ${prev.toFixed(1)} → ${px.toFixed(1)}px 屏幕半径）`);
    prev = px;
  }
  // 世界在屏幕上逐关收小＝镜头真的在推远，而不是越玩越近
  for (let tier = 0; tier + 1 < TIERS.length; tier++) {
    const w0 = TIERS[tier].camScale;
    const w1 = TIERS[tier + 1].camScale;
    assert(w1 < w0, `T${tier + 1}→T${tier + 2} 镜头确实推远（${w0.toFixed(3)} → ${w1.toFixed(3)}）`);
  }
  // 换手点：下一关标称屏幕半径 = 本关镜头再推远一档，龙卷风因此只差 4%
  for (let tier = 0; tier + 1 < TIERS.length; tier++) {
    const a = TIERS[tier].baseR * TIERS[tier].camScale;
    const b = TIERS[tier + 1].baseR * TIERS[tier + 1].camScale;
    assert(Math.abs(b / a - perTier) < 0.001, `T${tier + 1}→T${tier + 2} 换手屏幕半径比 ${(b / a).toFixed(4)} = ${perTier}`);
  }
}

console.log('— 转场必须交还操作权（state 回到 play）—');
{
  // 历史上换手发生在段中、却把 state 留在 zoom：玩家在新量级无法操作，
  // 残留下来的转场循环把后面所有量级连推到底——「进下一图瞬间吃完全部直接通关」。
  const g = new TornadoGame();
  for (const o of g.objects) { o.dead = true; g.eaten++; }
  assert(g.state === 'play', '清空前仍在 play（清空判定只在 update 里走）');
  let sawPlayBetweenZooms = false;
  let lastState = g.state;
  let guard = 0;
  while (g.state !== 'win' && guard++ < 6000) {
    if (g.state === 'play') {
      for (const o of g.objects) if (!o.dead) { o.dead = true; g.eaten++; }
      g.r = Math.min(220, g.r + 6);
    }
    g.update(1 / 60, { kx: 0, ky: 0, tx: null, ty: null });
    if (lastState === 'zoom' && g.state === 'play') sawPlayBetweenZooms = true;
    lastState = g.state;
  }
  assert(g.state === 'win', '最终通关');
  assert(sawPlayBetweenZooms, '每次转场结束后都会回到 play（而不是一路 zoom 到底）');
  assert(g.tier === TIERS.length - 1, `最终量级 ${g.tier}`);
}

console.log('— 地表与世界内容同步（同一相机变换）—');
{
  // 相机移动时，地表网格（格子）与建筑必须由同一支「世界 → 屏幕」变换投影。
  // 旧实现把地表当屏幕坐标画，格子钉在屏幕上、建筑跟着相机走，于是相对滑动。
  const el: any = { style: {}, width: 512, height: 512 };
  const noop = () => {};
  const ctx: any = {
    save: noop, restore: noop, clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, closePath: noop, arc: noop, ellipse: noop,
    roundRect: noop, fill: noop, stroke: noop, setLineDash: noop, fillText: noop, drawImage: noop,
    translate: noop, scale: noop, rotate: noop, setTransform: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', font: '', textAlign: '', textBaseline: '',
  };
  (el as any).getContext = () => ctx;      // 地面装饰的离屏画布
  (globalThis as any).document = { createElement: () => el };
  const g = new TornadoGame();
  const camAt = (px: number, py: number) => {
    g.x = px; g.y = py;
    g.render(ctx);
    return g.floorMatrix!;
  };
  const a = camAt(560, 560);
  const b = camAt(760, 560);
  assert(!!a && !!b, 'render 会记录地表所用的相机矩阵');

  // paint 的变换：translate(VIEW/2) → scale(s) → translate(-cam)
  const worldToScreen = (m: { a: number; d: number; e: number; f: number }, wx: number, wy: number) =>
    [m.a * wx + m.e, m.d * wy + m.f] as const;
  const s = 1;                                  // T1 的 camScale
  const paint = { a: s, d: s, e: 320 - 560 * s, f: 320 - 560 * s };
  const grid = worldToScreen(a, 260, 260);
  const building = worldToScreen(paint, 260, 260);
  assert(Math.abs(grid[0] - building[0]) < 1e-6 && Math.abs(grid[1] - building[1]) < 1e-6,
    `同一世界点：格子 (${grid[0]},${grid[1]}) 与建筑 (${building[0]},${building[1]}) 屏幕位置一致`);

  // 相机右移 200：同一世界点的屏幕位移必须是 -200px，两个层完全相同
  const gridB = worldToScreen(b, 260, 260);
  const buildingB = worldToScreen({ ...paint, e: 320 - 760 * s, f: 320 - 560 * s }, 260, 260);
  const gridShift = gridB[0] - grid[0];
  const buildingShift = buildingB[0] - building[0];
  assert(Math.abs(gridShift - (-200)) < 1e-6, `相机右移 200 → 格子屏幕位移 ${gridShift.toFixed(1)}px`);
  assert(Math.abs(buildingShift - (-200)) < 1e-6, `相机右移 200 → 建筑屏幕位移 ${buildingShift.toFixed(1)}px`);
  assert(Math.abs(gridShift - buildingShift) < 1e-6, '格子与建筑位移一致（无相对运动）');
}

console.log('— 粒子上限（防止越玩越卡）—');
{
  // 连续吃物体时粒子会堆积；早期每个粒子是一次 emoji fillText，
  // DPR2 下 300 个要 1.68ms（换成填充圆只要 0.16ms），于是越玩越卡。
  const g = new TornadoGame();
  (g as any).burst(100, 100, '🪨', 400);      // 一次爆 400 个，必须被截到上限
  const ps = (g as any).particles as Array<{ c: string }>;
  assert(ps.length <= 160, `粒子数被截到上限（${ps.length} ≤ 160）`);
  assert(ps.every((p) => typeof p.c === 'string' && p.c.length > 0), '每个粒子都带可直接填充的颜色（不再走 emoji 分支）');
  for (let i = 0; i < 20; i++) (g as any).burst(100, 100, '', 50);   // 反复爆量
  assert(ps.length <= 160, `反复爆量后仍在上限内（${ps.length}）`);
}

finish('tornado');
