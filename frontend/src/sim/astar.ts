// Coarse global route planner (A*) over the traversability field.
// Finds the minimum-cost corridor to the goal; MPPI then tracks it locally.
import { WORLD_W, WORLD_H, activeTerrain, effMuAt } from './terrain';
import type { Obstacle } from './store';

const CELL = 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export interface RoutePt {
  x: number;
  y: number;
}

function hardBlocked(x: number, y: number, obstacles: Obstacle[], margin: number): boolean {
  for (const o of obstacles) {
    if (o.kind !== 'boulder' && o.kind !== 'tree' && o.kind !== 'bush') continue;
    if (Math.hypot(o.x - x, o.y - y) < o.r + margin) return true;
  }
  return false;
}

/** Line-of-sight check: true when the segment avoids hard blockers. Soft hazards are allowed. */
function losClear(ax: number, ay: number, bx: number, by: number, obstacles: Obstacle[], margin: number): boolean {
  const d = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(d / 1));
  for (let i = 0; i <= steps; i++) {
    const x = ax + ((bx - ax) * i) / steps;
    const y = ay + ((by - ay) * i) / steps;
    if (hardBlocked(x, y, obstacles, margin)) return false;
  }
  return true;
}

export function planRoute(
  sx: number, sy: number, gx: number, gy: number, friction: number, obstacles: Obstacle[], bubble = 1.2
): { pts: RoutePt[]; length: number } | null {
  const cols = Math.ceil(WORLD_W / CELL);
  const rows = Math.ceil(WORLD_H / CELL);
  const toWorld = (cx: number, cy: number) => ({ x: -WORLD_W / 2 + (cx + 0.5) * CELL, y: -WORLD_H / 2 + (cy + 0.5) * CELL });
  const toCell = (x: number, y: number) => ({
    cx: clamp(Math.floor((x + WORLD_W / 2) / CELL), 0, cols - 1),
    cy: clamp(Math.floor((y + WORLD_H / 2) / CELL), 0, rows - 1)
  });

  // traversal cost grid (precomputed once per replan)
  const cost = new Float32Array(cols * rows);
  const blocked = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const w = toWorld(cx, cy);
      const idx = cy * cols + cx;
      if (hardBlocked(w.x, w.y, obstacles, bubble)) {
        blocked[idx] = 1;
        cost[idx] = Infinity;
        continue;
      }
      const { mu } = effMuAt(w.x, w.y, friction);
      const tau = clamp(0.12 + mu * 0.95, 0, 1);
      const sl = activeTerrain.slopeAt(w.x, w.y);
      cost[idx] = 1 + (1 - tau) * 8 + sl.mag * 6;
    }
  }

  const start = toCell(sx, sy);
  let goal = toCell(gx, gy);
  // snap goal to nearest free cell when dropped inside a blocker
  if (blocked[goal.cy * cols + goal.cx]) {
    let found = false;
    for (let r = 1; r <= 8 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = goal.cx + dx;
          const ny = goal.cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (!blocked[ny * cols + nx]) {
            goal = { cx: nx, cy: ny };
            found = true;
          }
        }
      }
    }
    if (!found) return null;
  }

  // A* with binary heap
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
  g[si] = 0;
  const heap: number[] = [si];
  const heapF: number[] = [oct(start.cx, start.cy, goal.cx, goal.cy)];
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
  const pop = (): number => {
    const top = heap[0];
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
    return top;
  };

  const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]
  ];
  let found = false;
  let guard = 0;
  while (heap.length && guard++ < 40000) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === gi) {
      found = true;
      break;
    }
    const ccx = cur % cols;
    const ccy = Math.floor(cur / cols);
    for (const [dx, dy, mult] of DIRS) {
      const nx = ccx + dx;
      const ny = ccy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
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
        push(ni, ng + oct(nx, ny, goal.cx, goal.cy));
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

  // greedy line-of-sight smoothing with full vehicle clearance
  const smooth: RoutePt[] = [raw[0]];
  const losMargin = Math.max(1.0, bubble * 0.5);
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !losClear(raw[i].x, raw[i].y, raw[j].x, raw[j].y, obstacles, losMargin)) j--;
    smooth.push(raw[j]);
    i = j;
  }

  let length = 0;
  for (let k = 1; k < smooth.length; k++) length += Math.hypot(smooth[k].x - smooth[k - 1].x, smooth[k].y - smooth[k - 1].y);
  return { pts: smooth, length };
}
