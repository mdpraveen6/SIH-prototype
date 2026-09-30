// Shared autonomy math: LiDAR raycasts, traversability, MPPI rollouts.
// Used by both the 3D viewport and the tactical minimap.
import { Obstacle, ObstacleKind } from './store';
import { activeTerrain, effMuAt } from './terrain';

export const MPPI_K = 56;
export const TREE_CANOPY = 1.7;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const lx = cx - ox;
  const ly = cy - oy;
  const tca = lx * dx + ly * dy;
  if (tca < 0) return null;
  const d2 = lx * lx + ly * ly - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return null;
  const t = tca - Math.sqrt(Math.max(0, r2 - d2));
  return t >= 0 ? t : null;
}

export function soilTau(x: number, y: number, friction: number): number {
  const { mu } = effMuAt(x, y, friction);
  return clamp(0.12 + mu * 0.95, 0, 1);
}

export function obstacleMargin(o: Obstacle): number {
  return o.kind === 'tree' ? 1.2 : 0;
}

export const MPPI_W: Record<ObstacleKind, [number, number]> = {
  boulder: [3.2, 4.4],
  tree: [3.0, 4.0],
  bush: [2.6, 3.4],
  mud: [1.3, 1.8],
  water: [1.6, 2.0],
  sand: [1.4, 1.7],
  smoke: [0.35, 0.35]
};

export function traversability(x: number, y: number, friction: number, obstacles: Obstacle[]): number {
  let tau = soilTau(x, y, friction);
  for (const o of obstacles) {
    const d = Math.hypot(o.x - x, o.y - y) - o.r - obstacleMargin(o) * 0.5;
    if (o.kind === 'boulder' || o.kind === 'tree' || o.kind === 'bush') {
      if (d < 0.8) return 0;
      tau -= 0.5 * Math.exp(-(Math.max(0, d) ** 2) / 4);
    } else if (o.kind === 'mud') {
      tau -= 0.65 * Math.exp(-(d * d) / (o.r * o.r * 1.4));
    } else if (o.kind === 'water') {
      tau -= 0.7 * Math.exp(-(d * d) / (o.r * o.r * 1.2));
    } else if (o.kind === 'sand') {
      tau -= 0.5 * Math.exp(-(d * d) / (o.r * o.r * 1.4));
    } else {
      tau -= 0.2 * Math.exp(-(d * d) / (o.r * o.r));
    }
  }
  return clamp(tau, 0, 1);
}

export function tauColor(tau: number, alphaScale = 1): string {
  if (tau > 0.62) {
    const k = (tau - 0.62) / 0.38;
    return `rgba(${Math.round(52 - 18 * k)},${Math.round(211 - 40 * k)},${Math.round(153 - 60 * k)},${(0.32 * alphaScale).toFixed(2)})`;
  }
  if (tau > 0.3) {
    const k = (tau - 0.3) / 0.32;
    return `rgba(${Math.round(249 - 197 * k)},${Math.round(115 + 96 * k)},${Math.round(22 + 131 * k)},${(0.38 * alphaScale).toFixed(2)})`;
  }
  return `rgba(239,68,68,${(0.42 * alphaScale).toFixed(2)})`;
}

export interface Rollout {
  pts: { x: number; y: number }[];
  cost: number;
}

export function mppiRollouts(
  px: number, py: number, th: number, v: number, friction: number, obstacles: Obstacle[], t: number, snr: boolean, caution = false
): { paths: Rollout[]; best: number; bestCost: number } {
  const speed = Math.max(v, 0.9);
  const H = 20;
  const dt = 0.16;
  const wOf = (kind: ObstacleKind): number => {
    const b = MPPI_W[kind][snr ? 1 : 0];
    // early-detection boost: hard blockers inside the 1.5m caution zone repel harder
    return kind === 'boulder' || kind === 'tree' || kind === 'bush' ? b + (caution ? 1.8 : 0) : b;
  };
  const paths: Rollout[] = [];
  for (let i = 0; i < MPPI_K; i++) {
    const lane = (i / (MPPI_K - 1) - 0.5) * 13 + Math.sin(t * 0.5 + i * 2.3) * 0.9;
    const wob = 0.35 + 0.65 * (((i * 7919) % 100) / 100);
    let x = px;
    let y = py;
    let h = th;
    const pts = [{ x, y }];
    let cost = 0;
    for (let s = 1; s <= H; s++) {
      const ahead = s * dt * speed;
      const tx = px + Math.cos(th) * ahead;
      const ty = py + Math.sin(th) * ahead + lane * (s / H) * (s / H);
      const want = Math.atan2(ty - y, tx - x);
      let dh = want - h;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      h += (dh * 2.2 + Math.sin(s * 0.8 + i * 1.7) * 0.12 * wob) * dt;
      x += Math.cos(h) * speed * dt;
      y += Math.sin(h) * speed * dt;
      pts.push({ x, y });
      for (const o of obstacles) {
        const m = obstacleMargin(o);
        const d = Math.hypot(o.x - x, o.y - y) - o.r - m;
        if ((o.kind === 'boulder' || o.kind === 'tree' || o.kind === 'bush') && d < 0.9) {
          cost += 60; // hard collision — never pick a clipping rollout
        } else {
          cost += wOf(o.kind) * Math.exp(-(d * d) / 3.5);
        }
      }
      const tauStep = soilTau(x, y, friction);
      const sl = activeTerrain.slopeAt(x, y);
      cost += (1 - tauStep) * 0.05 + sl.mag * 0.06 + Math.abs(lane) * 0.004 + (1 - tauStep) * speed * speed * 0.0012;
    }
    paths.push({ pts, cost });
  }
  let best = 0;
  for (let i = 1; i < paths.length; i++) if (paths[i].cost < paths[best].cost) best = i;
  return { paths, best, bestCost: paths[best].cost };
}

/** LiDAR interaction radius. null = ground-level, no return (mud / sand flats). */
export function lidarRadius(o: Obstacle): number | null {
  if (o.kind === 'mud' || o.kind === 'sand') return null;
  if (o.kind === 'tree') return o.r + TREE_CANOPY;
  return o.r;
}

/** Noisy partial returns (water / smoke) vs solid (rock / trunk / bush). */
export function lidarPartial(kind: ObstacleKind): boolean {
  return kind === 'smoke' || kind === 'water';
}
