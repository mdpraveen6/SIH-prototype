// Procedural Indian-terrain engine: soils, elevation, presets.
// Seeded value-noise keeps every region deterministic.

export const WORLD_W = 240;
export const WORLD_H = 150;

export type SoilId = 'packed' | 'gravel' | 'sand' | 'clay' | 'rocky' | 'grass' | 'snow' | 'asphalt' | 'concrete' | 'crop';

export interface SoilDef {
  id: SoilId;
  label: string;
  mu: number;
  rgb: [number, number, number];
  slipMul: number;
  loadMul: number;
}

export const SOILS: Record<SoilId, SoilDef> = {
  packed: { id: 'packed', label: 'PACKED DIRT', mu: 0.72, rgb: [74, 64, 48], slipMul: 1.0, loadMul: 1.0 },
  gravel: { id: 'gravel', label: 'GRAVEL', mu: 0.6, rgb: [96, 90, 80], slipMul: 1.15, loadMul: 1.1 },
  sand: { id: 'sand', label: 'SAND', mu: 0.34, rgb: [168, 144, 100], slipMul: 1.5, loadMul: 1.5 },
  clay: { id: 'clay', label: 'CLAY / MUD', mu: 0.22, rgb: [96, 66, 44], slipMul: 1.7, loadMul: 1.6 },
  rocky: { id: 'rocky', label: 'ROCKY BED', mu: 0.55, rgb: [88, 86, 90], slipMul: 1.1, loadMul: 1.25 },
  grass: { id: 'grass', label: 'GRASS', mu: 0.62, rgb: [52, 84, 44], slipMul: 1.05, loadMul: 1.05 },
  snow: { id: 'snow', label: 'SNOW', mu: 0.25, rgb: [231, 235, 240], slipMul: 1.8, loadMul: 1.35 },
  asphalt: { id: 'asphalt', label: 'ASPHALT', mu: 0.8, rgb: [46, 46, 50], slipMul: 0.9, loadMul: 0.9 },
  concrete: { id: 'concrete', label: 'CONCRETE', mu: 0.75, rgb: [128, 128, 134], slipMul: 0.95, loadMul: 0.95 },
  crop: { id: 'crop', label: 'CROP ROWS', mu: 0.5, rgb: [62, 102, 52], slipMul: 1.2, loadMul: 1.2 }
};

export interface PresetDef {
  id: string;
  label: string;
  desc: string;
  seed: number;
  weights: Record<SoilId, number>;
  elevAmp: number;
  elevFreq: number;
  trees: number;
  rocks: number;
  bushes: number;
  mud: number;
  water: number;
  sand: number;
  pits: number; // small (straddlable) mud pits
  pitL: number; // large mud pits (survey → usually reroute)
  holes: number; // potholes (survey → usually reroute)
  cars: number; // parked vehicles
  cones: number; // traffic cones / temporary markers
  crops: number; // crop plants in row bands
  posts: number; // fence posts / lamp poles
  buildings: number; // structures (solid)
  roads?: Array<{ axis: 'x' | 'y'; at: number; w: number; soil: SoilId }>;
  roundabout?: { x: number; y: number; r: number; w: number; soil: SoilId };
  traffic?: { car: number; moto: number; ped: number; cycle: number; tractor: number; worker: number; animal: number };
  zones?: Array<{ x0: number; y0: number; x1: number; y1: number; soil: SoilId }>;
  spawn?: { x: number; y: number; theta: number };
  smoke: number;
  thermal: number;
  treeline: number | null; // trees only at/below this elevation (m)
  snowline: number | null; // snow above this elevation (m)
  canopy: string;
  canopyHi: string;
}

