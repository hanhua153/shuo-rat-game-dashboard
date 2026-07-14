const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const CONFIG = {
  baseUrl: 'https://grasp-rat-game.h-e.top',
  port: 18777
};

function curlText(url) {
  const args = [
    '-L', '--silent', '--show-error', '--fail',
    '--connect-timeout', '10', '--max-time', '60',
    '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--compressed',
    '--noproxy', '*',
    '-H', 'User-Agent: Mozilla/5.0 rat-game-dashboard',
    '-H', 'Accept: application/json,text/plain,*/*',
    '-H', 'Cache-Control: no-store'
  ];
  args.push(url);
  return execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function fetchJson(url) {
  return JSON.parse(curlText(url));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function dropOf(e) { return Number(e.death_reward_preview ?? e.death_drop_coins ?? 0); }
function mmToM(v) { return Number(v || 0) / 1000; }
function keyOf(e) { return String(e.user_id || e.entity_id || `${e.name}:${e.x}:${e.y}`); }
function nameOf(e) { return e.name || `User ${e.user_id || '?'}`; }
function isSelfPlayer(e, selfNames = [], selfUserIds = []) {
  const n = String(nameOf(e)).trim().toLowerCase();
  const uid = String(e && e.user_id != null ? e.user_id : '');
  return selfNames.includes(n) || selfUserIds.includes(uid);
}
function dist(a, b) { return Math.hypot(a.mx - b.mx, a.my - b.my); }
function isOnlineBySta(e) { return Number(e.stamina_5s_remaining_milli || 10000) < 10000; }
function moved(a, b, epsMm) { return Math.abs(Number(a.x)-Number(b.x)) > epsMm || Math.abs(Number(a.y)-Number(b.y)) > epsMm; }
function pointFromEntity(e, status) {
  return { id: keyOf(e), name: nameOf(e), user_id: e.user_id, x: Number(e.x), y: Number(e.y), mx: mmToM(e.x), my: mmToM(e.y), drop: dropOf(e), hp: e.hp, sta: Number(e.stamina_5s_remaining_milli || 10000), status };
}
function routeLen(route, start) {
  let total = 0, prev = start || null;
  for (const p of route) { if (prev) total += dist(prev, p); prev = p; }
  return total;
}
function routeDrop(route) { return route.reduce((s, p) => s + p.drop, 0); }
function pointSegmentDist(p, a, b) {
  const vx = b.mx - a.mx, vy = b.my - a.my;
  const wx = p.mx - a.mx, wy = p.my - a.my;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return dist(p, a);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return dist(p, b);
  const t = c1 / c2;
  return Math.hypot(p.mx - (a.mx + t * vx), p.my - (a.my + t * vy));
}
function routeAddonPlayers(route, addonPool, corridorWidthM, start) {
  if (!route.length) return [];
  const half = corridorWidthM / 2;
  const routeIds = new Set(route.map(p => p.id));
  const nodes = start ? [start, ...route] : route;
  return addonPool.filter(p => {
    if (routeIds.has(p.id)) return false;
    if (nodes.length === 1) return dist(p, nodes[0]) <= half;
    for (let i = 1; i < nodes.length; i++) {
      if (pointSegmentDist(p, nodes[i - 1], nodes[i]) <= half) return true;
    }
    return false;
  });
}
function prefilterAddonPool(addonPool, mainPoints, maxLen, start) {
  const anchors = start ? [start, ...mainPoints] : mainPoints;
  return addonPool
    .filter(p => anchors.some(a => dist(p, a) <= Math.min(maxLen, 350)))
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 160);
}
function routeScore(route, addonPool, corridorWidthM, start) {
  const addon = routeAddonPlayers(route, addonPool, corridorWidthM, start);
  const mainDrop = routeDrop(route);
  const addonDrop = routeDrop(addon);
  return { mainDrop, addonDrop, totalDrop: mainDrop + addonDrop, addon };
}
function segmentSafe(a, b, forbiddenZones, allowOriginDeparture = false) {
  return !forbiddenZones.some(z => {
    // A start inside the origin area must be allowed to leave it. Other route
    // segments still cannot enter/cross the origin area.
    if (allowOriginDeparture && z.type === 'origin' && dist(a, z) <= z.radius) return false;
    return pointSegmentDist(z, a, b) <= z.radius;
  });
}
function routeSafe(route, start, forbiddenZones) {
  if (!route.length) return true;
  const ids = route.map(p => p.id);
  if (new Set(ids).size !== ids.length) return false;
  const nodes = start ? [start, ...route] : route;
  for (const p of route) {
    if (forbiddenZones.some(z => dist(p, z) <= z.radius)) return false;
  }
  for (let i = 1; i < nodes.length; i++) {
    if (!segmentSafe(nodes[i - 1], nodes[i], forbiddenZones, i === 1 && Boolean(start))) return false;
  }
  return true;
}
function isBetterRoute(a, b, start, addonPool = [], corridorWidthM = 50, scoreCache = new Map()) {
  if (!a) return true;
  const score = (route) => {
    const key = route.map(p => p.id).join('>');
    if (!scoreCache.has(key)) scoreCache.set(key, routeScore(route, addonPool, corridorWidthM, start));
    return scoreCache.get(key);
  };
  const as = score(a);
  const bs = score(b);
  if (bs.totalDrop !== as.totalDrop) return bs.totalDrop > as.totalDrop;
  if (bs.mainDrop !== as.mainDrop) return bs.mainDrop > as.mainDrop;
  const al = routeLen(a, start), bl = routeLen(b, start);
  if (Math.abs(al - bl) > 1e-9) return bl < al;
  return b.length > a.length;
}
function chooseDirection(route) {
  if (route.length <= 1) return route;
  const rev = [...route].reverse();
  for (let i = 0; i < route.length; i++) {
    const a = route.slice(0, i + 1).reduce((s, p) => s + p.drop, 0);
    const b = rev.slice(0, i + 1).reduce((s, p) => s + p.drop, 0);
    if (a !== b) return a > b ? route : rev;
  }
  return route[0].drop >= rev[0].drop ? route : rev;
}
function greedyRoute(candidates, maxLen, start, addonPool, corridorWidthM, forbiddenZones) {
  let route = [];
  let bestScore = routeScore(route, addonPool, corridorWidthM, start).totalDrop;
  while (true) {
    let best = null;
    for (const p of candidates) {
      if (route.some(x => x.id === p.id)) continue;
      const prev = route.length ? route[route.length - 1] : start;
      if (prev && !segmentSafe(prev, p, forbiddenZones)) continue;
      const cand = [...route, p];
      if (!routeSafe(cand, start, forbiddenZones)) continue;
      const len = routeLen(cand, start);
      if (len > maxLen + 1e-9) continue;
      const score = routeScore(cand, addonPool, corridorWidthM, start).totalDrop;
      const gain = score - bestScore;
      if (gain <= 0) continue;
      const step = prev ? dist(prev, p) : 0;
      if (!best || gain > best.gain || (gain === best.gain && step < best.step) || (gain === best.gain && step === best.step && p.drop > best.point.drop)) {
        best = { point: p, gain, step, score };
      }
    }
    if (!best) break;
    route.push(best.point);
    bestScore = best.score;
  }
  return route;
}
function nodeSwapOpt(route, candidates, start, maxLen, addonPool, corridorWidthM, forbiddenZones) {
  if (!route.length) return route;
  const fullScore = (r) => routeScore(r, addonPool, corridorWidthM, start).totalDrop;
  const routeIds = new Set(route.map(p => p.id));
  const outside = candidates.filter(p => !routeIds.has(p.id) && !forbiddenZones.some(z => dist(p, z) <= z.radius));
  let best = route.slice();
  let bestVal = fullScore(best);
  let swapped = true;
  let iters = 0;
  while (swapped && iters < 60) {
    swapped = false;
    iters++;
    for (let ri = 0; ri < best.length; ri++) {
      for (const np of outside) {
        const cand = best.slice();
        cand[ri] = np;
        if (new Set(cand.map(p => p.id)).size !== cand.length) continue;
        if (!routeSafe(cand, start, forbiddenZones)) continue;
        if (routeLen(cand, start) > maxLen + 1e-9) continue;
        const val = fullScore(cand);
        if (val > bestVal + 1e-9) { best = cand; bestVal = val; swapped = true; }
        else if (Math.abs(val - bestVal) < 1e-9) {
          const cl = routeLen(cand, start), bl = routeLen(best, start);
          if (cl < bl - 1e-9) { best = cand; swapped = true; }
        }
      }
    }
    for (const np of outside) {
      if (best.some(p => p.id === np.id)) continue;
      const cand = [...best, np];
      if (!routeSafe(cand, start, forbiddenZones)) continue;
      if (routeLen(cand, start) > maxLen + 1e-9) continue;
      const val = fullScore(cand);
      if (val > bestVal + 1e-9) { best = cand; bestVal = val; swapped = true; }
    }
  }
  return best;
}
function optimize2opt(route, start, maxLen, addonPool, corridorWidthM, forbiddenZones) {
  if (route.length <= 2) return route;
  const totalLen = (r) => routeLen(r, start);
  const fullScore = (r) => routeScore(r, addonPool, corridorWidthM, start).totalDrop;
  let best = route.slice();
  let bestVal = fullScore(best);
  let improved = true;
  let iters = 0;
  while (improved && iters < 500) {
    improved = false;
    iters++;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        if (!routeSafe(cand, start, forbiddenZones)) continue;
        if (totalLen(cand) > maxLen + 1e-9) continue;
        const val = fullScore(cand);
        if (val > bestVal + 1e-9) { best = cand; bestVal = val; improved = true; }
        else if (Math.abs(val - bestVal) < 1e-9) {
          const cl = totalLen(cand), bl = totalLen(best);
          if (cl < bl - 1e-9) { best = cand; improved = true; }
        }
      }
    }
  }
  return best;
}
function planRoute(points, maxLen, start, addonPool = [], corridorWidthM = 50, forbiddenZones = []) {
  const candidates = points.filter(p => !forbiddenZones.some(z => dist(p, z) <= z.radius));
  const byDrop = [...candidates].sort((a, b) => b.drop - a.drop);
  const byDensity = [...candidates].sort((a, b) => {
    const da = start ? dist(start, a) : Math.hypot(a.mx, a.my);
    const db = start ? dist(start, b) : Math.hypot(b.mx, b.my);
    return (b.drop / Math.max(db, 1)) - (a.drop / Math.max(da, 1));
  });
  const byNear = [...candidates].sort((a, b) => {
    const da = start ? dist(start, a) : Math.hypot(a.mx, a.my);
    const db = start ? dist(start, b) : Math.hypot(b.mx, b.my);
    return da - db;
  });
  const strategies = [byDrop, byDensity, byNear];
  let overallBest = [];
  let overallBestVal = 0;
  for (const strat of strategies) {
    let r = greedyRoute(strat, maxLen, start, addonPool, corridorWidthM, forbiddenZones);
    r = nodeSwapOpt(r, candidates, start, maxLen, addonPool, corridorWidthM, forbiddenZones);
    r = optimize2opt(r, start, maxLen, addonPool, corridorWidthM, forbiddenZones);
    const val = routeScore(r, addonPool, corridorWidthM, start).totalDrop;
    if (val > overallBestVal + 1e-9) { overallBest = r; overallBestVal = val; }
  }
  return start ? overallBest : chooseDirection(overallBest);
}
function safeCheckRoute(route, start, forbiddenZones, maxLen) {
  if (!route.length) return { ok: false, reason: '还没有选择自定义路径节点' };
  for (const p of route) {
    const zone = forbiddenZones.find(z => dist(p, z) <= z.radius);
    if (zone) return { ok: false, reason: `节点 ${p.name} 位于禁区内：${zone.name || zone.id}` };
  }
  const nodes = start ? [start, ...route] : route;
  for (let i = 1; i < nodes.length; i++) {
    const zone = forbiddenZones.find(z => pointSegmentDist(z, nodes[i - 1], nodes[i]) <= z.radius);
    if (zone) return { ok: false, reason: `线段 ${nodes[i - 1].name || '起点'} → ${nodes[i].name} 会穿过禁区：${zone.name || zone.id}` };
  }
  const len = routeLen(route, start);
  if (len > maxLen + 1e-9) return { ok: false, reason: `自定义路径距离 ${Math.round(len * 10) / 10}m 超过路线最大距离 ${maxLen}m` };
  return { ok: true, reason: '' };
}
function solveBestCustomRoute(points, start, forbiddenZones, maxLen, addonPool = [], corridorWidthM = 50) {
  const n = points.length;
  if (!n) return { route: [], ok: false, reason: '还没有选择自定义路径节点' };
  if (n > 16) return { route: [], ok: false, reason: `自定义节点数量 ${n} 个，超过当前精确计算上限 16 个，请减少节点后再计算` };
  for (const p of points) {
    const zone = forbiddenZones.find(z => dist(p, z) <= z.radius);
    if (zone) return { route: [], ok: false, reason: `节点 ${p.name} 位于禁区内：${zone.name || zone.id}` };
  }
  const edge = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && segmentSafe(points[i], points[j], forbiddenZones)) edge[i][j] = dist(points[i], points[j]);
    }
  }
  const startEdge = Array(n).fill(0);
  if (start) {
    for (let i = 0; i < n; i++) startEdge[i] = segmentSafe(start, points[i], forbiddenZones) ? dist(start, points[i]) : Infinity;
  }
  const full = (1 << n) - 1;
  const dp = Array.from({ length: 1 << n }, () => Array(n).fill(Infinity));
  const prev = Array.from({ length: 1 << n }, () => Array(n).fill(-1));
  for (let i = 0; i < n; i++) dp[1 << i][i] = start ? startEdge[i] : 0;
  for (let mask = 1; mask <= full; mask++) {
    for (let last = 0; last < n; last++) {
      const cur = dp[mask][last];
      if (!Number.isFinite(cur) || cur > maxLen + 1e-9) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const d = edge[last][next];
        if (!Number.isFinite(d)) continue;
        const nm = mask | (1 << next);
        const nd = cur + d;
        if (nd < dp[nm][next]) { dp[nm][next] = nd; prev[nm][next] = last; }
      }
    }
  }
  let best = null;
  for (let mask = 1; mask <= full; mask++) {
    let bestLast = -1, bestLen = Infinity;
    for (let i = 0; i < n; i++) if (dp[mask][i] < bestLen) { bestLen = dp[mask][i]; bestLast = i; }
    if (bestLast < 0 || !Number.isFinite(bestLen) || bestLen > maxLen + 1e-9) continue;
    const order = [];
    let walkMask = mask, cur = bestLast;
    while (cur >= 0) {
      order.push(cur);
      const p = prev[walkMask][cur];
      walkMask ^= (1 << cur);
      cur = p;
    }
    const route = order.reverse().map(i => points[i]);
    if (!routeSafe(route, start, forbiddenZones)) continue;
    const score = routeScore(route, addonPool, corridorWidthM, start);
    if (!best || score.totalDrop > best.score.totalDrop ||
        (score.totalDrop === best.score.totalDrop && score.mainDrop > best.score.mainDrop) ||
        (score.totalDrop === best.score.totalDrop && score.mainDrop === best.score.mainDrop && bestLen < best.length)) {
      best = { route, length: bestLen, score };
    }
  }
  if (!best) return { route: [], ok: false, reason: `没有任何已选节点能在 ${maxLen} 体力内安全到达` };
  return { ...best, ok: true, reason: '', skipped: n - best.route.length };
}

