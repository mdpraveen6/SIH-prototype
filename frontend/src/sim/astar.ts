// Global route planner (A*) over the traversability field.
// Finds the minimum-cost corridor to the goal; MPPI then tracks it locally.
//
// Accuracy model (highest priority):
//   - Static terrain (soil mu + slope) cached per preset+friction bucket.
//   - Hard blockers splat an exact inflation field per replan: binary blocked
//     inside r + margin + extra + QB (QB covers cell-center quantization so a
//     "clear" cell is truly clear), plus a Gaussian proximity penalty outside
//     so A* prefers daylight instead of grazing the ring.
//   - Soft hazards (mud / water / sand) splat traversability penalties — the
//     old planner was blind to them and happily routed through mud.
//   - LOS smoothing re-checks at 0.25 m steps with margin + 0.3 m buffer.
// Speed: obstacle splatting touches only cells near obstacles, and A* is
// bounded to the start-goal bounding box (+25 m pad) instead of the world.
import { WORLD_W, WORLD_H, activeTerrain, effMuAt } from './terrain';
import { isSolidObstacle, pitSoftWeight } from './hazards';
import type { Obstacle } from './store';

const CELL = 1.5;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Cell-center quantization buffer: a "free" cell center can sit up to ~CELL/2
 *  from the true blocked boundary, so blocked radius carries QB extra. */
const QB = 0.35;
/** Gaussian inflation outside the blocked ring: prefer clearance over grazing. */
const INFLATE_RADIUS = 3.0;
const INFLATE_SIGMA = 1.4;
const INFLATE_W = 7.0;
/** Soft-hazard weights (peak penalty at disc center, Gaussian falloff). */
const SOFT_W: Record<string, number> = { mud: 4.0, water: 5.0, sand: 2.5, crop: 3.5 };
/** A* bounding-box pad around start+goal, meters. */
const BBOX_PAD = 25;

export interface RoutePt {
  x: number;
  y: number;
}

// ---- static terrain cache (soil + slope never change within a preset) ----
let cacheKey = '';
let cacheBase: Float32Array | null = null;
let cacheCols = 0;
let cacheRows = 0;

function baseCost(cols: number, rows: number, toWorld: (cx: number, cy: number) => { x: number; y: number }, friction: number): Float32Array {
  const key = `${activeTerrain.preset.id}:${(Math.round(friction / 0.05) * 0.05).toFixed(2)}:${cols}x${rows}`;
  if (cacheBase && key === cacheKey && cols === cacheCols && rows === cacheRows) return cacheBase;
  const base = new Float32Array(cols * rows);
  const fb = Math.round(friction / 0.05) * 0.05;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const w = toWorld(cx, cy);
      const { mu } = effMuAt(w.x, w.y, fb);
      const tau = clamp(0.12 + mu * 0.95, 0, 1);
      const sl = activeTerrain.slopeAt(w.x, w.y);
      base[cy * cols + cx] = 1 + (1 - tau) * 8 + sl.mag * 6;
    }
  }
  cacheKey = key;
  cacheBase = base;
  cacheCols = cols;
  cacheRows = rows;
  return base;
}

function hardBlocked(x: number, y: number, obstacles: Obstacle[], margin: number, extra?: Map<number, number>): boolean {
  for (const o of obstacles) {
    if (!isSolidObstacle(o)) continue;
    const inflate = extra?.get(o.id) ?? 0;
    if (Math.hypot(o.x - x, o.y - y) < o.r + margin + inflate + QB) return true;
  }
  return false;
}

/** Line-of-sight check at fine steps with a safety buffer: smoothing must
 *  never re-introduce a graze the grid just planned around. */
function losClear(ax: number, ay: number, bx: number, by: number, obstacles: Obstacle[], margin: number, extra?: Map<number, number>): boolean {
  const d = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(d / 0.25));
  for (let i = 0; i <= steps; i++) {
    const x = ax + ((bx - ax) * i) / steps;
    const y = ay + ((by - ay) * i) / steps;
    if (hardBlocked(x, y, obstacles, margin + 0.3, extra)) return false;
  }
  return true;
}