export const PRESETS: PresetDef[] = [
  {
    id: 'ghats', label: 'Western Ghats', desc: 'Dense wet forest · clay mud · streams',
    seed: 1123, weights: { grass: 0.3, clay: 0.25, packed: 0.2, gravel: 0.1, rocky: 0.1, sand: 0.05, snow: 0, asphalt: 0, concrete: 0, crop: 0 },
    elevAmp: 3.0, elevFreq: 0.035, trees: 88, rocks: 14, bushes: 42, mud: 10, water: 5, sand: 0,
    pits: 4, pitL: 2, holes: 2, cars: 0, cones: 0, crops: 0, posts: 0, buildings: 0,
    smoke: 12, thermal: 66, treeline: null, snowline: null, canopy: '#1d4a2c', canopyHi: '#2f6b40'
  },
  {
    id: 'thar', label: 'Thar Desert', desc: 'Dunes · dust · no trees · extreme heat',
    seed: 4407, weights: { sand: 0.55, packed: 0.2, gravel: 0.15, rocky: 0.1, grass: 0, clay: 0, snow: 0, asphalt: 0, concrete: 0, crop: 0 },
    elevAmp: 1.8, elevFreq: 0.022, trees: 0, rocks: 18, bushes: 30, mud: 0, water: 0, sand: 12,
    pits: 2, pitL: 3, holes: 1, cars: 0, cones: 0, crops: 0, posts: 0, buildings: 0,
    smoke: 32, thermal: 88, treeline: null, snowline: null, canopy: '#5a5a2e', canopyHi: '#7a7a3c'
  },
  {
    id: 'himalaya', label: 'Himalayan Slope', desc: 'Pines below treeline · scree · snowfields',
    seed: 8991, weights: { rocky: 0.4, gravel: 0.25, packed: 0.15, grass: 0.12, clay: 0.08, sand: 0, snow: 0, asphalt: 0, concrete: 0, crop: 0 },
    elevAmp: 5.0, elevFreq: 0.045, trees: 40, rocks: 60, bushes: 18, mud: 2, water: 2, sand: 0,
    pits: 2, pitL: 1, holes: 2, cars: 0, cones: 0, crops: 0, posts: 0, buildings: 0,
    smoke: 6, thermal: 52, treeline: 0.8, snowline: 1.7, canopy: '#16382f', canopyHi: '#1f5142'
  },
  {
    id: 'deccan', label: 'Deccan Plateau', desc: 'Granite tors · gravel · scrub · waterhole',
    seed: 6234, weights: { gravel: 0.3, packed: 0.25, rocky: 0.2, grass: 0.15, clay: 0.1, sand: 0, snow: 0, asphalt: 0, concrete: 0, crop: 0 },
    elevAmp: 2.2, elevFreq: 0.028, trees: 16, rocks: 45, bushes: 28, mud: 4, water: 2, sand: 2,
    pits: 3, pitL: 2, holes: 3, cars: 0, cones: 0, crops: 0, posts: 0, buildings: 0,
    smoke: 10, thermal: 74, treeline: null, snowline: null, canopy: '#3d4d26', canopyHi: '#576b35'
  }
];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iy: number, s: number): number {
  let h = (ix * 374761393 + iy * 668265263 + s * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s);
  const b = hash2(ix + 1, iy, s);
  const c = hash2(ix, iy + 1, s);
  const d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, s: number, oct: number): number {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f + i * 17.3, y * f - i * 11.1, s + i * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const SOIL_ORDER: SoilId[] = ['grass', 'packed', 'gravel', 'sand', 'clay', 'rocky', 'snow', 'asphalt', 'concrete', 'crop'];

export class Terrain {
  preset: PresetDef;
  constructor(p: PresetDef) {
    this.preset = p;
  }
  /** Field plot query: soil override inside surveyed field rectangles. */
  zoneAt(x: number, y: number): SoilId | null {
    for (const z of this.preset.zones ?? []) {
      if (x >= z.x0 - 1 && x <= z.x1 + 1 && y >= z.y0 - 1 && y <= z.y1 + 1) return z.soil;
    }
    return null;
  }
  /** Road corridor query: { soil, mask } with a 2 m feathered edge.
   *  mask = 1 deep inside the corridor, 0 outside. */
  roadAt(x: number, y: number): { soil: SoilId; mask: number } | null {
    const p = this.preset;
    let best: { soil: SoilId; mask: number } | null = null;
    const strip = (d: number, w: number, soil: SoilId) => {
      const m = clamp(1 - Math.max(0, Math.abs(d) - w / 2) / 2, 0, 1);
      if (m > 0 && (!best || m > best.mask)) best = { soil, mask: m };
    };
    for (const r of p.roads ?? []) {
      strip(r.axis === 'x' ? y - r.at : x - r.at, r.w, r.soil);
    }
    const rb = p.roundabout;
    if (rb) {
      const d = Math.abs(Math.hypot(x - rb.x, y - rb.y) - rb.r);
      strip(d - rb.w / 2, rb.w, rb.soil);
    }
    return best;
  }
  elevAt(x: number, y: number): number {
    const p = this.preset;
    const e = p.elevAmp * (fbm(x * p.elevFreq + 13.7, y * p.elevFreq + 7.3, p.seed, 3) * 2 - 1);
    // grade corridors flat: roads cut through the noise like real grading
    const road = this.roadAt(x, y);
    return road ? e * (1 - 0.92 * road.mask) : e;
  }
  slopeAt(x: number, y: number): { dx: number; dy: number; mag: number } {
    const e = 0.6;
    const dx = (this.elevAt(x + e, y) - this.elevAt(x - e, y)) / (2 * e);
    const dy = (this.elevAt(x, y + e) - this.elevAt(x, y - e)) / (2 * e);
    return { dx, dy, mag: Math.hypot(dx, dy) };
  }
  soilAt(x: number, y: number): SoilDef {
    const p = this.preset;
    const road = this.roadAt(x, y);
    if (road && road.mask > 0.5) return SOILS[road.soil];
    const zone = this.zoneAt(x, y);
    if (zone) return SOILS[zone];
    const e = this.elevAt(x, y);
    if (p.snowline !== null && e > p.snowline) return SOILS.snow;
    const en = e / Math.max(0.001, p.elevAmp);
    if (en > 0.45 && p.weights.rocky > 0.05) return SOILS.rocky;
    if (en < -0.35 && p.weights.sand > 0.2) return SOILS.sand;
    const n = fbm(x * 0.075 + (p.seed % 17), y * 0.075 - (p.seed % 13), p.seed ^ 0x51f3, 2);
    let total = 0;
    for (const id of SOIL_ORDER) total += p.weights[id];
    let r = n * total;
    for (const id of SOIL_ORDER) {
      r -= p.weights[id];
      if (r <= 0) return SOILS[id];
    }
    return SOILS.packed;
  }
}

/** Effective friction at a point: soil μ scaled by the moisture/condition slider. */
export function effMuAt(x: number, y: number, friction: number): { soil: SoilDef; mu: number } {
  const soil = activeTerrain.soilAt(x, y);
  return { soil, mu: clamp(soil.mu * (0.45 + friction), 0.05, 0.95) };
}

// Measured soil distribution per preset: grid-samples the real generator
// (elevation + snowline rules included), so the classifier compares against
// what is actually on the ground — not the nominal recipe weights.
const profileCache = new Map<string, Record<SoilId, number>>();
export function soilProfile(presetId: string): Record<SoilId, number> {
  const hit = profileCache.get(presetId);
  if (hit) return hit;
  const p = PRESETS.find((q) => q.id === presetId) ?? PRESETS[0];
  const probe = new Terrain(p);
  const counts = {} as Record<SoilId, number>;
  for (const id of SOIL_ORDER) counts[id] = 0;
  const NX = 48;
  const NY = 30;
  for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) {
      const x = -WORLD_W / 2 + ((ix + 0.5) / NX) * WORLD_W;
      const y = -WORLD_H / 2 + ((iy + 0.5) / NY) * WORLD_H;
      counts[probe.soilAt(x, y).id]++;
    }
  }
  const total = NX * NY;
  for (const id of SOIL_ORDER) counts[id] /= total;
  profileCache.set(presetId, counts);
  return counts;
}
export const PROFILE_SOILS: SoilId[] = [...SOIL_ORDER];

export let activeTerrain = new Terrain(PRESETS[0]);

export function setActivePreset(id: string): PresetDef {
  const p = PRESETS.find((q) => q.id === id) ?? PRESETS[0];
  activeTerrain = new Terrain(p);
  return p;
}