function clusterPoints(points, radiusM) {
  const clusters = [];
  const sorted = [...points].sort((a,b)=>b.drop-a.drop);
  for (const p of sorted) {
    let c = clusters.find(c => c.members.some(m => dist(m, p) <= radiusM));
    if (!c) { c = { members: [], mx: p.mx, my: p.my, drop: 0, statuses: new Set() }; clusters.push(c); }
    c.members.push(p);
    c.drop += p.drop;
    c.statuses.add(p.status);
    c.mx = c.members.reduce((s,m)=>s+m.mx,0)/c.members.length;
    c.my = c.members.reduce((s,m)=>s+m.my,0)/c.members.length;
  }
  return clusters.map((c,i)=>({ id:'c'+i, mx:c.mx, my:c.my, drop:c.drop, statuses:[...c.statuses], members:c.members }));
}
function fetchAndProcessPlayers(params) {
  const minDrop = Number(params.minDrop ?? 15);
  const excludeRadiusM = Number(params.excludeRadiusM ?? 150);
  const delayMs = Number(params.delayMs ?? 3000);
  const moveEpsMm = Number(params.moveEpsMm ?? 0);
  const nearbyRadiusM = Number(params.nearbyRadiusM ?? 50);
  const activeAvoidRadiusM = Number(params.activeAvoidRadiusM ?? 50);
  const clusterRadiusM = Number(params.clusterRadiusM ?? 20);
  const addonMinDrop = Number(params.addonMinDrop ?? 5);
  const configuredNames = String(params.selfName || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const configuredUserIds = String(params.selfUserId || '').split(',').map(s => s.trim()).filter(Boolean);
  const selfNames = configuredNames;
  const selfUserIds = configuredUserIds;
  const customStart = String(params.customStart || 'false') === 'true';
  let start = customStart ? { id:'start', name:'自定义起点', mx:Number(params.startX || 0), my:Number(params.startY || 0), drop:0, status:'start' } : null;
  const logs = [];
  const log = (text, level = 'info') => logs.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12:false }), text, level });
  log('正在获取当前游戏玩家信息...', 'info');
  const s1 = fetchJson(`${CONFIG.baseUrl}/snapshot?ts=${Date.now()}`);
  return { delayMs, s1, minDrop, excludeRadiusM, moveEpsMm, nearbyRadiusM, activeAvoidRadiusM, clusterRadiusM, addonMinDrop, selfNames, selfUserIds, customStart, start, logs, log };
}
function processSnapshotResult(s1, s2, ctx) {
  const { minDrop, excludeRadiusM, moveEpsMm, nearbyRadiusM, activeAvoidRadiusM, clusterRadiusM, addonMinDrop, selfNames, selfUserIds, customStart, start: customStartPt, logs, log } = ctx;
  let start = customStartPt;
  const list1 = Array.isArray(s1.entities) ? s1.entities : [];
  const list2 = Array.isArray(s2.entities) ? s2.entities : [];
  const map1 = new Map(list1.map(e => [keyOf(e), e]));
  const map2 = new Map(list2.map(e => [keyOf(e), e]));
  const allKeys = new Set([...map1.keys(), ...map2.keys()]);
  const allStatus = [...allKeys].map(id => {
    const e1 = map1.get(id);
    const e2 = map2.get(id);
    // 以最新快照为准判定在线；前一帧也在线或坐标发生变化时仍保留方向数据。
    const online = isOnlineBySta(e2 || e1) || isOnlineBySta(e1 || e2);
    const latest = pointFromEntity(e2 || e1, online ? 'online' : 'offline');
    latest.inOriginExcludedZone = Math.hypot(latest.mx, latest.my) <= excludeRadiusM;
    const first = pointFromEntity(e1 || e2, online ? 'online' : 'offline');
    first.inOriginExcludedZone = Math.hypot(first.mx, first.my) <= excludeRadiusM;
    return { first, latest, online, presentInBoth: Boolean(e1 && e2) };
  });
  const selfStatus = allStatus.find(x => isSelfPlayer(x.latest, selfNames, selfUserIds) || isSelfPlayer(x.first, selfNames, selfUserIds));
  const selfPoint = selfStatus ? { ...selfStatus.latest, id: 'self-start', name: '自己', drop: 0, status: 'start', isSelf: true } : null;
  if (!customStart && selfPoint) {
    start = selfPoint;
    log(`识别到自己，已使用当前位置 (${Math.round(selfPoint.mx * 10) / 10}, ${Math.round(selfPoint.my * 10) / 10}) 作为路线起点，并忽略自身 Drop`, 'info');
  } else if (customStart && selfPoint) {
    log('识别到自己，但已指定自定义初始位置，因此不使用自身坐标作为起点；自身 Drop 已忽略', 'info');
  }
  const nonSelfStatus = allStatus.filter(x => !isSelfPlayer(x.latest, selfNames, selfUserIds) && !isSelfPlayer(x.first, selfNames, selfUserIds));
  const allOnline = nonSelfStatus.filter(x => x.online).map(x => {
    const moveDx = x.latest.mx - x.first.mx;
    const moveDy = x.latest.my - x.first.my;
    const moveDist = Math.hypot(moveDx, moveDy);
    return {
      ...x.latest, first: x.first, moveDx, moveDy, moveDist,
      moveAngle: Math.atan2(moveDy, moveDx),
      // 两次快照都有该玩家，且坐标有至少 1 个原始单位的变化时绘制方向扇形。
      hasDirection: x.presentInBoth && moveDist > 0.000001
    };
  });
  const online = allOnline;
  const directionalOnlineCount = online.filter(p => p.hasDirection).length;
  if (online.length) log(`在线玩家 ${online.length} 名，其中 ${directionalOnlineCount} 名在两次快照间产生坐标变化并显示方向扇形`, 'info');
  // 在线玩家不入团；所有离线且 Drop>5 的玩家均可作为团成员（包括原点范围内）。
  const offlineDropPlayers = nonSelfStatus
    .filter(x => !x.online && x.latest.drop > 5)
    .map(x => x.latest)
    .sort((a, b) => b.drop - a.drop);
  const allOfflinePlayers = nonSelfStatus
    // All offline logic ignores Drop <= 5: no clusters, map markers, route,
    // addon profit, or barren-cluster distribution calculations.
    .filter(x => !x.online && x.latest.drop > 5)
    .map(x => x.latest)
    .sort((a, b) => b.drop - a.drop);
  const forbiddenZones = [
    { id:'origin', name:'原点活跃区', mx:0, my:0, radius:excludeRadiusM, type:'origin' },
    ...allOnline.map(p => ({ id:`online:${p.id}`, name:p.name, mx:p.mx, my:p.my, radius:activeAvoidRadiusM, type:'online' }))
  ];
  // ── 团聚类（仅离线玩家，半径 clusterRadiusM）──
  const clusterList = [];
  const clustered = new Set();
  // 原点团：原点150m内的Drop>5离线玩家
  const originMembers = offlineDropPlayers.filter(p => p.inOriginExcludedZone);
  if (originMembers.length > 0) {
    originMembers.forEach(p => clustered.add(p.id));
    const originDrop = originMembers.reduce((s, p) => s + p.drop, 0);
    clusterList.push({ id: 'origin-cluster', name: '原点团', cx: 0, cy: 0, drop: originDrop, members: originMembers, isOrigin: true });
  }
  // 非原点离线玩家聚类
  const remaining = offlineDropPlayers.filter(p => !clustered.has(p.id)).sort((a, b) => b.drop - a.drop);
  for (const p of remaining) {
    if (clustered.has(p.id)) continue;
    const cluster = [p]; clustered.add(p.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const o of remaining) {
        if (clustered.has(o.id)) continue;
        if (cluster.some(m => dist(m, o) <= clusterRadiusM)) {
          cluster.push(o); clustered.add(o.id);
          changed = true; break;
        }
      }
    }
    if (cluster.length === 0) continue;
    const cx = cluster.reduce((s, m) => s + m.mx, 0) / cluster.length;
    const cy = cluster.reduce((s, m) => s + m.my, 0) / cluster.length;
    const totalDrop = cluster.reduce((s, m) => s + m.drop, 0);
    if (totalDrop < 15) continue; // Drop<15 的团不显示
    const sx100 = Math.round(cx / 100), sy100 = Math.round(cy / 100);
    const baseKey = `(${sx100},${sy100})`;
    const sameNameCount = clusterList.filter(c => c.name && c.name.startsWith(baseKey)).length;
    const name = sameNameCount > 0 ? `${baseKey}${sameNameCount + 1}团` : `${baseKey}团`;
    clusterList.push({ id: 'c' + clusterList.length, name, cx, cy, drop: totalDrop, members: cluster, isOrigin: false });
  }
  // 团点：用于路线规划和地图显示
  const clusterPoints = clusterList.map(c => ({
    id: c.id, name: c.name, mx: c.cx, my: c.cy, drop: c.drop, status: 'offline',
    isCluster: true, members: c.members, isOrigin: c.isOrigin
  }));
  // 贫瘠团只用于观察外围玩家分布：团内没有 Drop > 15 的成员，
  // 不参与路线、收益或附加 Drop 计算。
  const barrenClusterList = [];
  const barrenClustered = new Set();
  for (const p of allOfflinePlayers) {
    if (barrenClustered.has(p.id)) continue;
    const cluster = [p]; barrenClustered.add(p.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const o of allOfflinePlayers) {
        if (barrenClustered.has(o.id)) continue;
        if (cluster.some(m => dist(m, o) <= clusterRadiusM)) {
          cluster.push(o); barrenClustered.add(o.id);
          changed = true; break;
        }
      }
    }
    if (cluster.some(m => m.drop > 15)) continue;
    const cx = cluster.reduce((s, m) => s + m.mx, 0) / cluster.length;
    const cy = cluster.reduce((s, m) => s + m.my, 0) / cluster.length;
    barrenClusterList.push({ id:`barren-${barrenClusterList.length}`, cx, cy, drop:cluster.reduce((s,m)=>s+m.drop,0), members:cluster, isBarren:true });
  }
  const barrenClusterPoints = barrenClusterList.map(c => ({
    id:c.id, name:'', mx:c.cx, my:c.cy, drop:c.drop, status:'offline',
    isCluster:true, isBarren:true, members:c.members, isOrigin:false
  }));
  // 路线与附加收益都以“团”为单位，避免团内成员被重复计算。
  const addonPool = clusterPoints;
  const onlineNearby = online.map(o => ({ ...o, nearby: clusterPoints.filter(p => dist(o, p) <= nearbyRadiusM).sort((a,b)=>dist(o,a)-dist(o,b)) }));
  const warnings = [];
  if (online.length > 5) {
    warnings.push(`当前有 ${online.length} 名玩家在线，要更加谨慎，防止被偷袭/抢 Drop`);
    log(`当前有 ${online.length} 名玩家在线，要谨慎小心，防止 Drop 被抢`, 'warn');
  }
  return {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12:false }),
    params: { minDrop, excludeRadiusM, nearbyRadiusM, activeAvoidRadiusM, clusterRadiusM, addonMinDrop, selfName: String(ctx.selfNames.join(',')), selfUserId: String(ctx.selfUserIds.join(',')), customStart, start, selfStartUsed: Boolean(!customStart && selfPoint), selfDetected: Boolean(selfPoint) },
    counts: { snapshot1: list1.length, snapshot2: list2.length, clusters: clusterList.length, barrenClusters:barrenClusterList.length, online: online.length },
    clusters: clusterList, clusterPoints,
    barrenClusters:barrenClusterList, barrenClusterPoints,
    offline: clusterPoints, online: onlineNearby, forbiddenZones, warnings, logs, addonPool,
    allOfflinePlayers
  };
}
function planRouteFromCache(playerData, params) {
  const routeMaxM = Number(params.routeMaxM ?? 1000);
  const corridorWidthM = Number(params.corridorWidthM ?? 50);
  const customRouteIds = String(params.customRouteIds || '').split(',').map(s => s.trim()).filter(Boolean);
  const customRouteMode = customRouteIds.length > 0;
  const { offline, addonPool, forbiddenZones, params: pparams, warnings: pwarnings, counts: pcounts, clusters: pclusters } = playerData;
  const start = pparams.start;
  const logs = [];
  const log = (text, level = 'info') => logs.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12:false }), text, level });
  log(`正在规划路线（最大体力 ${routeMaxM}，1 体力 = 10m），避开 ${forbiddenZones.length} 个禁区`, 'info');

  function buildOneRoute(available, availableAddonPool, label) {
    const rAddonPool = prefilterAddonPool(availableAddonPool, available.slice(0, 80), routeMaxM, start);
    const route = planRoute(available, routeMaxM, start, rAddonPool, corridorWidthM, forbiddenZones);
    const routeIds = new Set(route.map(p => p.id));
    const scoreInfo = routeScore(route, availableAddonPool, corridorWidthM, start);
    const addonPlayers = scoreInfo.addon.filter(p => !routeIds.has(p.id)).map(p => ({ ...p, isAddon: true }));
    log(`${label}：经过 ${route.length} 个团，主 Drop ${scoreInfo.mainDrop} + 附加 ${scoreInfo.addonDrop}，收益 ${scoreInfo.totalDrop / 2}`, route.length ? 'success' : 'warn');
    return {
      route, addonPlayers,
      routeDirection: route.length ? { start: route[0], end: route[route.length-1] } : null,
      routeLength: routeLen(route, start),
      routeDrop: scoreInfo.mainDrop,
      addonDrop: scoreInfo.addonDrop,
      totalRouteDrop: scoreInfo.totalDrop,
      profitDrop: scoreInfo.totalDrop / 2
    };
  }

  let customRouteError = '';
  let routes = [];
  if (customRouteMode) {
    log(`正在计算自定义收益最大路径，从已选 ${customRouteIds.length} 个节点中按体力上限筛选`, 'info');
    const selectable = new Map([...offline, ...addonPool].map(p => [p.id, p]));
    const selected = [];
    const missing = [];
    for (const id of customRouteIds) { const p = selectable.get(id); if (p) selected.push(p); else missing.push(id); }
    if (missing.length) log(`有 ${missing.length} 个已选节点当前不可用`, 'warn');
    const solved = solveBestCustomRoute(selected, start, forbiddenZones, routeMaxM, addonPool, corridorWidthM);
    if (solved.ok) {
      log(`自定义路径计算完成：选择 ${solved.route.length}/${selected.length} 个团，获得总 Drop ${solved.score.totalDrop}，消耗体力 ${Math.round(solved.length * 10) / 10}${solved.skipped ? `，跳过 ${solved.skipped} 个以满足上限` : ''}`, 'success');
      const rIds = new Set(solved.route.map(p => p.id));
      const si = routeScore(solved.route, addonPool, corridorWidthM, start);
      routes = [{
        route: solved.route, addonPlayers: si.addon.filter(p => !rIds.has(p.id)).map(p => ({ ...p, isAddon: true })),
        routeDirection: solved.route.length ? { start: solved.route[0], end: solved.route[solved.route.length-1] } : null,
        routeLength: routeLen(solved.route, start), routeDrop: si.mainDrop, addonDrop: si.addonDrop,
        totalRouteDrop: si.totalDrop, profitDrop: si.totalDrop / 2
      }];
    } else {
      customRouteError = solved.reason;
      log(`自定义路径无法连接：${customRouteError}`, 'warn');
      routes = [{ route: [], addonPlayers: [], nearbyOnline: [], nearbyHighDrop: [], routeDirection: null, routeLength: 0, routeDrop: 0, addonDrop: 0, totalRouteDrop: 0, profitDrop: 0 }];
    }
  } else {
    const usedGlobalIds = new Set();
    const routeCount = pparams.selfStartUsed ? 1 : 3;
    if (pparams.selfStartUsed) log('检测到自己在线：只生成 1 条以当前位置为起点的推荐路线', 'info');
    for (let i = 0; i < routeCount; i++) {
      const remain = offline.filter(p => !usedGlobalIds.has(p.id));
      const remainAddonPool = addonPool.filter(p => !usedGlobalIds.has(p.id));
      const r = buildOneRoute(remain, remainAddonPool, `路线${['一','二','三'][i]}`);
      routes.push(r);
      for (const p of r.route) usedGlobalIds.add(p.id);
      for (const p of r.addonPlayers) usedGlobalIds.add(p.id);
    }
  }

  // Mark inRoute on offline players across all routes
  const allRouteIds = new Set();
  for (const r of routes) for (const p of r.route) allRouteIds.add(p.id);
  for (const p of offline) p.inRoute = allRouteIds.has(p.id);

  // 仅当自己作为原点内起点时，提示离开原点路线可能遇到的风险。
  // 高 Drop 离线玩家按原点内成员显示；在线玩家还必须落在路径走廊附近。
  const originZone = forbiddenZones.find(z => z.type === 'origin');
  const originThreats = [];
  if (pparams.selfStartUsed && start && originZone && dist(start, originZone) <= originZone.radius) {
    for (const r of routes) {
      if (!r.route.length) continue;
      const online = (playerData.online || []).filter(p => dist(p, originZone) <= originZone.radius && routeAddonPlayers(r.route, [p], corridorWidthM, start).length);
      const highDrop = (playerData.allOfflinePlayers || []).filter(p => dist(p, originZone) <= originZone.radius && p.drop > 15);
      r.originThreats = { online, highDrop };
      if (online.length || highDrop.length) log(`路线原点风险：附近在线 ${online.length} 名；原点内高 Drop 玩家 ${highDrop.length} 名`, 'warn');
    }
  }

  // Total across all routes
  const totalProfit = routes.reduce((s, r) => s + r.profitDrop, 0);
  const totalMainDrop = routes.reduce((s, r) => s + r.routeDrop, 0);
  const totalAddonDrop = routes.reduce((s, r) => s + r.addonDrop, 0);
  const totalPlayers = routes.reduce((s, r) => s + r.route.length, 0);
  const totalAddonPlayers = routes.reduce((s, r) => s + r.addonPlayers.length, 0);

  return {
    ...playerData,
    routes, customRouteError, logs,
    params: { ...pparams, routeMaxM, corridorWidthM, customRouteMode, customRouteIds },
    counts: { ...pcounts, routePlayers: totalPlayers, addonPlayers: totalAddonPlayers, routeClusters: totalPlayers, addonClusters: totalAddonPlayers },
    totalProfitDrop: totalProfit,
    totalMainDrop, totalAddonDrop
  };
}