export function planRoute(
  sx: number, sy: number, gx: number, gy: number, friction: number, obstacles: Obstacle[], margin = 1.2, extra?: Map<number, number>
): { pts: RoutePt[]; length: number } | null {
  const cols = Math.ceil(WORLD_W / CELL);
  const rows = Math.ceil(WORLD_H / CELL);
  const toWorld = (cx: number, cy: number) => ({ x: -WORLD_W / 2 + (cx + 0.5) * CELL, y: -WORLD_H / 2 + (cy + 0.5) * CELL });
  const toCell = (x: number, y: number) => ({
    cx: clamp(Math.floor((x + WORLD_W / 2) / CELL), 0, cols - 1),
    cy: clamp(Math.floor((y + WORLD_H / 2) / CELL), 0, rows - 1)
  });

  // bounding box around start+goal (+pad): A* never needs the whole world
  const start = toCell(sx, sy);
  const goalRaw = toCell(gx, gy);
  const pad = Math.ceil(BBOX_PAD / CELL);
  const cx0 = clamp(Math.min(start.cx, goalRaw.cx) - pad, 0, cols - 1);
  const cx1 = clamp(Math.max(start.cx, goalRaw.cx) + pad, 0, cols - 1);
  const cy0 = clamp(Math.min(start.cy, goalRaw.cy) - pad, 0, rows - 1);
  const cy1 = clamp(Math.max(start.cy, goalRaw.cy) + pad, 0, rows - 1);

  // cost = cached terrain + per-replan obstacle field (splat near obstacles)
  const base = baseCost(cols, rows, toWorld, friction);
  const cost = new Float32Array(cols * rows);
  cost.set(base);
  const blocked = new Uint8Array(cols * rows);
  for (const o of obstacles) {
    const solid = isSolidObstacle(o);
    const softW = solid ? 0 : (SOFT_W[o.kind] ?? pitSoftWeight(o));
    if (!solid && !softW) continue;
    const inflate = extra?.get(o.id) ?? 0;
    const R = solid
      ? o.r + margin + inflate + QB + INFLATE_RADIUS
      : o.r * 2.2;
    const rx0 = Math.floor((o.x - R + WORLD_W / 2) / CELL);
    const rx1 = Math.floor((o.x + R + WORLD_W / 2) / CELL);
    const ry0 = Math.floor((o.y - R + WORLD_H / 2) / CELL);
    const ry1 = Math.floor((o.y + R + WORLD_H / 2) / CELL);
    if (rx1 < cx0 || rx0 > cx1 || ry1 < cy0 || ry0 > cy1) continue;
    const bx0 = clamp(rx0, cx0, cx1);
    const bx1 = clamp(rx1, cx0, cx1);
    const by0 = clamp(ry0, cy0, cy1);
    const by1 = clamp(ry1, cy0, cy1);
    for (let cy = by0; cy <= by1; cy++) {
      for (let cx = bx0; cx <= bx1; cx++) {
        const idx = cy * cols + cx;
        if (blocked[idx]) continue;
        const w = toWorld(cx, cy);
        const edge = Math.hypot(o.x - w.x, o.y - w.y) - o.r;
        if (solid) {
          const e = edge - inflate;
          if (e < margin + QB) {
            blocked[idx] = 1;
            cost[idx] = Infinity;
          } else {
            const prox = e - margin - QB;
            if (prox < INFLATE_RADIUS) {
              cost[idx] += INFLATE_W * Math.exp(-(prox * prox) / (INFLATE_SIGMA * INFLATE_SIGMA));
            }
          }
        } else {
          // soft disc: full weight inside, Gaussian falloff outside
          const sig = o.r * 1.1 + 0.4;
          const prox = Math.max(0, edge);
          cost[idx] += softW * Math.exp(-(prox * prox) / (sig * sig));
        }
      }
    }
  }

  let goal = goalRaw;
  // snap goal to nearest free cell when dropped inside a blocker
  if (blocked[goal.cy * cols + goal.cx]) {
    let found = false;
    for (let r = 1; r <= 8 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = goal.cx + dx;
          const ny = goal.cy + dy;
          if (nx < cx0 || ny < cy0 || nx > cx1 || ny > cy1) continue;
          if (!blocked[ny * cols + nx]) {
            goal = { cx: nx, cy: ny };
            found = true;
          }
        }
      }
    }
    if (!found) return null;
  }

  // A* with binary heap (bounded to bbox, stale-entry skip, straight-line tie-break)
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const si = start.cy * cols + start.cx;
  const gi = goal.cy * cols + goal.cx;
  const oct = (ax: number, ay: number, bx: number, by: number) => {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
  };
  // tie-break toward the goal straight line: fewer expansions, straighter paths
  const cross = (ax: number, ay: number) =>
    Math.abs((ax - goal.cx) * (start.cy - goal.cy) - (ay - goal.cy) * (start.cx - goal.cx)) * 0.001;
  const hOf = (ax: number, ay: number) => oct(ax, ay, goal.cx, goal.cy) + cross(ax, ay);
  g[si] = 0;
  const heap: number[] = [si];
  const heapF: number[] = [hOf(start.cx, start.cy)];
  const push = (idx: number, f: number) => {
    heap.push(idx);
    heapF.push(f);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const topF = heapF[0];
    const li = heap.pop()!;
    const lf = heapF.pop()!;
    if (heap.length) {
      heap[0] = li;
      heapF[0] = lf;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapF[l] < heapF[m]) m = l;
        if (r < heap.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        i = m;
      }
    }
    return [top, topF];
  };

  const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]
  ];
  let found = false;
  let guard = 0;
  while (heap.length && guard++ < 80000) {
    const [cur, f] = pop();
    if (closed[cur]) continue;
    const ccx0 = cur % cols;
    const ccy0 = Math.floor(cur / cols);
    // stale heap entry (a better g was pushed later): skip
    if (Math.abs(f - (g[cur] + hOf(ccx0, ccy0))) > 1e-9) continue;
    closed[cur] = 1;
    if (cur === gi) {
      found = true;
      break;
    }
    const ccx = ccx0;
    const ccy = ccy0;
    for (const [dx, dy, mult] of DIRS) {
      const nx = ccx + dx;
      const ny = ccy + dy;
      if (nx < cx0 || ny < cy0 || nx > cx1 || ny > cy1) continue;
      const ni = ny * cols + nx;
      if (blocked[ni] || closed[ni]) continue;
      if (dx !== 0 && dy !== 0) {
        // no corner cutting
        if (blocked[ccy * cols + nx] || blocked[ny * cols + ccx]) continue;
      }
      const ng = g[cur] + cost[ni] * mult;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        push(ni, ng + hOf(nx, ny));
      }
    }
  }
  if (!found) return null;

  // reconstruct
  const cells: { cx: number; cy: number }[] = [];
  let cur = gi;
  while (cur !== -1) {
    cells.push({ cx: cur % cols, cy: Math.floor(cur / cols) });
    if (cur === si) break;
    cur = came[cur];
  }
  cells.reverse();
  let raw = cells.map((c) => toWorld(c.cx, c.cy));
  raw.push({ x: gx, y: gy });

  // greedy line-of-sight smoothing with buffered vehicle clearance
  const smooth: RoutePt[] = [raw[0]];
  const losMargin = margin;
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !losClear(raw[i].x, raw[i].y, raw[j].x, raw[j].y, obstacles, losMargin, extra)) j--;
    smooth.push(raw[j]);
    i = j;
  }

  let length = 0;
  for (let k = 1; k < smooth.length; k++) length += Math.hypot(smooth[k].x - smooth[k - 1].x, smooth[k].y - smooth[k - 1].y);
  return { pts: smooth, length };
}
