// Pit / pothole hazard helpers: UGV geometry, solidity, survey verdict.
// Standalone (no store imports) so sim, planner, and MPPI can all share it.
import type { Obstacle } from './store';

/** UGV running gear, meters — matches the 3D model (tyre R 0.34, track 1.24). */
export const TYRE_R = 0.34;
export const TYRE_W = 0.3;
export const TRACK = 1.24;
export const CLEARANCE = 0.26;
/** Widest pit the wheels can straddle (track minus one tyre width). */
export const STRADDLE_MAX = TRACK - TYRE_W; // 0.94 m
/** Max measured depth the hull can float over. */
export const DEPTH_PASS = 0.2;
/** Hold distance nose-to-pit-edge while surveying. */
export const SURVEY_HOLD = 0.5;

export type PitKind = 'pit_small' | 'pit_large' | 'pothole';

export function isPitKind(kind: string): boolean {
  return kind === 'pit_small' || kind === 'pit_large' || kind === 'pothole';
}

/** Waste + region-exclusive classes: no prototype in the base model. */
export const NOVEL_KINDS = ['barrel', 'tirepile', 'log', 'drum', 'cairn', 'mound'] as const;

/** Which stranger belongs to which land (spawns on deploy only). */
export const REGION_EXCLUSIVE: Record<string, 'log' | 'drum' | 'cairn' | 'mound'> = {
  ghats: 'log', thar: 'drum', himalaya: 'cairn', deccan: 'mound'
};

export const NOVEL_LABEL: Record<string, string> = {
  barrel: 'RUBBER BARREL', tirepile: 'WASTE TIRE PILE', log: 'FALLEN LOG',
  drum: 'RUSTED DRUM', cairn: 'STONE CAIRN', mound: 'TERMITE MOUND'
};

/** Nearest-prototype novelty signature: [size, air-relative temp, lidar, elongation]. */
export interface Signature {
  size: number;
  temp: number;
  lidar: number;
  elong: number;
}

function lidarOf(kind: string): number {
  if (kind === 'mud' || kind === 'sand' || isPitKind(kind)) return 0;
  if (kind === 'water' || kind === 'smoke') return 0.5;
  return 1;
}

function elongOf(kind: string): number {
  if (kind === 'log') return 1.0;
  if (kind === 'tirepile') return 0.5;
  if (kind === 'mound') return 0.5;
  if (kind === 'cairn') return 0.3;
  return 0;
}

export function signatureOf(kind: string, r: number, temp: number, air: number): Signature {
  return { size: r / 1.5, temp: (temp - air) / 10, lidar: lidarOf(kind), elong: elongOf(kind) };
}

/** Base-model prototypes, air-relative in °C/10. Prototype bases track the
 *  thermal slider + night exactly like obstacleTemp, so known kinds match
 *  within sensor wobble at any setting; only size spread remains. */
const PROTO_BASE: Record<string, { size: number; temp: number; lidar: number; elong: number }> = {
  boulder: { size: 0.73, temp: 34, lidar: 1, elong: 0 },
  tree: { size: 0.4, temp: 24, lidar: 1, elong: 0 },
  bush: { size: 0.63, temp: 25, lidar: 1, elong: 0 },
  mud: { size: 1.27, temp: 26, lidar: 0, elong: 0 },
  water: { size: 1.07, temp: 18, lidar: 0.5, elong: 0 },
  sand: { size: 1.4, temp: 32, lidar: 0, elong: 0 },
  smoke: { size: 1.67, temp: 30, lidar: 0.5, elong: 0 },
  pit_small: { size: 0.17, temp: 27, lidar: 0, elong: 0 },
  pit_large: { size: 0.47, temp: 27, lidar: 0, elong: 0 },
  pothole: { size: 0.37, temp: 22, lidar: 0, elong: 0 }
};

export const NOVELTY_THRESHOLD = 0.55;

/** Min Euclidean distance to any known prototype + nearest class.
 *  thermEff/night shift prototypes exactly like the sensor model. */
export function noveltyDistance(sig: Signature, thermEff = 65, night = false): { dist: number; nearest: string } {
  const air = 12 + (thermEff - 45) * 0.5;
  const slide = (thermEff - 65) * 0.25 + (night ? -6 : 0);
  let best = Infinity;
  let cls = '—';
  for (const [k, p] of Object.entries(PROTO_BASE)) {
    const pt = (p.temp + slide - air) / 10;
    const d = Math.hypot(sig.size - p.size, sig.temp - pt, sig.lidar - p.lidar, sig.elong - p.elong);
    if (d < best) {
      best = d;
      cls = k;
    }
  }
  return { dist: best, nearest: cls };
}

/** Geometric solidity for planning + shields. Failed pits count as rock. */
export function isSolidObstacle(o: Obstacle): boolean {
  if (o.kind === 'boulder' || o.kind === 'tree' || o.kind === 'bush') return true;
  if (o.kind === 'car_parked' || o.kind === 'cone' || o.kind === 'post' || o.kind === 'building') return true;
  if (o.kind === 'car' || o.kind === 'moto' || o.kind === 'ped' || o.kind === 'tractor' || o.kind === 'animal') return true;
  if ((NOVEL_KINDS as readonly string[]).includes(o.kind)) return true;
  if ((o.kind === 'pit_large' || o.kind === 'pothole') && o.verdict === 'fail') return true;
  return false;
}

/** Soft planner weight for pits (fail verdicts are solid, handled above). */
export function pitSoftWeight(o: Obstacle): number {
  if (o.verdict === 'pass') return 0.8;
  if (o.kind === 'pit_small') return 1.0;
  return 1.5; // large / pothole pre-survey: cheap enough to approach
}

export interface PitVerdict {
  pass: boolean;
  dia: number;
  depth: number;
  straddleOk: boolean;
  clearMargin: number; // CLEARANCE - depth
  reason: string;
}

/** Camera-survey decision: straddle only what fits between the wheels and
 *  stays shallower than the belly. Deterministic from (radius, depth). */
export function verdictFor(r: number, depth: number): PitVerdict {
  const dia = r * 2;
  const straddleOk = dia < STRADDLE_MAX;
  const clearMargin = CLEARANCE - depth;
  const pass = straddleOk && depth <= DEPTH_PASS;
  const reason = !straddleOk
    ? `Ø${dia.toFixed(2)}m wider than ${STRADDLE_MAX.toFixed(2)}m track — wheels must enter`
    : depth > DEPTH_PASS
      ? `${depth.toFixed(2)}m deeper than ${DEPTH_PASS.toFixed(2)}m belly limit`
      : `straddle Ø${dia.toFixed(2)}m · belly +${clearMargin.toFixed(2)}m`;
  return { pass, dia, depth, straddleOk, clearMargin, reason };
}