const html = fs.readFileSync(path.join(__dirname, 'rat-drop-dashboard.html'), 'utf8');
let playerCache = null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${CONFIG.port}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/players') {
      const params = Object.fromEntries(url.searchParams.entries());
      const ctx = fetchAndProcessPlayers(params);
      const s2 = await Promise.race([
        (async () => { await sleep(ctx.delayMs); return fetchJson(`${CONFIG.baseUrl}/snapshot?ts=${Date.now()}`); })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('获取玩家数据超时')), 35000))
      ]);
      ctx.log('玩家数据获取完成，正在分析...', 'info');
      const result = processSnapshotResult(ctx.s1, s2, ctx);
      playerCache = result;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }
    if (url.pathname === '/api/plan') {
      if (!playerCache) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '还没有获取玩家数据，请先点击刷新数据' }));
        return;
      }
      const params = Object.fromEntries(url.searchParams.entries());
      const result = planRouteFromCache(playerCache, params);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err && (err.stack || err.message) || String(err) }));
  }
});
function openDashboardUrl() {
  const url = `http://127.0.0.1:${CONFIG.port}/`;
  try { spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
  return url;
}
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    const url = openDashboardUrl();
    console.log(`Rat Game Dashboard 已经在运行：${url}`);
    console.log('已直接打开现有面板。若要完全停止，请关闭之前启动面板的命令窗口，或在任务管理器结束对应 node.exe。');
    process.exit(0);
  }
  throw err;
});
server.listen(CONFIG.port, '127.0.0.1', () => {
  const url = openDashboardUrl();
  console.log('Rat Game Dashboard 已启动：' + url);
  console.log('关闭这个命令窗口即可停止面板服务。重复双击会直接打开现有面板，不会再报端口占用。');
});
