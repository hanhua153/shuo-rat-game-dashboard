const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CONFIG = {
  baseUrl: 'https://grasp-rat-game.h-e.top',
  minDrop: 15,
  originExcludeRadiusM: 150,
  onlineCheckDelayMs: 6000,
  onlineMoveEpsilonMm: 0,
  nearbyOnlineRadiusM: 50,
  routeMaxLengthM: 1200,
  mapSizePx: 2000,
  mapRadiusM: 1000,
  outputDir: path.join(__dirname, 'output')
};

function curlText(url) {
  const args = [
    '-L', '--silent', '--show-error', '--fail',
    '--connect-timeout', '10', '--max-time', '20',
    '--noproxy', '*',
    '-H', 'User-Agent: Mozilla/5.0 rat-game-drop-checker',
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
function fmtM(v) {
  const n = mmToM(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
function distM(a, b) {
  const dx = mmToM(Number(a.x) - Number(b.x));
  const dy = mmToM(Number(a.y) - Number(b.y));
  return Math.hypot(dx, dy);
}
function distFromOriginM(e) { return Math.hypot(mmToM(e.x), mmToM(e.y)); }
function moved(a, b) {
  return Math.abs(Number(a.x) - Number(b.x)) > CONFIG.onlineMoveEpsilonMm
    || Math.abs(Number(a.y) - Number(b.y)) > CONFIG.onlineMoveEpsilonMm;
}
function keyOf(e) { return String(e.user_id || e.entity_id || `${e.name}:${e.x}:${e.y}`); }
function displayName(e) { return e.name || `User ${e.user_id || '?'}`; }
function lineFor(e, extra = '') {
  return `- ${displayName(e)} | (${fmtM(e.x)}, ${fmtM(e.y)}) m | Drop ${dropOf(e)}${extra}`;
}
function entityToPoint(e) { return { ...e, mx: mmToM(e.x), my: mmToM(e.y), drop: dropOf(e), label: displayName(e) }; }
function pointDist(a, b) { return Math.hypot(a.mx - b.mx, a.my - b.my); }
function routeLength(route) {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += pointDist(route[i - 1], route[i]);
  return total;
}
function routeDrop(route) { return route.reduce((sum, p) => sum + p.drop, 0); }
function betterRoute(a, b) {
  if (!a) return b;
  if (!b) return a;
  const da = routeDrop(a), db = routeDrop(b);
  if (db !== da) return db > da ? b : a;
  const la = routeLength(a), lb = routeLength(b);
  if (Math.abs(lb - la) > 1e-9) return lb < la ? b : a;
  return b.length > a.length ? b : a;
}
function planBestRoute(points) {
  const n = points.length;
  if (!n) return [];
  const dist = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) dist[i][j] = pointDist(points[i], points[j]);
  const states = new Map();
  let best = null;
  for (let i = 0; i < n; i++) {
    const mask = 1 << i;
    const key = `${mask}|${i}`;
    const state = { mask, last: i, len: 0, drop: points[i].drop, route: [i] };
    states.set(key, state);
    best = betterRoute(best, state.route.map(k => points[k]));
  }
  for (let mask = 1; mask < (1 << n); mask++) {
    for (let last = 0; last < n; last++) {
      const state = states.get(`${mask}|${last}`);
      if (!state) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nextLen = state.len + dist[last][next];
        if (nextLen > CONFIG.routeMaxLengthM + 1e-9) continue;
        const nextMask = mask | (1 << next);
        const key = `${nextMask}|${next}`;
        const candidate = {
          mask: nextMask,
          last: next,
          len: nextLen,
          drop: state.drop + points[next].drop,
          route: [...state.route, next]
        };
        const old = states.get(key);
        if (!old || candidate.drop > old.drop || (candidate.drop === old.drop && candidate.len < old.len)) states.set(key, candidate);
        best = betterRoute(best, candidate.route.map(k => points[k]));
      }
    }
  }
  return best || [];
}
function chooseRouteDirection(route) {
  if (route.length <= 1) return route;
  const forward = route;
  const reverse = [...route].reverse();
  const maxLen = Math.max(forward.length, reverse.length);
  for (let i = 0; i < maxLen; i++) {
    const fd = forward.slice(0, i + 1).reduce((s, p) => s + p.drop, 0);
    const rd = reverse.slice(0, i + 1).reduce((s, p) => s + p.drop, 0);
    if (fd !== rd) return fd > rd ? forward : reverse;
  }
  return forward[0].drop >= reverse[0].drop ? forward : reverse;
}
function esc(s) { return String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function makeMapSvg(points, route) {
  const size = CONFIG.mapSizePx;
  const radius = CONFIG.mapRadiusM;
  const scale = size / (radius * 2);
  const sx = x => size / 2 + x * scale;
  const sy = y => size / 2 + y * scale;
  const routeSet = new Set(route.map(p => keyOf(p)));
  const routeLine = route.map(p => `${sx(p.mx).toFixed(1)},${sy(p.my).toFixed(1)}`).join(' ');
  const grid = [];
  for (let m = -1000; m <= 1000; m += 250) {
    const pos = sx(m);
    grid.push(`<line x1="${pos}" y1="0" x2="${pos}" y2="${size}" stroke="#e5e7eb" stroke-width="1"/>`);
    grid.push(`<line x1="0" y1="${pos}" x2="${size}" y2="${pos}" stroke="#e5e7eb" stroke-width="1"/>`);
  }
  const dots = points.map(p => {
    const inRoute = routeSet.has(keyOf(p));
    const r = inRoute ? 8 : 5;
    const fill = inRoute ? '#ef4444' : '#2563eb';
    return `<g><circle cx="${sx(p.mx)}" cy="${sy(p.my)}" r="${r}" fill="${fill}"><title>${esc(p.label)} (${p.mx}, ${p.my}) Drop ${p.drop}</title></circle><text x="${sx(p.mx) + 8}" y="${sy(p.my) - 8}" font-size="18" fill="#111827">${esc(p.label)} D${p.drop}</text></g>`;
  }).join('\n');
  const routeSvg = route.length > 1 ? `<polyline points="${routeLine}" fill="none" stroke="#dc2626" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="100%" height="100%" fill="white"/>
${grid.join('\n')}
<line x1="${size / 2}" y1="0" x2="${size / 2}" y2="${size}" stroke="#111827" stroke-width="2"/>
<line x1="0" y1="${size / 2}" x2="${size}" y2="${size / 2}" stroke="#111827" stroke-width="2"/>
<circle cx="${size / 2}" cy="${size / 2}" r="150" fill="none" stroke="#9ca3af" stroke-dasharray="8 8" stroke-width="2"/>
${routeSvg}
${dots}
<text x="20" y="36" font-size="24" fill="#111827">Rat Game Drop Map: center=(0,0), right=+x, down=+y</text>
</svg>`;
}

async function main() {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  console.log('正在获取第 1 次快照...');
  const s1 = fetchJson(`${CONFIG.baseUrl}/snapshot?ts=${Date.now()}`);
  const list1 = Array.isArray(s1.entities) ? s1.entities : [];
  console.log(`第 1 次获取到 ${list1.length} 个实体，等待 ${CONFIG.onlineCheckDelayMs / 1000} 秒复核是否移动...`);
  await sleep(CONFIG.onlineCheckDelayMs);
  console.log('正在获取第 2 次快照...');
  const s2 = fetchJson(`${CONFIG.baseUrl}/snapshot?ts=${Date.now()}`);
  const list2 = Array.isArray(s2.entities) ? s2.entities : [];
  const map2 = new Map(list2.map(e => [keyOf(e), e]));

  const candidates = list1
    .filter(e => dropOf(e) > CONFIG.minDrop)
    .filter(e => distFromOriginM(e) > CONFIG.originExcludeRadiusM)
    .map(e1 => {
      const e2 = map2.get(keyOf(e1));
      const isOnline = e2 ? moved(e1, e2) : false;
      const latest = e2 || e1;
      return { first: e1, latest, isOnline, disappeared: !e2 };
    })
    .sort((a, b) => dropOf(b.latest) - dropOf(a.latest));

  const offline = candidates.filter(x => !x.isOnline);
  const online = candidates.filter(x => x.isOnline);
  const offlineEntities = offline.map(x => x.latest);

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(CONFIG.outputDir, `drop-list-${stamp}.md`);
  const svgPath = path.join(CONFIG.outputDir, `drop-map-${stamp}.svg`);

  const routePoints = offline.map(x => entityToPoint(x.latest));
  const bestRoute = chooseRouteDirection(planBestRoute(routePoints));
  fs.writeFileSync(svgPath, makeMapSvg(routePoints, bestRoute), 'utf8');

  const lines = [];
  lines.push(`# Rat Game Drop 列表`);
  lines.push('');
  lines.push(`生成时间：${now.toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`规则：Drop > ${CONFIG.minDrop}；坐标由原始单位去掉后三位显示为 m；排除原点半径 ${CONFIG.originExcludeRadiusM}m 内；等待 ${CONFIG.onlineCheckDelayMs / 1000}s 后坐标不变判定为下线/静止。`);
  lines.push(`地图文件：${svgPath}`);
  lines.push('');
  lines.push(`## 推荐路线（静止玩家，线段总长 ≤ ${CONFIG.routeMaxLengthM}m）`);
  if (!bestRoute.length) {
    lines.push('无');
  } else {
    lines.push(`总 Drop：${routeDrop(bestRoute)}；线段总长：${routeLength(bestRoute).toFixed(1)}m`);
    lines.push(`建议从 **${bestRoute[0].label}** 这一端开始，可以更早拿到较大的 Drop。`);
    bestRoute.forEach((p, i) => {
      const step = i === 0 ? 0 : pointDist(bestRoute[i - 1], p);
      lines.push(`${i + 1}. ${p.label} | (${p.mx}, ${p.my}) m | Drop ${p.drop}${i ? ` | 上一段 ${step.toFixed(1)}m` : ' | 起点/传送点'}`);
    });
  }
  lines.push('');
  lines.push(`## 下线 / 静止玩家（${offline.length}）`);
  if (!offline.length) lines.push('无');
  for (const item of offline) lines.push(lineFor(item.latest));
  lines.push('');
  lines.push(`## 在线 / 会移动玩家（${online.length}）`);
  if (!online.length) lines.push('无');
  for (const item of online) {
    const nearby = offlineEntities
      .filter(e => keyOf(e) !== keyOf(item.latest) && distM(item.latest, e) <= CONFIG.nearbyOnlineRadiusM)
      .sort((a, b) => distM(item.latest, a) - distM(item.latest, b));
    const movedText = ` | 移动: (${fmtM(item.first.x)}, ${fmtM(item.first.y)}) -> (${fmtM(item.latest.x)}, ${fmtM(item.latest.y)}) m`;
    lines.push(lineFor(item.latest, movedText));
    if (nearby.length) {
      lines.push(`  - 半径 ${CONFIG.nearbyOnlineRadiusM}m 内 Drop>${CONFIG.minDrop} 的下线/静止玩家：`);
      for (const n of nearby) lines.push(`    - ${displayName(n)} | (${fmtM(n.x)}, ${fmtM(n.y)}) m | Drop ${dropOf(n)} | 距离 ${distM(item.latest, n).toFixed(1)}m`);
    }
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Value ${JSON.stringify(lines.join('\n'))}`], { stdio: 'ignore' });
  } catch (_) {}
  console.log('完成：' + outPath);
  console.log('地图：' + svgPath);
  console.log('结果内容已尝试复制到剪贴板，并会用记事本打开。');
  try {
    const child = spawn('notepad.exe', [outPath], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) {}
}

main().catch(err => {
  console.error('运行失败：' + (err && err.stack || err));
  process.exitCode = 1;
});
