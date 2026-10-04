import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { PRESETS, PresetDef, PROFILE_SOILS, SoilId, WORLD_H, WORLD_W, activeTerrain, effMuAt, mulberry32, setActivePreset, soilProfile } from './terrain';
import { planRoute } from './astar';
import { lidarPartial, lidarRadius, rayCircle } from './mppi';
import { SURVEY_HOLD, isPitKind, isSolidObstacle, verdictFor } from './hazards';
import {
  NOVELTY_THRESHOLD, NOVEL_LABEL, NOVEL_KINDS, REGION_EXCLUSIVE,
  noveltyDistance, signatureOf
} from './hazards';

export { WORLD_W, WORLD_H };

export type ObstacleKind = 'mud' | 'boulder' | 'smoke' | 'tree' | 'bush' | 'water' | 'sand' | 'pit_small' | 'pit_large' | 'pothole' | 'barrel' | 'tirepile' | 'log' | 'drum' | 'cairn' | 'mound' | 'car_parked' | 'cone' | 'crop' | 'post' | 'building' | 'car' | 'moto' | 'ped' | 'tractor' | 'animal';
export type OpMode = 'sim' | 'live' | 'replay';
export type UITheme = 'night' | 'desert';

/** Geometric blockers that trigger the Layer-0 hard override. Bushes are solid: the stack routes around undergrowth. */
export const HARD_KINDS: ObstacleKind[] = ['boulder', 'tree', 'bush'];

/** Per-object surface temperature (°C) for the LWIR thermal model. */
export function obstacleTemp(o: Obstacle, thermEff: number, night: boolean): number {
  const base: Record<ObstacleKind, number> = {
    water: 18, mud: 26, sand: 32, boulder: 34, tree: 24, bush: 25, smoke: 30,
    pit_small: 27, pit_large: 27, pothole: 22,
    barrel: 40, tirepile: 30, log: 24, drum: 42, cairn: 30, mound: 29,
    car_parked: 33, cone: 29, crop: 23, post: 28, building: 31,
    car: 33, moto: 34, ped: 31, tractor: 38, animal: 30
  };
  const wobble = Math.sin(o.id * 3.7) * 1.5;
  const t = base[o.kind] + (thermEff - 65) * 0.25 + wobble;
  return night ? t - 6 - (o.kind === 'water' ? -4 : 0) : t;
}

export interface Obstacle {
  id: number;
  x: number;
  y: number;
  r: number;
  kind: ObstacleKind;
  depth?: number; // pit / pothole depth, meters down (+)
  verdict?: 'pass' | 'fail'; // camera-survey outcome for pits
  tall?: boolean; // lamp poles vs fence posts (render height)
  variant?: string; // crop field: wheat | maize | stubble | seedling
}

/** Live camera survey of a mud pit / pothole in front of the UGV. */
export interface PitSurvey {
  id: number;
  x: number;
  y: number;
  r: number;
  depth: number;
  diaM: number; // measured diameter (true + sensor noise)
  depM: number; // measured depth (true + sensor noise)
  phase: 'project' | 'measure' | 'verdict';
  t0: number; // survey start (simTime)
}

export interface SurveyFlash {
  x: number;
  y: number;
  r: number;
  pass: boolean;
  until: number;
}

/** One self-supervised discovery: a novel class the UGV met in the wild. */
export interface DatasetEntry {
  code: string; // UNK-01…
  kind: string;
  label: string; // pseudo-label from dominant trait
  views: number;
  samples: number; // distinct instances seen
  conf: number; // 0..99
  promoted: boolean;
  firstT: number;
  firstX: number;
  firstY: number;
  size: number; // mean radius seen
  temp: number; // mean temp seen
  novelty: number; // signature distance that flagged it
}

/** Independent traffic agent: lane follower, wanderer, grazer, worker. */
export interface Mover {
  mid: number;
  oKind: ObstacleKind; // linked obstacle kind (car, moto, ped, tractor, animal)
  x: number;
  y: number;
  theta: number;
  v: number;
  v0: number;
  r: number;
  obsId: number;
  ref: Obstacle | null; // linked obstacle entry (stable reference)
  mode: 'lane' | 'ring' | 'wander' | 'graze' | 'work' | 'cross' | 'merge';
  lane: number; // lane index for lane/ring modes
  s: number; // distance along lane
  tx: number; // wander/work target
  ty: number;
  pauseT: number; // remaining dwell time
  stopT: number; // event brake hold
  boostT: number; // moto burst
  temp: boolean; // despawn on arrival (jaywalker)
  seed: number;
  sub: string; // car | bus | truck | goat | cow (render + behavior flavor)
}

/** Single traffic-light head (state derived from simTime each step). */
export interface SignalHead {
  x: number;
  y: number;
  axis: 'x' | 'y';
  state: 'G' | 'Y' | 'R';
}

export interface LandResult {
  label: string;
  conf: number;
  runner: string;
  runnerConf: number;
}

export interface SimParams {
  velocity: number; // m/s 0..4
  friction: number; // moisture/condition 0.10..0.95 (scales soil μ)
  smoke: number; // % 0..100
  thermal: number; // Jetson GPU thermal load degC 45..90
  bubble: number; // early-detection radius (m) around the UGV, 1..4
  clearance: number; // guaranteed body gap (m) to hard blockers, 0.3..2
}

export interface Telemetry {
  slipL: number;
  slipR: number;
  curL: number;
  curR: number;
  ax: number;
  az: number;
  vib: number;
  vio: number;
  zupt: boolean;
  lat: number; // ms inference latency
  fps: number; // L1 throughput
  temp: number; // Jetson degC
  vram: number; // GB
  lag: number; // ms TF2 lag
  cmdV: number;
  actV: number;
  backpropHz: number;
  throttled: boolean;
  planeInliers: number; // % RANSAC ground plane
  snrDegraded: boolean; // smoke > 80% -> L0-exclusive nav
  caution: boolean; // hard blocker inside 1.5m early-detection zone
  goalDist: number; // m to goal, -1 when no goal
  margin: number; // m, nose to nearest hard-blocker edge
  marginKind: string; // kind of nearest hard blocker ('—' when clear)
  lidarReturns: number; // live OS1-32 returns out of 32 rays
  soil: SoilId;
  soilLabel: string;
  soilMu: number;
  health: number; // UGV hull health 0..100
  compHull: number;
  compWheels: number;
  compSensors: number;
  compBattery: number;
  contacts: number; // total touches this run
}

export const SNR_SMOKE_CUTOVER = 80;

const HIST = 140;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rnd = (a: number) => (Math.random() - 0.5) * 2 * a;

export class SparshSim {
  params: SimParams = { velocity: 1.6, friction: 0.65, smoke: 8, thermal: 68, bubble: 2.0, clearance: 0.5 };
  mode: OpMode = 'sim';
  estop = false;
  tool: ObstacleKind = 'boulder';
  orbit = false;
  showGrid = true;
  night = false;
  uiTheme: UITheme = 'night';
  preset: PresetDef = PRESETS[0];
  obstacles: Obstacle[] = [];
  pose = { x: -12, y: 0, theta: 0 };
  actV = 0;
  override = false;
  caution = false;
  // goal-directed navigation state
  goal: { x: number; y: number } | null = null;
  queue: { x: number; y: number }[] = [];
  legsDone = 0;
  loopsDone = 0;
  loopMission = false;
  trail: { x: number; y: number }[] = [];
  route: { x: number; y: number }[] = [];
  routeIdx = 0;
  routeLen = 0;
  routeVersion = 0;
  replanCount = 0;
  replanMsg = 'no goal — right-click map to set destination';
  replanLog: string[] = [];
  arrived = false;
  goalBlocked = false;
  overrideCount = 0;
  lastOverrideMsg = 'none';
  lidarReturns = 32;
  private overrideSince = -1;
  driveState: 'patrol' | 'enroute' | 'caution' | 'override' | 'surveying' | 'reversing' | 'arrived' | 'blocked' | 'estop' = 'patrol';
  private corridorT = 0;
  private stuckT = 0;
  private escapeDriveT = 0;
  // Committed-avoidance latch: stops the 1s left/right flip at the margin ring.
  // Once we pick a pass side we hold it for a few seconds so the heading
  // target can't jump across the obstacle every frame.
  private avoidDir = 0; // -1 = pass right, +1 = pass left, 0 = none
  private avoidUntil = -1;
  private escapeAng = 0;
  private cautionLatch = false;
  private preciseLatch = false;
  private smoothDh = 0;
  private travelAcc = 0;
  private stallWindowT = 0;
  private windowStartDist = Infinity;
  private lastReplanT = -99;
  lastReplanMs = 0;
  private hazardCooldownUntil = -1;
  // Contact damage + no-retouch state. Touch != shield: the shield holds at
  // 1.2 m body, a touch is hull contact (centerEdge <= 0.35 m).
  health = 100;
  compHull = 100;
  compWheels = 100;
  compSensors = 100;
  compBattery = 100;
  contacts = 0;
  damageLog: string[] = [];
  private contacted = new Map<number, number>(); // obstacle id -> inflate until (simTime)
  private contactCooldownUntil = -1;
  private contactFreezeUntil = -1;
  private contactHoldUntil = -1;
  private lastContactMsg = 'none';
  // Pit / pothole camera survey (RGB-D, not LiDAR — depressions are LiDAR-blind)
  survey: PitSurvey | null = null;
  surveyFlash: SurveyFlash | null = null;
  pitApproachDist = Infinity; // nose-to-edge of nearest pit ahead (HUD)
  pitTargetId = -1;
  private surveyExemptId = -1; // fail-verdict pit we are exiting: shield ignores it
  // Self-supervised deployment: random 50 m explore, UI locked, dataset grows
  locked = false;
  deployActive = false;
  deployPhase: 'idle' | 'scan' | 'travel' | 'done' = 'idle';
  deployOdom = 0;
  deployTarget = 50;
  dataset: DatasetEntry[] = [];
  landResult: LandResult | null = null;
  private deployScanT0 = -1;
  private deployRetryT = -1;
  private nextLandAt = 5;
  private unkCounter = 0;
  private viewT = new Map<number, number>(); // obstacle id -> last counted view
  private seenIds = new Map<string, Set<number>>(); // novel kind -> instance ids
  private deploySoil: Record<string, number> = {};
  private deployTempSum = 0;
  private deployTempN = 0;
  private deploySampleT = -1;
  private deployObs: Record<string, number> = {};
  private deployObsIds = new Set<number>();
  private nominalObs: Record<string, number> = {};
  // Live traffic: movers step every frame, linked obstacles carry collision
  movers: Mover[] = [];
  signals: SignalHead[] = [];
  private moverSeq = 1;
  private eventT = 15;

  /** Solidity for shields/planning: rock-like + failed pits, minus the pit
   *  we are currently backing out of (it would otherwise deadlock us). */
  private shielded(o: Obstacle): boolean {
    return isSolidObstacle(o) && o.id !== this.surveyExemptId;
  }
  private lidarT = 0;
  private rawMargin = 99;
  private rawMarginKind = '—';
  private rawMarginX = 0;
  private rawMarginY = 0;

  /** Minimum center-edge clearance to any hard blocker, all directions. */
  private fullClearance(): number {
    let m = Infinity;
    for (const o of this.obstacles) {
      if (!this.shielded(o)) continue;
      const d = Math.hypot(o.x - this.pose.x, o.y - this.pose.y) - o.r;
      if (d < m) m = d;
    }
    return m;
  }

  /** Nearest hard blocker to the hull center (for touch detection). */
  private nearestHard(): { dist: number; id: number; kind: ObstacleKind | string; x: number; y: number } {
    let m = Infinity;
    let id = -1;
    let kind: ObstacleKind | string = '—';
    let bx = 0;
    let by = 0;
    for (const o of this.obstacles) {
      if (!this.shielded(o)) continue;
      const d = Math.hypot(o.x - this.pose.x, o.y - this.pose.y) - o.r;
      if (d < m) {
        m = d;
        id = o.id;
        kind = o.kind;
        bx = o.x;
        by = o.y;
      }
    }
    return { dist: m, id, kind, x: bx, y: by };
  }

  /** Extra planning inflation for already-touched obstacles (no-retouch zone). */
  private extraMap(): Map<number, number> {
    const m = new Map<number, number>();
    for (const [id, until] of this.contacted) {
      if (this.simTime < until) m.set(id, 0.8);
    }
    // failed survey pits carry a permanent +0.8 m no-go ring (unless exempt)
    for (const o of this.obstacles) {
      if ((o.kind === 'pit_large' || o.kind === 'pothole') && o.verdict === 'fail' && o.id !== this.surveyExemptId) {
        m.set(o.id, 0.8);
      }
    }
    return m;
  }

  private marginFor(o: Obstacle): number {
    let extra = this.simTime < (this.contacted.get(o.id) ?? -1) ? 0.8 : 0;
    if ((o.kind === 'pit_large' || o.kind === 'pothole') && o.verdict === 'fail') extra = Math.max(extra, 0.8);
    if (o.id === this.surveyExemptId) extra = 0;
    return this.planMargin() + extra;
  }

  /** True while the deploy panorama sweep holds translation. */
  private scanHolding(): boolean {
    return this.deployActive && this.deployPhase === 'scan';
  }

  /** Minimum edge clearance to hard blockers inside a cone. Used for rear checks. */
  private coneClearance(center: number, half: number, range: number): number {
    let best = range;
    for (const o of this.obstacles) {
      if (!this.shielded(o)) continue;
      const dx = o.x - this.pose.x;
      const dy = o.y - this.pose.y;
      const d = Math.hypot(dx, dy);
      if (d - o.r > range) continue;
      let rel = Math.atan2(dy, dx) - center;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) < half) best = Math.min(best, Math.max(0, d - o.r));
    }
    return best;
  }
  simTime = 0;
  nextId = 1;
  slipBurstUntil = -1;
  smokeBurstUntil = -1;
  thermalUntil = -1;
  latest: Telemetry = {
    slipL: 0, slipR: 0, curL: 0, curR: 0, ax: 0, az: 9.81, vib: 0,
    vio: 0.05, zupt: true, lat: 7.2, fps: 128, temp: 68, vram: 1.15, lag: 300,
    cmdV: 0, actV: 0, backpropHz: 10, throttled: false, planeInliers: 97, snrDegraded: false,
    soil: 'packed', soilLabel: 'PACKED DIRT', soilMu: 0.7, caution: false, goalDist: -1,
    margin: 99, marginKind: '—', lidarReturns: 32,
    health: 100, compHull: 100, compWheels: 100, compSensors: 100, compBattery: 100, contacts: 0
  };
  hist: Record<'slipL' | 'slipR' | 'curL' | 'curR' | 'vib' | 'vio' | 'lat' | 'temp', number[]> = {
    slipL: [], slipR: [], curL: [], curR: [], vib: [], vio: [], lat: [], temp: []
  };
  version = 0;
  private listeners = new Set<() => void>();
  private lastPush = 0;
  private lastNotify = 0;
  vioAcc = 0.05;

  constructor() {
    this.applyPreset('ghats');
  }

  /** Start pose for the active preset. */
  private spawnOf(): { x: number; y: number; theta: number } {
    return this.preset.spawn ?? { x: -12, y: 0, theta: 0 };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  setParams(p: Partial<SimParams>) {
    Object.assign(this.params, p);
  }
  setMode(m: OpMode) {
    this.mode = m;
  }
  setTool(t: ObstacleKind) {
    this.tool = t;
  }
  toggleEstop() {
    this.estop = !this.estop;
  }
  toggleOrbit() {
    this.orbit = !this.orbit;
    this.emit();
  }
  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.emit();
  }
  toggleTheme() {
    this.uiTheme = this.uiTheme === 'night' ? 'desert' : 'night';
    this.emit();
  }
  toggleNight() {
    this.night = !this.night;
    this.emit();
  }

  applyPreset(id: string) {
    const p = setActivePreset(id);
    this.preset = p;
    this.obstacles = [];
    const sp0 = p.spawn ?? { x: -12, y: 0, theta: 0 };
    this.pose = { x: sp0.x, y: sp0.y, theta: sp0.theta };
    this.actV = 0;
    const rng = mulberry32(p.seed ^ 0x9e3779b9);
    const place = (kind: ObstacleKind, count: number, rMin: number, rMax: number, maxElev: number | null = null, dMin = 0, dMax = 0) => {
      let placed = 0;
      let guard = 0;
      while (placed < count && guard++ < count * 15 + 30) {
        const x = (rng() * 2 - 1) * (WORLD_W / 2 - 4);
        const y = (rng() * 2 - 1) * (WORLD_H / 2 - 4);
        if (Math.hypot(x - sp0.x, y - sp0.y) < 8) continue; // keep spawn clear
        if (maxElev !== null && activeTerrain.elevAt(x, y) > maxElev) continue; // treeline rule
        let ok = true;
        for (const o of this.obstacles) {
          if (Math.hypot(o.x - x, o.y - y) < o.r + 1.6) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const depth = dMax > 0 ? dMin + rng() * (dMax - dMin) : undefined;
        this.obstacles.push({ id: this.nextId++, x, y, r: rMin + rng() * (rMax - rMin), kind, depth });
        placed++;
      }
    };
    place('tree', p.trees, 0.45, 0.75, p.treeline);
    place('boulder', p.rocks, 0.7, 1.5);
    place('bush', p.bushes, 0.7, 1.2);
    place('mud', p.mud, 1.4, 2.4);
    place('water', p.water, 1.2, 2.0);
    place('sand', p.sand, 1.6, 2.6);
    place('pit_small', p.pits, 0.22, 0.3, null, 0.12, 0.18);
    place('pit_large', p.pitL, 0.6, 0.8, null, 0.35, 0.55);
    place('pothole', p.holes, 0.4, 0.7, null, 0.3, 0.6);
    place('cone', p.cones, 0.22, 0.3);
    place('car_parked', p.cars, 1.9, 2.3);
    this.movers = [];
    this.eventT = 15;
    this.initTraffic();
    // nominal population snapshot for the land classifier: movers and future
    // dynamic drops never vote, only what the surveyors placed at build time
    this.nominalObs = {};
    for (const o of this.obstacles) {
      if (o.kind === 'car' || o.kind === 'moto' || o.kind === 'ped' || o.kind === 'tractor' || o.kind === 'animal') continue;
      this.nominalObs[o.kind] = (this.nominalObs[o.kind] ?? 0) + 1;
    }
    this.setParams({ smoke: p.smoke, thermal: p.thermal });
    this.goal = null;
    this.route = [];
    this.trail = [];
    this.arrived = false;
    this.goalBlocked = false;
    this.health = 100;
    this.compHull = 100;
    this.compWheels = 100;
    this.compSensors = 100;
    this.compBattery = 100;
    this.contacts = 0;
    this.damageLog = [];
    this.contacted.clear();
    this.contactCooldownUntil = -1;
    this.contactFreezeUntil = -1;
    this.contactHoldUntil = -1;
    this.survey = null;
    this.surveyFlash = null;
    this.surveyExemptId = -1;
    this.pitApproachDist = Infinity;
    this.pitTargetId = -1;
    this.locked = false;
    this.deployActive = false;
    this.deployPhase = 'idle';
    this.deployScanT0 = -1;
    this.deployRetryT = -1;
    this.nextLandAt = 5;
    this.deploySoil = {};
    this.deployTempSum = 0;
    this.deployTempN = 0;
    this.deploySampleT = -1;
    this.deployObs = {};
    this.deployObsIds.clear();
    this.deployOdom = 0;
    this.dataset = [];
    this.landResult = null;
    this.replanMsg = 'no goal — right-click map to set destination';
    this.emit();
  }

  reset() {
    const sp = this.spawnOf();
    this.pose = { x: sp.x, y: sp.y, theta: sp.theta };
    this.actV = 0;
    this.simTime = 0;
    this.vioAcc = 0.05;
    this.estop = false;
    this.override = false;
    this.caution = false;
    this.cautionLatch = false;
    this.preciseLatch = false;
    this.avoidDir = 0;
    this.avoidUntil = -1;
    this.escapeDriveT = 0;
    this.smoothDh = 0;
    this.health = 100;
    this.compHull = 100;
    this.compWheels = 100;
    this.compSensors = 100;
    this.compBattery = 100;
    this.contacts = 0;
    this.damageLog = [];
    this.contacted.clear();
    this.contactCooldownUntil = -1;
    this.contactFreezeUntil = -1;
    this.contactHoldUntil = -1;
    this.survey = null;
    this.surveyFlash = null;
    this.surveyExemptId = -1;
    this.pitApproachDist = Infinity;
    this.pitTargetId = -1;
    this.locked = false;
    this.deployActive = false;
    this.deployPhase = 'idle';
    this.deployScanT0 = -1;
    this.deployRetryT = -1;
    this.nextLandAt = 5;
    this.deploySoil = {};
    this.deployTempSum = 0;
    this.deployTempN = 0;
    this.deploySampleT = -1;
    this.deployObs = {};
    this.deployObsIds.clear();
    this.deployOdom = 0;
    this.dataset = [];
    this.landResult = null;
    this.arrived = false;
    this.trail = [];
    this.routeIdx = 0;
    Object.keys(this.hist).forEach((k) => {
      this.hist[k as keyof typeof this.hist] = [];
    });
    if (this.goal) this.replan('reset');
    else this.emit();
  }
  clearObstacles() {
    this.obstacles = [];
    this.movers = [];
    this.contacted.clear();
    this.survey = null;
    this.surveyFlash = null;
    this.surveyExemptId = -1;
    this.pitApproachDist = Infinity;
    this.pitTargetId = -1;
    this.emit();
    if (this.goal && !this.arrived) this.replan('hazards cleared');
  }
  setGoal(x: number, y: number, append = false) {
    if (append && this.goal && !this.arrived) {
      if (this.queue.length < 12) {
        this.queue.push({ x, y });
        this.replanMsg = `waypoint ${this.queue.length + 1} queued`;
        this.emit();
      }
      return;
    }
    this.goal = { x, y };
    this.queue = [];
    this.legsDone = 0;
    this.loopsDone = 0;
    this.arrived = false;
    this.goalBlocked = false;
    this.avoidDir = 0;
    this.avoidUntil = -1;
    this.escapeDriveT = 0;
    this.smoothDh = 0;
    this.windowStartDist = Math.hypot(x - this.pose.x, y - this.pose.y);
    this.travelAcc = 0;
    this.stallWindowT = 0;
    this.routeIdx = 0;
    this.trail = [];
    this.replan('new goal');
  }
  clearGoal() {
    this.goal = null;
    this.route = [];
    this.queue = [];
    this.legsDone = 0;
    this.loopsDone = 0;
    this.loopMission = false;
    this.arrived = false;
    this.goalBlocked = false;
    this.replanMsg = 'no goal — right-click map to set destination';
    this.emit();
  }
  toggleLoop() {
    this.loopMission = !this.loopMission;
    if (this.loopMission) this.buildPatrol();
    else this.emit();
  }
  /** Auto-generated patrol loop through the current biome. */
  buildPatrol() {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.5;
      pts.push({
        x: Math.max(-WORLD_W / 2 + 8, Math.min(WORLD_W / 2 - 8, Math.cos(a) * 70)),
        y: Math.max(-WORLD_H / 2 + 8, Math.min(WORLD_H / 2 - 8, Math.sin(a) * 40))
      });
    }
    this.goal = pts[0];
    this.queue = pts.slice(1);
    this.legsDone = 0;
    this.arrived = false;
    this.goalBlocked = false;
    this.routeIdx = 0;
    this.replan('patrol loop');
  }
  returnToStart() {
    this.loopMission = false;
    const sp = this.spawnOf();
    this.setGoal(sp.x, sp.y);
  }
  private wrapPose() {
    if (this.pose.x > WORLD_W / 2) this.pose.x = -WORLD_W / 2;
    if (this.pose.x < -WORLD_W / 2) this.pose.x = WORLD_W / 2;
    if (this.pose.y > WORLD_H / 2) this.pose.y = -WORLD_H / 2;
    if (this.pose.y < -WORLD_H / 2) this.pose.y = WORLD_H / 2;
  }
  /** Centerline planning margin: body half-width + guaranteed clearance gap + tracking reserve. */
  planMargin(): number {
    return 0.7 + this.params.clearance + 0.3;
  }
  replan(reason: string) {
    if (!this.goal) return;
    // If we are standing inside the margin ring (dynamic drop on top of us),
    // plan FROM a proven-free breadcrumb that agrees with the latched escape
    // direction — never from inside the rock, and never backwards through it.
    let sx = this.pose.x;
    let sy = this.pose.y;
    let backtrack: { x: number; y: number } | null = null;
    if (this.fullClearance() < this.planMargin()) {
      const ex = Math.cos(this.escapeAng);
      const ey = Math.sin(this.escapeAng);
      let bestScore = -Infinity;
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const tp = this.trail[i];
        let ok = true;
        for (const o of this.obstacles) {
          if (!this.shielded(o)) continue;
          if (Math.hypot(o.x - tp.x, o.y - tp.y) < o.r + this.marginFor(o) * 0.7) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        // prefer recent breadcrumbs that lie along the escape ray;
        // a point behind the escape direction would force a 180° spin
        const vx = tp.x - this.pose.x;
        const vy = tp.y - this.pose.y;
        const vl = Math.hypot(vx, vy) || 1;
        const align = (vx * ex + vy * ey) / vl;
        const recency = i / Math.max(1, this.trail.length);
        const score = align * 2 + recency;
        if (score > bestScore) {
          bestScore = score;
          backtrack = tp;
        }
      }
      // fall back to newest free point if escape angle not latched yet
      if (!backtrack) {
        for (let i = this.trail.length - 1; i >= 0; i--) {
          const tp = this.trail[i];
          let ok = true;
          for (const o of this.obstacles) {
            if (!this.shielded(o)) continue;
            if (Math.hypot(o.x - tp.x, o.y - tp.y) < o.r + this.marginFor(o) * 0.7) {
              ok = false;
              break;
            }
          }
          if (ok) {
            backtrack = tp;
            break;
          }
        }
      }
      if (backtrack) {
        sx = backtrack.x;
        sy = backtrack.y;
      } else {
        // no free breadcrumb (fresh goal / short trail): seed forward along
        // the latched escape ray — first point with real clearance wins, so
        // A* never starts from inside the rock and returns null forever
        const ex2 = Math.cos(this.escapeAng);
        const ey2 = Math.sin(this.escapeAng);
        for (const d of [2.0, 2.5, 3.0, 3.5]) {
          const cx = this.pose.x + ex2 * d;
          const cy = this.pose.y + ey2 * d;
          let ok = true;
          for (const o of this.obstacles) {
            if (!this.shielded(o)) continue;
            if (Math.hypot(o.x - cx, o.y - cy) < o.r + this.marginFor(o) * 0.7) {
              ok = false;
              break;
            }
          }
          if (ok) {
            backtrack = { x: cx, y: cy };
            sx = cx;
            sy = cy;
            break;
          }
        }
      }
    }
    const t0 = performance.now();
    const r = planRoute(sx, sy, this.goal.x, this.goal.y, this.params.friction, this.obstacles, this.planMargin(), this.extraMap());
    this.lastReplanMs = performance.now() - t0;
    if (r && r.pts.length > 1) {
      // route starts at the free breadcrumb, prefixed with our live pose so
      // the first leg is "back out along proven-free tracks", never "through the rock"
      this.route = backtrack
        ? [{ x: this.pose.x, y: this.pose.y }, backtrack, ...r.pts]
        : r.pts;
      this.routeIdx = 0;
      this.routeLen = r.length;
      this.replanCount++;
      this.routeVersion++;
      this.lastReplanT = this.simTime;
      this.replanMsg = `${reason} · ${r.length.toFixed(0)}m route · #${this.replanCount} · ${this.lastReplanMs.toFixed(0)}ms`;
      this.replanLog.push(`T+${this.simTime.toFixed(0)}s ${reason} @ (${this.pose.x.toFixed(1)},${this.pose.y.toFixed(1)})`);
      if (this.replanLog.length > 40) this.replanLog.shift();
    } else {
      // No corridor exists (goal walled in by a dynamic drop): HOLD, don't
      // keep driving the stale route straight into the new rock.
      this.replanMsg = `${reason} · no route found · holding · ${this.lastReplanMs.toFixed(0)}ms`;
      this.route = [{ x: this.pose.x, y: this.pose.y }];
      this.routeIdx = 0;
      this.lastReplanT = this.simTime;
    }
    this.emit();
  }

  // ================= live traffic =================
  // Urban lanes: east/west on the main avenue, north/south on the secondary.
  private laneDef(i: number): { ax: 'x' | 'y'; fixed: number; dir: 1 | -1; sMax: number; stopS: number } {
    const T = [
      { ax: 'x' as const, fixed: -2.2, dir: 1 as const, sMax: 245, stopS: 107 }, // eastbound, stop x=-13
      { ax: 'x' as const, fixed: 2.2, dir: -1 as const, sMax: 245, stopS: 123 }, // westbound, stop x=-3
      { ax: 'y' as const, fixed: -9.8, dir: 1 as const, sMax: 155, stopS: 70 }, // northbound, stop y=-5
      { ax: 'y' as const, fixed: -6.2, dir: -1 as const, sMax: 155, stopS: 70 } // southbound, stop y=+5
    ];
    return T[i % T.length];
  }
  private lanePos(lane: number, s: number): { x: number; y: number; theta: number } {
    const L = this.laneDef(lane);
    if (L.ax === 'x') {
      const x = L.dir === 1 ? -120 + s : 120 - s;
      return { x, y: L.fixed, theta: L.dir === 1 ? 0 : Math.PI };
    }
    const y = L.dir === 1 ? -75 + s : 75 - s;
    return { x: L.fixed, y, theta: L.dir === 1 ? Math.PI / 2 : -Math.PI / 2 };
  }

  private signalFor(axis: 'x' | 'y'): 'G' | 'Y' | 'R' {
    const ph = this.simTime % 18;
    if (axis === 'x') return ph < 7 ? 'G' : ph < 9 ? 'Y' : 'R';
    return ph < 9 ? 'R' : ph < 16 ? 'G' : 'Y';
  }

  private spawnMover(oKind: ObstacleKind, x: number, y: number, theta: number, v0: number, r: number, mode: Mover['mode'], extra: Partial<Mover> = {}): Mover {
    const obsId = this.nextId++;
    const ref: Obstacle = { id: obsId, x, y, r, kind: oKind };
    this.obstacles.push(ref);
    const m: Mover = {
      mid: this.moverSeq++, oKind, x, y, theta, v: v0, v0, r, obsId, ref,
      mode, lane: 0, s: 0, tx: x, ty: y, pauseT: 0, stopT: 0, boostT: 0,
      temp: false, seed: Math.random() * 10, sub: '', ...extra
    };
    this.movers.push(m);
    return m;
  }

  private removeMover(m: Mover) {
    const oi = this.obstacles.findIndex((o) => o.id === m.obsId);
    if (oi >= 0) this.obstacles.splice(oi, 1);
    const mi = this.movers.findIndex((q) => q.mid === m.mid);
    if (mi >= 0) this.movers.splice(mi, 1);
  }

  /** Seed preset traffic: no-op — off-road presets have no traffic. */
  private initTraffic() {
    this.movers = [];
    this.signals = [];
    this.eventT = 15;
  }

  /** Timed surprises: sudden brake. */
  private fireEvent() {
    // sudden brake: a random lane car holds 3 s, followers queue behind
    const cars = this.movers.filter((m) => m.mode === 'lane' && m.oKind === 'car');
    if (cars.length) {
      cars[Math.floor(Math.random() * cars.length)].stopT = 3;
      this.replanMsg = 'EVENT · vehicle braking hard';
    }
    this.eventT = 18 + Math.random() * 17;
  }

  private stepTraffic(dt: number) {
    for (const s of this.signals) s.state = this.signalFor(s.axis);
    this.eventT -= dt;
    if (this.eventT <= 0 && this.movers.length) this.fireEvent();
    if (!this.movers.length) return;
    // per-lane ordering for car following
    const byLane = new Map<number, Mover[]>();
    for (const m of this.movers) {
      if (m.mode !== 'lane') continue;
      if (!byLane.has(m.lane)) byLane.set(m.lane, []);
      byLane.get(m.lane)!.push(m);
    }
    for (const list of byLane.values()) list.sort((a, b) => a.s - b.s);
    const ux = this.pose.x;
    const uy = this.pose.y;
    const peds = this.movers.filter((m) => m.oKind === 'ped' || m.oKind === 'animal');

    for (let i = this.movers.length - 1; i >= 0; i--) {
      const m = this.movers[i];
      if (m.stopT > 0) {
        m.stopT -= dt;
        m.v = Math.max(0, m.v - 6 * dt);
      } else if (m.mode === 'lane') {
        const L = this.laneDef(m.lane);
        let want = m.boostT > 0 ? m.v0 * 1.4 : m.v0;
        if (m.boostT > 0) m.boostT -= dt;
        // leader following
        const list = byLane.get(m.lane)!;
        const li = list.indexOf(m);
        if (li < list.length - 1) {
          const lead = list[li + 1];
          const gap = lead.s - m.s - 4;
          if (gap < 8) want = Math.min(want, Math.max(0, gap - 3.5) * 1.2, lead.v + 0.5);
        }
        // red / yellow: hold the stop line
        const sig = this.signalFor(L.ax);
        if (sig !== 'G' && m.s < L.stopS + 2 && L.stopS - m.s < 10) {
          want = Math.min(want, Math.max(0, L.stopS - m.s - 1.5) * 1.5);
        }
        // UGV in the corridor: real drivers brake for it
        const p = this.lanePos(m.lane, m.s);
        const au = (ux - p.x) * (L.ax === 'x' ? L.dir : 0) + (uy - p.y) * (L.ax === 'y' ? L.dir : 0);
        const latU = Math.abs(L.ax === 'x' ? uy - L.fixed : ux - L.fixed);
        if (au > 0 && au < 8 && latU < 2.4) want = 0;
        // pedestrians / animals ahead: stop
        for (const q of peds) {
          const qx = q.x - p.x;
          const qy = q.y - p.y;
          const qa = qx * (L.ax === 'x' ? L.dir : 0) + qy * (L.ax === 'y' ? L.dir : 0);
          const ql = Math.abs(L.ax === 'x' ? qy : qx);
          if (qa > 0 && qa < 7 && ql < 2.6) {
            want = 0;
            break;
          }
        }
        m.v += (want > m.v ? Math.min(want - m.v, 3 * dt) : Math.max(want - m.v, -6 * dt));
        m.s += m.v * dt;
        const np = this.lanePos(m.lane, m.s);
        let ox = 0;
        if (m.sub === 'moto') ox = Math.sin(this.simTime * 0.7 + m.seed) * 1.0; // filtering weave
        m.x = np.x + (L.ax === 'x' ? 0 : ox * L.dir);
        m.y = np.y + (L.ax === 'x' ? ox : 0);
        m.theta = np.theta;
        if (m.s > L.sMax + 5) {
          // leaves the map: respawn fresh at the lane start (new entrant)
          const nl = this.lanePos(m.lane, 0);
          m.s = 0;
          m.x = nl.x;
          m.y = nl.y;
          m.v0 = m.sub === 'bus' ? 5 : m.sub === 'truck' ? 4.5 : m.sub === 'moto' ? 9 + Math.random() * 3 : 7 + Math.random() * 3;
          m.v = Math.min(m.v, m.v0);
        }
      } else if (m.mode === 'ring') {
        const rb = this.preset.roundabout;
        if (!rb) { this.removeMover(m); continue; }
        const a = m.s + (m.v / rb.r) * dt;
        m.s = a;
        m.x = rb.x + Math.cos(a) * rb.r;
        m.y = rb.y + Math.sin(a) * rb.r;
        m.theta = a + Math.PI / 2;
      } else {
        // wander / graze / work / cross / merge: waypoint walkers
        if (m.mode === 'graze') {
          if (m.pauseT > 0) {
            m.pauseT -= dt;
            m.v = 0;
          } else {
            const dx = m.tx - m.x;
            const dy = m.ty - m.y;
            const d = Math.hypot(dx, dy);
            if (d < 0.6) {
              if (m.temp) {
                this.removeMover(m);
                continue;
              }
              m.pauseT = 4 + Math.random() * 5;
              const na = Math.random() * Math.PI * 2;
              const nd = 3 + Math.random() * 4;
              m.tx = m.x + Math.cos(na) * nd;
              m.ty = m.y + Math.sin(na) * nd;
            } else {
              m.theta = Math.atan2(dy, dx);
              m.v = m.v0;
            }
          }
        } else {
          if (m.pauseT > 0) {
            m.pauseT -= dt;
            m.v = 0;
          } else {
            const dx = m.tx - m.x;
            const dy = m.ty - m.y;
            const d = Math.hypot(dx, dy);
            if (d < (m.temp ? 0.8 : 1.2)) {
              if (m.temp || m.mode === 'cross') {
                this.removeMover(m);
                continue;
              }
              if (m.mode === 'work') {
                // tractor headland turn: pause, then run the next bout back
                m.pauseT = 4;
                const flip = m.ty > -30 ? -34 : -26;
                m.tx = m.tx > 0 ? -70 : 60;
                m.ty = flip;
              } else {
                m.pauseT = m.mode === 'merge' ? 0 : 1 + Math.random() * 3;
                if (m.mode === 'merge') {
                  // joined the lane: snap to eastbound flow
                  m.mode = 'lane';
                  m.lane = 0;
                  m.s = m.x + 120;
                  m.v0 = 7;
                } else {
                  m.tx = -60 + Math.random() * 120;
                  m.ty = -40 + Math.random() * 55;
                }
              }
            } else {
              m.theta = Math.atan2(dy, dx);
              m.v = m.v0 * Math.min(1, d / 2);
            }
          }
        }
        m.x += Math.cos(m.theta) * m.v * dt;
        m.y += Math.sin(m.theta) * m.v * dt;
        if (m.mode === 'cross') {
          // jaywalker despawns once across
          if (Math.abs(m.y) > 7.5) {
            this.removeMover(m);
            continue;
          }
        }
      }
      // sync the linked collision obstacle (re-push if the cap evicted it)
      if (m.ref) {
        m.ref.x = m.x;
        m.ref.y = m.y;
        if (!this.obstacles.includes(m.ref)) this.obstacles.push(m.ref);
      }
    }
  }
  private escapeHeading(): number {    let bestA = this.pose.theta;
    let bestS = -Infinity;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      let m = Infinity;
      for (const step of [1, 2, 3]) {
        const px = this.pose.x + Math.cos(a) * step;
        const py = this.pose.y + Math.sin(a) * step;
        for (const o of this.obstacles) {
          if (!this.shielded(o)) continue;
          const d = Math.hypot(o.x - px, o.y - py) - o.r;
          if (d < m) m = d;
        }
      }
      if (m > bestS) {
        bestS = m;
        bestA = a;
      }
    }
    return bestA;
  }
  /** Start a self-supervised deployment: fresh dataset, waste spawned,
   *  UI locked. Phase 1 scans 360° in place, phase 2 travels 50 m. */
  deploy() {
    if (this.deployActive) return;
    this.dataset = [];
    this.unkCounter = 0;
    this.seenIds.clear();
    this.viewT.clear();
    this.landResult = null;
    this.deployOdom = 0;
    this.deploySoil = {};
    this.deployTempSum = 0;
    this.deployTempN = 0;
    this.deploySampleT = -1;
    this.deployObs = {};
    this.deployObsIds.clear();
    this.nextLandAt = 5;
    this.deployRetryT = -1;
    this.loopMission = false;
    this.goalBlocked = false;
    this.arrived = false;
    this.goal = null;
    this.route = [];
    this.spawnDeployWaste();
    this.deployActive = true;
    this.deployPhase = 'scan';
    this.deployScanT0 = this.simTime;
    this.locked = true;
    this.replanMsg = 'SCANNING ENVIRONMENT · 360° sweep';
    this.emit();
  }

  /** Region waste: universal rubbish + the stranger that only lives here. */
  private spawnDeployWaste() {
    const put = (kind: ObstacleKind, count: number, rMin: number, rMax: number) => {
      let placed = 0;
      let guard = 0;
      while (placed < count && guard++ < 200) {
        const a = Math.random() * Math.PI * 2;
        const d = 8 + Math.random() * 30;
        const x = Math.max(-WORLD_W / 2 + 3, Math.min(WORLD_W / 2 - 3, this.pose.x + Math.cos(a) * d));
        const y = Math.max(-WORLD_H / 2 + 3, Math.min(WORLD_H / 2 - 3, this.pose.y + Math.sin(a) * d));
        let ok = true;
        for (const o of this.obstacles) {
          if (Math.hypot(o.x - x, o.y - y) < o.r + 2.0) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        this.obstacles.push({ id: this.nextId++, x, y, r: rMin + Math.random() * (rMax - rMin), kind });
        placed++;
      }
    };
    put('barrel', 3, 0.45, 0.6);
    put('tirepile', 2, 0.5, 0.7);
    const excl = REGION_EXCLUSIVE[this.preset.id] ?? 'mound';
    const er = excl === 'log' ? [0.3, 0.42] as const : excl === 'drum' ? [0.5, 0.65] as const : excl === 'cairn' ? [0.45, 0.6] as const : [0.6, 0.8] as const;
    put(excl, 3, er[0], er[1]);
  }

  /** Next random leg: never straight — sample until a routable point sticks.
   *  Returns false when no ground found (caller schedules a retry). */
  private deployNext(): boolean {
    const pt = this.randomReachable();
    if (!pt) {
      this.deployRetryT = this.simTime + 2;
      this.replanMsg = 'SEEKING GROUND… · no routable sample, retrying';
      return false;
    }
    this.goal = pt;
    this.queue = [];
    this.legsDone = 0;
    this.arrived = false;
    this.goalBlocked = false;
    this.routeIdx = 0;
    this.windowStartDist = Math.hypot(pt.x - this.pose.x, pt.y - this.pose.y);
    this.travelAcc = 0;
    this.stallWindowT = 0;
    this.replan('explore leg');
    return true;
  }

  private randomReachable(): { x: number; y: number } | null {
    const R = 25 + Math.min(60, this.deployOdom * 1.5);
    for (let k = 0; k < 25; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = 8 + Math.random() * R;
      const x = Math.max(-WORLD_W / 2 + 2, Math.min(WORLD_W / 2 - 2, this.pose.x + Math.cos(a) * d));
      const y = Math.max(-WORLD_H / 2 + 3, Math.min(WORLD_H / 2 - 3, this.pose.y + Math.sin(a) * d));
      const r = planRoute(this.pose.x, this.pose.y, x, y, this.params.friction, this.obstacles, this.planMargin(), this.extraMap());
      if (r && r.pts.length > 1) return { x, y };
    }
    return null;
  }

  private finishDeploy(note = '') {
    if (!this.deployActive) return;
    this.deployActive = false;
    this.deployPhase = 'done';
    this.locked = false;
    this.landResult = this.classifyLand();
    this.goal = null;
    this.route = [];
    this.queue = [];
    this.arrived = true;
    this.replanMsg = `PLACE MAPPED · LAND = ${this.landResult.label} ${this.landResult.conf.toFixed(0)}% · ${this.dataset.length} novel · ${this.deployOdom.toFixed(0)}m${note ? ' · ' + note : ''}`;
    this.emit();
  }

  /** Match observed soil mix + obstacle mix + air temp against measured
   *  biome profiles. Obstacle kinds carry the strongest signal (a Thar run
   *  never passes a tree); soil mix is compared to grid-measured ground
   *  truth, nominal populations to the build-time snapshot. Deployed waste
   *  and traffic never vote on the land. */
  private classifyLand(): LandResult {
    const OBS_KEYS = ['tree', 'boulder', 'bush', 'mud', 'water', 'sand', 'pit_small', 'pit_large', 'pothole', 'car_parked', 'cone', 'crop', 'post', 'building'];
    const soilTotal = PROFILE_SOILS.reduce((s, k) => s + (this.deploySoil[k] ?? 0), 0) || 1;
    const obsTotal = OBS_KEYS.reduce((s, k) => s + (this.deployObs[k] ?? 0), 0) || 1;
    const obsAir = this.deployTempN ? 12 + (this.deployTempSum / this.deployTempN - 45) * 0.5 : 20;
    const scored = PRESETS.map((p) => {
      // soil cosine vs measured profile
      const prof = soilProfile(p.id);
      let dot = 0;
      let no = 0;
      let nw = 0;
      for (const k of PROFILE_SOILS) {
        const f = (this.deploySoil[k] ?? 0) / soilTotal;
        dot += f * prof[k];
        no += f * f;
        nw += prof[k] * prof[k];
      }
      const soilCos = dot / (Math.sqrt(no * nw) || 1);
      // obstacle cosine: exact build-time snapshot for this world, placement
      // recipes elsewhere
      const recipe = (q: typeof p, k: string): number => {
        const base: Record<string, number> = {
          tree: q.trees, boulder: q.rocks, bush: q.bushes, mud: q.mud,
          water: q.water,
          sand: q.sand, pit_small: q.pits, pit_large: q.pitL, pothole: q.holes,
          car_parked: q.cars, cone: q.cones,
          crop: q.crops, post: q.posts, building: q.buildings
        };
        return base[k] ?? 0;
      };
      let odot = 0;
      let ono = 0;
      let onw = 0;
      for (const k of OBS_KEYS) {
        const f = (this.deployObs[k] ?? 0) / obsTotal;
        const wgt = p.id === this.preset.id ? (this.nominalObs[k] ?? 0) : recipe(p, k);
        odot += f * wgt;
        ono += f * f;
        onw += wgt * wgt;
      }
      const obsCos = odot / (Math.sqrt(ono * onw) || 1);
      const pAir = 12 + (p.thermal - 45) * 0.5;
      const tempScore = Math.exp(-(((obsAir - pAir) / 12) ** 2));
      return { label: p.label, score: 0.5 * soilCos + 0.35 * obsCos + 0.15 * tempScore };
    });
    scored.sort((a, b) => b.score - a.score);
    // sharpen into a decision: softmax over scores so the winner reads clear
    const ex = scored.map((q) => Math.exp(q.score * 6));
    const esum = ex.reduce((s, v) => s + v, 0) || 1;
    return {
      label: scored[0].label,
      conf: (ex[0] / esum) * 100,
      runner: scored[1].label,
      runnerConf: (ex[1] / esum) * 100
    };
  }

  /** Nearest-prototype novelty: count a view per obstacle per 2 s in cone. */
  private updateNovelty() {
    const fx = Math.cos(this.pose.theta);
    const fy = Math.sin(this.pose.theta);
    const air = 12 + (this.effectiveThermal() - 45) * 0.5;
    for (const o of this.obstacles) {
      if (!(NOVEL_KINDS as readonly string[]).includes(o.kind)) continue;
      const rx = o.x - this.pose.x;
      const ry = o.y - this.pose.y;
      const along = rx * fx + ry * fy;
      if (along < -0.5 || along > 12) continue;
      let rel = Math.atan2(ry, rx) - this.pose.theta;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) > 0.7 && along > 1.5) continue;
      if (this.simTime - (this.viewT.get(o.id) ?? -99) < 2) continue;
      this.viewT.set(o.id, this.simTime);
      const temp = obstacleTemp(o, this.effectiveThermal(), this.night);
      const sig = signatureOf(o.kind, o.r, temp, air);
      const { dist } = noveltyDistance(sig, this.effectiveThermal(), this.night);
      if (dist < NOVELTY_THRESHOLD) continue; // recognized after all
      let e = this.dataset.find((d) => d.kind === o.kind);
      if (!e) {
        this.unkCounter++;
        e = {
          code: `UNK-${String(this.unkCounter).padStart(2, '0')}`,
          kind: o.kind, label: NOVEL_LABEL[o.kind] ?? o.kind,
          views: 0, samples: 0, conf: 0, promoted: false,
          firstT: this.simTime, firstX: o.x, firstY: o.y,
          size: o.r, temp, novelty: dist
        };
        this.dataset.push(e);
        this.seenIds.set(o.kind, new Set());
      }
      const set = this.seenIds.get(o.kind)!;
      set.add(o.id);
      e.views++;
      e.samples = set.size;
      e.size = e.size * 0.8 + o.r * 0.2;
      e.temp = e.temp * 0.8 + temp * 0.2;
      e.conf = Math.min(99, 20 + e.views * 12);
      if (!e.promoted && e.views >= 5 && e.conf >= 80) e.promoted = true;
    }
  }
  private assessContact() {
    const near = this.nearestHard();
    if (near.dist > 0.35 || near.id < 0) return;
    if (this.simTime < this.contactCooldownUntil) return;
    this.contactCooldownUntil = this.simTime + 4;
    this.contactFreezeUntil = this.simTime + 0.5;
    this.contacts++;
    const impactV = this.actV;
    const wrap = (a: number) => {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    const obsBearing = Math.atan2(near.y - this.pose.y, near.x - this.pose.x);
    const headOn = Math.abs(wrap(obsBearing - this.pose.theta)) < 0.6;
    const speedK = clamp(impactV / 1.6, 0.3, 1.5);
    const base = near.kind === 'bush' ? 0.5 : near.kind === 'tree' ? 1.3 : 1.6;
    const dmg = Math.round(base * speedK * (headOn ? 1.3 : 0.6) * 10) / 10;
    this.health = clamp(this.health - dmg, 0, 100);
    this.compWheels = clamp(this.compWheels - dmg * 0.8, 0, 100);
    this.compHull = clamp(this.compHull - dmg * (headOn ? 1.0 : 0.4), 0, 100);
    this.compSensors = clamp(this.compSensors - dmg * 0.3, 0, 100);
    this.compBattery = clamp(this.compBattery - dmg * 0.2, 0, 100);
    // no-retouch: inflate this rock +0.8 m for 30 s so the next plan goes wide
    this.contacted.set(near.id, this.simTime + 30);
    const minor =
      this.health > 98 &&
      this.compHull >= 90 && this.compWheels >= 90 &&
      this.compSensors >= 90 && this.compBattery >= 90;
    const tag = `T+${this.simTime.toFixed(0)}s CONTACT ${near.kind}#${near.id} @${impactV.toFixed(1)}m/s ${headOn ? 'head-on' : 'glance'} -${dmg.toFixed(1)}hp`;
    this.damageLog.push(`${tag} -> health ${this.health.toFixed(1)}`);
    if (this.damageLog.length > 30) this.damageLog.shift();
    this.lastContactMsg = tag;
    if (minor && this.goal && !this.arrived && !this.goalBlocked) {
      // relocate: commit the far side for 7 s, face the latched escape,
      // replan around the inflated disc — the exit leg can't re-touch it
      const goalAng = Math.atan2(this.goal.y - this.pose.y, this.goal.x - this.pose.x);
      const diff = wrap(obsBearing - goalAng);
      this.avoidDir = Math.abs(diff) < 0.15 ? (this.avoidDir !== 0 ? this.avoidDir : 1) : diff > 0 ? -1 : 1;
      this.avoidUntil = this.simTime + 7;
      this.escapeAng = this.escapeHeading();
      this.smoothDh = 0;
      this.cautionLatch = true;
      this.preciseLatch = true;
      this.replan('contact relocate');
      this.escapeDriveT = 2.5;
      this.replanMsg = `CONTACT minor · hp ${this.health.toFixed(1)} · relocating · #${this.replanCount}`;
    } else if (!minor) {
      // major: hold 5 s for inspection, then auto-attempt one relocate
      // unless the hull is truly crippled (health < 85 or a component < 70)
      this.goalBlocked = true;
      this.contactHoldUntil = this.simTime + 5;
      this.replanMsg = `CONTACT major · hp ${this.health.toFixed(1)} · holding 5s — inspect`;
    }
    this.emit();
  }
  /** Apply a finished pit survey: pass -> crawl through, fail -> the pit
   *  becomes solid rock (inflated no-go ring) and we relocate around it. */
  private applyPitVerdict() {
    const s = this.survey;
    if (!s) return;
    const o = this.obstacles.find((q) => q.id === s.id);
    this.survey = null;
    if (!o || !isPitKind(o.kind)) return;
    // verdict from MEASURED values (what the camera saw)
    const vm = verdictFor(s.diaM / 2, s.depM);
    const pass = vm.pass;
    o.verdict = pass ? 'pass' : 'fail';
    this.surveyFlash = { x: o.x, y: o.y, r: o.r, pass, until: this.simTime + 4 };
    if (pass) {
      this.replanMsg = `SURVEY pass · Ø${vm.dia.toFixed(2)}m ${vm.depth.toFixed(2)}m deep — straddle, crawl`;
      this.replan('survey pass');
    } else {
      // same exit machinery as a contact: exempt the hull we sit on, commit
      // a side, replan around the new no-go ring — no re-touch on the way out
      this.surveyExemptId = o.id;
      const wrap = (a: number) => {
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        return a;
      };
      const obsBearing = Math.atan2(o.y - this.pose.y, o.x - this.pose.x);
      const goalAng = this.goal ? Math.atan2(this.goal.y - this.pose.y, this.goal.x - this.pose.x) : this.pose.theta;
      const diff = wrap(obsBearing - goalAng);
      this.avoidDir = Math.abs(diff) < 0.15 ? (this.avoidDir !== 0 ? this.avoidDir : 1) : diff > 0 ? -1 : 1;
      this.avoidUntil = this.simTime + 7;
      this.escapeAng = this.escapeHeading();
      this.smoothDh = 0;
      this.cautionLatch = true;
      this.preciseLatch = true;
      this.replan('survey impassable');
      this.escapeDriveT = 2.5;
      this.replanMsg = `SURVEY fail · Ø${vm.dia.toFixed(2)}m ${vm.depth.toFixed(2)}m — ${vm.reason} · rerouting`;
    }
    this.emit();
  }
  private checkCorridor() {
    if (!this.goal || this.arrived || this.route.length < 2) return;
    if (this.simTime - this.lastReplanT < 1.2) return; // short cooldown — dynamics need fast reaction
    const ahead = this.route.slice(this.routeIdx, this.routeIdx + 12);
    for (const pt of ahead) {
      for (const o of this.obstacles) {
        if (!this.shielded(o)) continue;
        // SAME margin as the planner (plus no-retouch inflation): a ribbon
        // point inside the guaranteed zone is already invalid
        if (Math.hypot(o.x - pt.x, o.y - pt.y) < o.r + this.marginFor(o)) {
          this.replan('corridor blocked');
          return;
        }
      }
    }
    let nearest = Infinity;
    for (let i = this.routeIdx; i < this.route.length; i++) {
      const d = Math.hypot(this.route[i].x - this.pose.x, this.route[i].y - this.pose.y);
      if (d < nearest) nearest = d;
    }
    if (nearest > 6 && this.simTime - this.lastReplanT > 6) this.replan('off-route');
  }
  /** Min edge clearance along the current heading ray (predictive, not just nose). */
  private rayThreat(maxDist: number): { dist: number; ox: number; oy: number } {
    let best = Infinity;
    let bx = 0;
    let by = 0;
    const dx = Math.cos(this.pose.theta);
    const dy = Math.sin(this.pose.theta);
    for (const o of this.obstacles) {
      if (!this.shielded(o)) continue;
      // project obstacle center onto heading ray
      const rx = o.x - this.pose.x;
      const ry = o.y - this.pose.y;
      const along = rx * dx + ry * dy;
      if (along < -1 || along > maxDist + o.r) continue;
      const lat = Math.abs(rx * dy - ry * dx);
      const edgeLat = lat - o.r;
      // only counts if the ray actually passes through the inflated disc
      // (touched rocks carry +0.8 m no-retouch inflation)
      if (edgeLat < this.marginFor(o) && along > 0) {
        const d = Math.max(0, along - o.r);
        if (d < best) {
          best = d;
          bx = o.x;
          by = o.y;
        }
      }
    }
    return { dist: best, ox: bx, oy: by };
  }
  /** Worst edge clearance sampling points along an arbitrary heading ray.
   * Used for escape-aligned release and close-body creep-out. */
  private clearanceAlong(angle: number, maxDist: number): number {
    let m = Infinity;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let s = 0.5; s <= maxDist + 1e-6; s += 0.5) {
      const px = this.pose.x + dx * s;
      const py = this.pose.y + dy * s;
      for (const o of this.obstacles) {
        if (!this.shielded(o)) continue;
        const d = Math.hypot(o.x - px, o.y - py) - o.r;
        if (d < m) m = d;
      }
    }
    return m;
  }
  addObstacle(kind: ObstacleKind, x: number, y: number) {
    let r =
      kind === 'boulder' ? 0.8 + Math.random() * 0.7
      : kind === 'tree' ? 0.45 + Math.random() * 0.3
      : kind === 'mud' ? 1.4 + Math.random() * 1.0
      : kind === 'water' ? 1.2 + Math.random() * 0.8
      : kind === 'sand' ? 1.6 + Math.random() * 1.0
      : kind === 'bush' ? 0.7 + Math.random() * 0.5
      : kind === 'pit_small' ? 0.22 + Math.random() * 0.08
      : kind === 'pit_large' ? 0.6 + Math.random() * 0.2
      : kind === 'pothole' ? 0.4 + Math.random() * 0.3
      : kind === 'car_parked' ? 1.9 + Math.random() * 0.4
      : kind === 'cone' ? 0.22 + Math.random() * 0.08
      : kind === 'crop' ? 0.25 + Math.random() * 0.15
      : kind === 'post' ? 0.14 + Math.random() * 0.04
      : kind === 'building' ? 3.5 + Math.random() * 3.0
      : 2.0 + Math.random() * 1.0;
    // pits carry depth (small shallow, large/pothole deep)
    const depth =
      kind === 'pit_small' ? 0.12 + Math.random() * 0.06
      : kind === 'pit_large' ? 0.35 + Math.random() * 0.2
      : kind === 'pothole' ? 0.3 + Math.random() * 0.3
      : undefined;
    // Drop-guard: never spawn a hard hull inside the UGV footprint. Push the
    // disc out along its bearing so its edge sits >=1.2 m from center. Close
    // pop-ups are still allowed — just never overlapping the chassis.
    if (HARD_KINDS.includes(kind)) {
      const dx0 = x - this.pose.x;
      const dy0 = y - this.pose.y;
      const d0 = Math.hypot(dx0, dy0);
      const minCenter = r + 1.2;
      if (d0 < minCenter) {
        const bearing = d0 > 1e-3 ? Math.atan2(dy0, dx0) : Math.atan2(-this.pose.y, -this.pose.x);
        x = this.pose.x + Math.cos(bearing) * minCenter;
        y = this.pose.y + Math.sin(bearing) * minCenter;
      }
    }
    const o: Obstacle = { id: this.nextId++, x, y, r, kind, depth };
    this.obstacles.push(o);
    if (this.obstacles.length > 1100) this.obstacles.shift();
    // Dynamic hard hazard: does it cut our committed ribbon or sit in our
    // forward cone? If yes, react NOW (commit side + instant replan) instead
    // of waiting until the nose is 1 m away. Failed pits count as rock.
    if ((HARD_KINDS.includes(kind) || kind === 'pit_large' || kind === 'pothole') && this.goal && !this.arrived) {
      const margin = this.planMargin();
      let hitsRoute = false;
      const ahead = this.route.slice(this.routeIdx, this.routeIdx + 14);
      for (const pt of ahead) {
        if (Math.hypot(o.x - pt.x, o.y - pt.y) < o.r + margin + 0.5) {
          hitsRoute = true;
          break;
        }
      }
      const dx = x - this.pose.x;
      const dy = y - this.pose.y;
      const dist = Math.hypot(dx, dy) - r;
      const goalAng = Math.atan2(this.goal.y - this.pose.y, this.goal.x - this.pose.x);
      let rel = Math.atan2(dy, dx) - goalAng;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const inFront = dist < 8 && Math.abs(rel) < 0.9;
      if (hitsRoute || inFront || dist < margin + 1) {
        // commit a pass side immediately so tracking doesn't dither
        if (this.avoidDir === 0) {
          const obsAng = Math.atan2(dy, dx);
          let diff = obsAng - goalAng;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          this.avoidDir = Math.abs(diff) < 0.15 ? 1 : diff > 0 ? -1 : 1;
          this.avoidUntil = this.simTime + 5;
        }
        this.cautionLatch = true;
        this.preciseLatch = true;
        this.hazardCooldownUntil = this.simTime + 0.4;
        this.replan('dynamic hazard');
      }
    }
    this.emit();
  }
  dropBoulderAhead() {
    const nx = this.pose.x + Math.cos(this.pose.theta) * 5;
    const ny = this.pose.y + Math.sin(this.pose.theta) * 5;
    this.addObstacle('boulder', nx, ny);
  }
  injectSlipBurst() {
    this.slipBurstUntil = this.simTime + 4;
  }
  smokeBurst() {
    this.smokeBurstUntil = this.simTime + 6;
  }
  thermalSoak() {
    this.thermalUntil = this.simTime + 12;
  }

  effectiveSmoke() {
    return clamp(this.params.smoke + (this.simTime < this.smokeBurstUntil ? 45 : 0), 0, 100);
  }
  effectiveThermal() {
    return this.params.thermal + (this.simTime < this.thermalUntil ? 8 : 0);
  }

  /** Advance physics + telemetry by dt seconds. Called from the 60fps canvas loop. */
  step(dt: number) {
    const p = this.params;
    const jitter = this.mode === 'live' ? 1.6 : this.mode === 'replay' ? 0.5 : 1.0;
    this.simTime += dt;
    const t = this.simTime;
    const smokeEff = this.effectiveSmoke();
    const snrDegraded = smokeEff > SNR_SMOKE_CUTOVER;

    // live traffic first: movers (and their linked collision discs) update
    // before shields/planners sample the world this frame
    if (this.movers.length || this.signals.length) this.stepTraffic(dt);

    // Soil + slope under the robot
    const { soil, mu: effMu } = effMuAt(this.pose.x, this.pose.y, p.friction);
    const slope = activeTerrain.slopeAt(this.pose.x, this.pose.y);
    const slopeUp = slope.dx * Math.cos(this.pose.theta) + slope.dy * Math.sin(this.pose.theta);

    // Nose position for Layer-0 shield check (hard geometric blockers only)
    const noseX = this.pose.x + Math.cos(this.pose.theta) * 0.9;
    const noseY = this.pose.y + Math.sin(this.pose.theta) * 0.9;
    let minEdge = Infinity;
    let minKind = '—';
    let minOX = 0;
    let minOY = 0;
    for (const o of this.obstacles) {
      if (!this.shielded(o)) continue;
      const d = Math.hypot(o.x - noseX, o.y - noseY) - o.r;
      if (d < minEdge) {
        minEdge = d;
        minKind = o.kind;
        minOX = o.x;
        minOY = o.y;
      }
    }
    // Layer-0 shield with wide hysteresis + committed pass side.
    // Trigger early (1.0 m nose) so the UGV reacts BEFORE touching the
    // margin ring; release late (1.8 m nose AND 1.5 m body) so it can't
    // flicker in/out every second at the boundary.
    const centerEdge = this.fullClearance();
    const wrapPi = (a: number) => {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    if (!this.override && (minEdge < 1.0 || centerEdge < 1.2)) {
      this.override = true;
      this.overrideSince = this.simTime;
      this.overrideCount++;
      this.lastOverrideMsg = `T+${this.simTime.toFixed(0)}s · ${minKind} @ ${Math.max(0, minEdge).toFixed(2)}m · CAN 0x201`;
      // Commit to a pass side ONCE at entry: obstacle left of goal -> go right, else left.
      // This single latch kills the 1s-to-1s left/right flip.
      const goalAng = this.goal ? Math.atan2(this.goal.y - this.pose.y, this.goal.x - this.pose.x) : this.pose.theta;
      const obsAng = Math.atan2(minOY - this.pose.y, minOX - this.pose.x);
      const diff = wrapPi(obsAng - goalAng);
      if (Math.abs(diff) < 0.15) {
        // head-on: keep the current turn direction, default left
        this.avoidDir = this.avoidDir !== 0 ? this.avoidDir : 1;
      } else {
        this.avoidDir = diff > 0 ? -1 : 1;
      }
      this.avoidUntil = this.simTime + 5;
      this.escapeAng = this.escapeHeading();
      // bias the latched escape toward the committed side so symmetric
      // corridors can't flip the choice next frame
      this.escapeAng = wrapPi(this.escapeAng) + this.avoidDir * 0.15;
      this.smoothDh = 0;
    } else if (this.override) {
      // Normal release: well clear all around.
      // Escape-aligned release: facing the latched escape corridor with room
      // ahead — turning in place can never grow centerEdge, so distance-only
      // release would deadlock a hull touch forever.
      // Timed fallback: after 4 s of turning, exit if aligned and not worse.
      const aligned = Math.abs(wrapPi(this.escapeAng - this.pose.theta)) < 0.3;
      const escClear = this.clearanceAlong(this.escapeAng, 2.0);
      const distClear = minEdge > 1.8 && centerEdge > 1.5;
      const alignClear = aligned && escClear > 0.6 && minEdge > 0.6;
      const timedOut = this.simTime - this.overrideSince > 4.0 && aligned && escClear > 0.3;
      if (distClear || alignClear || timedOut) {
        this.override = false;
        // two-phase escape: hold the committed side for ~2 s after release
        // so the tracker can't turn straight back into the same rock
        if (this.simTime - this.overrideSince > 0.4 && this.goal && !this.arrived) {
          this.replan('override cleared');
          this.escapeDriveT = 2.0;
          this.avoidUntil = Math.max(this.avoidUntil, this.simTime + 3);
        }
      }
    }
    // while overridden, HOLD the latched escape — do not chase a fresh sample
    // every frame (that chase is what spun in place). Only re-sample if we
    // have been stuck turning for >3 s, and then commit to the new angle.
    if (this.override) {
      if (this.actV < 0.15 && this.simTime - this.overrideSince > 3.0 && this.simTime > this.hazardCooldownUntil) {
        const fresh = this.escapeHeading();
        let d = wrapPi(fresh - this.escapeAng);
        if (Math.abs(d) < Math.PI / 2) {
          this.escapeAng = fresh;
          this.hazardCooldownUntil = this.simTime + 1.5;
        }
      }
    }
    if (this.simTime > this.avoidUntil) this.avoidDir = 0;
    if (this.escapeDriveT > 0) this.escapeDriveT -= dt;
    // expire old no-retouch zones
    if (this.contacted.size) {
      for (const [id, until] of [...this.contacted]) {
        if (this.simTime > until) this.contacted.delete(id);
      }
    }
    // hull touch -> assess damage, inflate that rock, relocate if minor
    this.assessContact();
    // major-hold expiry: one automatic relocate attempt unless crippled
    if (this.contactHoldUntil > 0 && this.simTime > this.contactHoldUntil) {
      this.contactHoldUntil = -1;
      const minComp = Math.min(this.compHull, this.compWheels, this.compSensors, this.compBattery);
      if (this.health >= 85 && minComp >= 70 && this.goal && !this.arrived) {
        this.goalBlocked = false;
        const wrap = (a: number) => {
          while (a > Math.PI) a -= Math.PI * 2;
          while (a < -Math.PI) a += Math.PI * 2;
          return a;
        };
        const near = this.nearestHard();
        if (near.id >= 0) {
          const goalAng = Math.atan2(this.goal.y - this.pose.y, this.goal.x - this.pose.x);
          const obsBearing = Math.atan2(near.y - this.pose.y, near.x - this.pose.x);
          const diff = wrap(obsBearing - goalAng);
          this.avoidDir = Math.abs(diff) < 0.15 ? 1 : diff > 0 ? -1 : 1;
          this.avoidUntil = this.simTime + 7;
        }
        this.escapeAng = this.escapeHeading();
        this.smoothDh = 0;
        this.cautionLatch = true;
        this.preciseLatch = true;
        this.replan('contact retry');
        this.escapeDriveT = 2.5;
        this.replanMsg = `CONTACT hold over · hp ${this.health.toFixed(1)} · relocating · #${this.replanCount}`;
      }
    }
    const frozen = this.simTime < this.contactFreezeUntil;
    this.rawMarginX = minOX;
    this.rawMarginY = minOY;
    // OS1-32 return census at 2 Hz (full 360° from the mast)
    this.lidarT += dt;
    if (this.lidarT > 0.5) {
      this.lidarT = 0;
      let returns = 0;
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let range = 12;
        for (const o of this.obstacles) {
          const rr = lidarRadius(o);
          if (rr === null) continue;
          if (lidarPartial(o.kind)) continue; // census counts solid returns only
          const tt = rayCircle(this.pose.x, this.pose.y, dx, dy, o.x, o.y, rr);
          if (tt !== null && tt < range) range = tt;
        }
        if (range < 11.9) returns++;
      }
      this.lidarReturns = returns;
      this.rawMargin = minEdge;
      this.rawMarginKind = minKind;
    }

    // caution ring with hysteresis: enter at bubble, exit 0.8 m later.
    // Without this the 1.2 m/s <-> full-speed switch flickers every frame at the edge.
    const bubbleR = Math.max(1.5, p.bubble);
    if (!this.cautionLatch && minEdge < bubbleR) this.cautionLatch = true;
    else if (this.cautionLatch && minEdge > bubbleR + 0.8) this.cautionLatch = false;
    // precision mode with hysteresis too: enter 2.2 m, exit 2.8 m
    if (!this.preciseLatch && minEdge < 2.2) this.preciseLatch = true;
    else if (this.preciseLatch && minEdge > 2.8) this.preciseLatch = false;
    // Predictive forward check: what's sitting on our heading ray in the
    // next ~6 m? Fires BEFORE the nose ring, so a dynamic rock dropped
    // 5 m ahead slows + replans instead of being hit at speed.
    const lookDist = clamp(this.actV * 2.0 + 3.0, 3.0, 6.5);
    const threat = this.goal && !this.arrived && !this.override ? this.rayThreat(lookDist) : { dist: Infinity, ox: 0, oy: 0 };
    const predicted = threat.dist < lookDist;
    if (predicted) {
      this.cautionLatch = true;
      this.preciseLatch = true;
      if (this.avoidDir === 0 && this.goal) {
        const goalAng = Math.atan2(this.goal.y - this.pose.y, this.goal.x - this.pose.x);
        const obsAng = Math.atan2(threat.oy - this.pose.y, threat.ox - this.pose.x);
        let diff = obsAng - goalAng;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.avoidDir = Math.abs(diff) < 0.15 ? 1 : diff > 0 ? -1 : 1;
        this.avoidUntil = this.simTime + 4;
      }
      if (this.simTime > this.hazardCooldownUntil && this.simTime - this.lastReplanT > 1.0) {
        this.hazardCooldownUntil = this.simTime + 1.2;
        this.replan('threat ahead');
      }
    }
    this.caution = !this.override && (this.cautionLatch || predicted);

    // ---- Pit / pothole camera survey (RGB-D vision, front cone ±0.6 rad) ----
    // Pits are LiDAR-blind depressions: the camera spots them, the UGV creeps
    // to a 0.3 m hold, projects a measuring grid, then passes or reroutes.
    let pitNose = Infinity;
    let pitTarget: Obstacle | null = null;
    {
      const fx = Math.cos(this.pose.theta);
      const fy = Math.sin(this.pose.theta);
      for (const o of this.obstacles) {
        if (!isPitKind(o.kind) || o.verdict) continue; // decided pits: drive through / route around
        if (this.survey && o.id !== this.survey.id) {
          // one survey at a time: ignore other pits until this one resolves
          continue;
        }
        const rx = o.x - this.pose.x;
        const ry = o.y - this.pose.y;
        const along = rx * fx + ry * fy;
        if (along < -0.5 || along > 6.5) continue;
        let rel = Math.atan2(ry, rx) - this.pose.theta;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        if (Math.abs(rel) > 0.6 && along > 1.2) continue;
        const nd = Math.hypot(o.x - noseX, o.y - noseY) - o.r;
        if (nd < pitNose) {
          pitNose = nd;
          pitTarget = o;
        }
      }
    }
    this.pitApproachDist = pitTarget ? pitNose : Infinity;
    this.pitTargetId = pitTarget ? (pitTarget as Obstacle).id : -1;
    const surveying = this.survey !== null;
    if (pitTarget && !this.override && !this.goalBlocked && !this.estop) {
      this.cautionLatch = true;
      if (pitNose > SURVEY_HOLD + 0.03) {
        // creep up to the hold line; survey starts once we are there
        if (this.survey && this.survey.id !== (pitTarget as Obstacle).id) this.survey = null;
      } else if (!this.survey || this.survey.id !== (pitTarget as Obstacle).id) {
        const pt = pitTarget as Obstacle;
        const dep = pt.depth ?? 0.15;
        this.survey = {
          id: pt.id, x: pt.x, y: pt.y, r: pt.r, depth: dep,
          diaM: Math.max(0.05, pt.r * 2 + Math.sin(pt.id * 7.3) * 0.03),
          depM: Math.max(0.02, dep + Math.sin(pt.id * 3.1) * 0.02),
          phase: 'project', t0: this.simTime
        };
        this.replanMsg = `RGB-D survey · Ø${(pt.r * 2).toFixed(2)}m pit · holding ${SURVEY_HOLD.toFixed(1)}m`;
      }
    } else if (!pitTarget) {
      this.survey = null;
    }
    // advance the survey clock (frozen while Layer-0 is turning us)
    if (this.survey) {
      if (this.override) {
        this.survey.t0 += dt;
      } else {
        const e = this.simTime - this.survey.t0;
        this.survey.phase = e < 1.0 ? 'project' : e < 2.2 ? 'measure' : 'verdict';
        if (e >= 3.0) this.applyPitVerdict();
      }
    }
    // clear the exit exemption once the failed pit is truly behind us
    if (this.surveyExemptId >= 0) {
      const ex = this.obstacles.find((o) => o.id === this.surveyExemptId);
      if (!ex) {
        this.surveyExemptId = -1;
      } else {
        const nd = Math.hypot(ex.x - noseX, ex.y - noseY) - ex.r;
        if (nd > 1.8) this.surveyExemptId = -1;
      }
    }

    // No reverse gear: every translation follows a margin-validated route.
    // Recovery is turn-in-place (center fixed, always safe) + backtrack routing.
    // Contact assessment freeze and active pit surveys also hold translation.
    let cmdV = 0;
    {
      cmdV = this.estop || this.override || frozen || surveying || this.scanHolding() ? 0 : this.arrived || this.goalBlocked ? 0 : this.caution ? Math.min(p.velocity, 1.2) : p.velocity;
      if (this.goal && !this.arrived && !this.goalBlocked && !this.estop) {
        if (this.route.length < 2) {
          // no valid corridor: hold safely and retry, never beeline blind
          cmdV = 0;
          this.corridorT += dt;
          if (this.corridorT > 1.5) {
            this.corridorT = 0;
            this.replan('retry');
          }
        } else {
        // pure pursuit along the ribbon: snap index to nearest waypoint, then
        // walk Ld of ARC LENGTH forward — the target can never leap across uncleared space
        // while override-braked, face the LATCHED escape heading (not a fresh
        // sample every frame — fresh sampling is what flipped 1s-to-1s)
        const escapeAng = this.override ? this.escapeAng : 0;
        let bi = this.routeIdx;
        let bd = Infinity;
        const hi0 = Math.min(this.route.length, this.routeIdx + 14);
        for (let i = this.routeIdx; i < hi0; i++) {
          const d = Math.hypot(this.route[i].x - this.pose.x, this.route[i].y - this.pose.y);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        this.routeIdx = bi;
        const precise = this.preciseLatch;
        // Ld moves smoothly with distance instead of jumping 1.2 <-> 2.8 at a line
        const Ld = precise ? 1.2 : clamp(1.5 + this.actV * 0.8, 1.5, 4);
        let target = this.route.length ? this.route[this.route.length - 1] : this.goal;
        let acc = -bd;
        for (let i = bi + 1; i < this.route.length; i++) {
          acc += Math.hypot(this.route[i].x - this.route[i - 1].x, this.route[i].y - this.route[i - 1].y);
          if (acc >= Ld) {
            target = this.route[i];
            break;
          }
        }
        const want = this.override
          ? escapeAng
          : Math.atan2(target.y - this.pose.y, target.x - this.pose.x);
        let dh = want - this.pose.theta;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        // Stanley path tracking: tangent heading + cross-track correction.
        // Near hard blockers, track the ribbon tangent exactly (no corner cutting).
        if (this.route.length > 1 && !this.override) {
          let bi = this.routeIdx;
          let bd = Infinity;
          const hi = Math.min(this.route.length, this.routeIdx + 10);
          for (let i = this.routeIdx; i < hi; i++) {
            const d = Math.hypot(this.route[i].x - this.pose.x, this.route[i].y - this.pose.y);
            if (d < bd) {
              bd = d;
              bi = i;
            }
          }
          const pa = this.route[Math.max(0, bi - 1)];
          const pb = this.route[Math.min(this.route.length - 1, bi + 1)];
          const sx = pb.x - pa.x;
          const sy = pb.y - pa.y;
          const segLen = Math.hypot(sx, sy) || 1;
          const cte = ((this.pose.x - pa.x) * -sy + (this.pose.y - pa.y) * sx) / segLen;
          if (precise && segLen > 0.5) {
            dh = Math.atan2(sy, sx) - this.pose.theta;
            while (dh > Math.PI) dh -= Math.PI * 2;
            while (dh < -Math.PI) dh += Math.PI * 2;
            dh += clamp(-Math.atan2(1.0 * cte, Math.max(0.8, this.actV)), -0.5, 0.5);
            while (dh > Math.PI) dh -= Math.PI * 2;
            while (dh < -Math.PI) dh += Math.PI * 2;
          } else {
            dh += clamp(-Math.atan2(0.8 * cte, Math.max(1, this.actV)), -0.5, 0.5);
          }
        }
        // Hold the committed pass side for a few seconds after an override:
        // bias the turn away from the obstacle so the nose can't swing back
        // into the same rock the moment the shield releases (the old ping-pong).
        if (!this.override && this.avoidDir !== 0 && minEdge < 4) {
          const escaping = this.escapeDriveT > 0;
          const bias = (escaping ? 0.5 : 0.3) * Math.exp(-Math.max(0, minEdge - 1.5) / 2);
          dh += this.avoidDir * bias;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
        }
        // rate-limit + low-pass the steering. Override turns slowest so it
        // can't whip past the corridor and re-trigger; deadband stops the
        // constant micro-yaw that read as spinning.
        const turnCap = (this.override ? 0.9 : precise || this.cautionLatch ? 1.2 : 2.2) * dt;
        if (Math.abs(dh) < 0.14) {
          this.smoothDh *= 0.5;
        } else {
          this.smoothDh += (dh - this.smoothDh) * Math.min(1, dt * 6);
        }
        const applied = clamp(this.smoothDh, -turnCap, turnCap);
        this.pose.theta += Math.abs(this.smoothDh) < 0.05 ? 0 : applied;
        // keep the filter honest when clamped so it can't wind up and whip back
        this.smoothDh = applied + (this.smoothDh - applied) * 0.4;
        if (!this.override) {
          // turn-then-drive: just after an override, finish the turn first.
          // Translating while >15° off target is what carved the spin.
          const turningSharp = this.escapeDriveT > 0 && Math.abs(dh) > 0.26;
          // body still inside the floor band: rotate only, UNLESS facing a
          // clear corridor — turn-in-place alone can never grow centerEdge,
          // so a hard stop here deadlocks a hull touch forever
          const bodyClose = centerEdge < 1.5;
          // slow for curvature and for close proximity (smooth low-cost approach)
          cmdV *= clamp(1 - Math.abs(this.smoothDh) / 1.2, 0.25, 1);
          if (minEdge < 3) cmdV = Math.min(cmdV, 1.2 + Math.max(0, minEdge - 1.5) * 1.4);
          if (precise) cmdV = Math.min(cmdV, 0.8); // precision crawl near hard blockers
          // predictive brake: threat on the heading ray but nose ring not yet
          // tripped — bleed speed with distance so we arrive slow, never hot
          if (predicted) cmdV = Math.min(cmdV, 0.5 + Math.max(0, threat.dist - 1.5) * 0.35);
          // pit approach: creep to the 0.3 m survey hold line, never past it
          if (pitTarget && !surveying) {
            cmdV = Math.min(cmdV, clamp((pitNose - SURVEY_HOLD) * 1.2, 0, 0.8));
          }
          // straddling a surveyed pit: crawl through the mud, never sprint
          for (const o of this.obstacles) {
            if (!isPitKind(o.kind) || o.verdict === 'fail') continue;
            if (Math.hypot(o.x - this.pose.x, o.y - this.pose.y) < o.r + 1.0) {
              cmdV = Math.min(cmdV, 0.5);
              break;
            }
          }
          if (turningSharp) {
            cmdV = 0;
          } else if (bodyClose) {
            const corridorAhead = this.clearanceAlong(this.pose.theta, 2.0);
            const onTarget = Math.abs(dh) < 0.4;
            cmdV = corridorAhead > 0.6 && onTarget ? Math.min(cmdV, 0.4) : 0;
          }
          // arrival braking curve: sweep into the point, don't halt onto it
          const dGoalArr = Math.hypot(this.goal.x - this.pose.x, this.goal.y - this.pose.y);
          if (dGoalArr < 10) cmdV = Math.min(cmdV, 0.4 + 2.4 * Math.sqrt(Math.max(0, dGoalArr) / 10));
          if (dGoalArr < 2.5) {
            if (this.deployActive) {
              // explore leg done: chain a fresh random leg until 50 m
              this.legsDone++;
              if (this.simTime > this.deployRetryT) this.deployNext();
            } else if (this.queue.length) {
              // fly-through leg: keep rolling into the next waypoint
              this.goal = this.queue.shift()!;
              this.legsDone++;
              this.routeIdx = 0;
              this.actV = Math.min(this.actV, 1.0);
              this.replanMsg = `leg ${this.legsDone} complete → next`;
              this.replan('next leg');
            } else if (this.loopMission) {
              this.loopsDone++;
              this.buildPatrol();
              this.replanMsg = `patrol loop ×${this.loopsDone} · ${this.replanCount} replans`;
            } else {
              this.arrived = true;
              this.replanMsg = `arrived · ${this.replanCount} replans en route`;
              this.emit();
            }
          }
          this.corridorT += dt;
          if (this.corridorT > 0.6) {
            this.corridorT = 0;
            this.checkCorridor();
          }
        }
        // stuck with no reverse gear: fresh plan + turn-in-place does the work
        if (this.actV < 0.15 && !this.goalBlocked) {
          this.stuckT += dt;
          if (this.stuckT > 3) {
            this.stuckT = 0;
            this.replanMsg = 'stuck · replanning';
            this.replan('stuck');
          }
        } else {
          this.stuckT = 0;
        }
        // no-progress watch: only a robot that is neither traveling nor
        // approaching is declared blocked — slow maze driving never trips it
        const dGoal = Math.hypot(this.goal.x - this.pose.x, this.goal.y - this.pose.y);
        this.travelAcc += Math.abs(this.actV) * dt;
        this.stallWindowT += dt;
        if (this.stallWindowT > 30) {
          const improved = this.windowStartDist - dGoal;
          if (this.travelAcc < 4 && improved < 0.5) {
            if (this.deployActive) {
              // never hold during configure runs: roll a new random leg
              this.deployNext();
            } else {
              this.goalBlocked = true;
              this.replanMsg = `goal unreachable · holding at ${dGoal.toFixed(0)}m`;
              this.emit();
            }
          }
          this.travelAcc = 0;
          this.stallWindowT = 0;
          this.windowStartDist = dGoal;
        }
        }
      } else if (!this.goal && !surveying) {
        if (this.scanHolding()) {
          this.pose.theta += 1.2 * dt; // panorama sweep: full 360° in ~5.2 s
        } else {
          this.pose.theta = 0.22 * Math.sin(t * 0.07);
        }
      }
      // jerk-limited drive: brisk throttle, strong smooth braking
      const rate = cmdV > this.actV ? 2.2 : 5.0;
      this.actV += (cmdV - this.actV) * Math.min(1, dt * rate);
      this.pose.x += Math.cos(this.pose.theta) * this.actV * dt;
      this.pose.y += Math.sin(this.pose.theta) * this.actV * dt;
      this.wrapPose();
      // pose trail: proven-free breadcrumbs for backtrack recovery
      const lastTrail = this.trail[this.trail.length - 1];
      if (!lastTrail || Math.hypot(this.pose.x - lastTrail.x, this.pose.y - lastTrail.y) > 0.5) {
        this.trail.push({ x: this.pose.x, y: this.pose.y });
        if (this.trail.length > 30) this.trail.shift();
      }
      // deploy odometer + terrain sampling + novelty views
      if (this.deployActive) {
        if (this.deployPhase === 'scan') {
          // panorama done after a full turn: roll into random travel legs
          if (t - this.deploySampleT > 0.5) {
            this.deploySampleT = t;
            const soil = activeTerrain.soilAt(this.pose.x, this.pose.y);
            this.deploySoil[soil.id] = (this.deploySoil[soil.id] ?? 0) + 1;
            this.deployTempSum += this.effectiveThermal();
            this.deployTempN++;
            // obstacle census along the traverse (common kinds only — the
            // waste we dropped ourselves never votes on the land)
            for (const o of this.obstacles) {
              if (this.deployObsIds.has(o.id)) continue;
              const k = o.kind;
              if (k !== 'tree' && k !== 'boulder' && k !== 'bush' && k !== 'mud' && k !== 'water' && k !== 'sand' && k !== 'pit_small' && k !== 'pit_large' && k !== 'pothole' && k !== 'car_parked' && k !== 'cone' && k !== 'crop' && k !== 'post' && k !== 'building') continue;
              if (Math.hypot(o.x - this.pose.x, o.y - this.pose.y) > 15) continue;
              this.deployObsIds.add(o.id);
              this.deployObs[k] = (this.deployObs[k] ?? 0) + 1;
            }
          }
          if (this.simTime - this.deployScanT0 >= 5.2) {
            this.deployPhase = 'travel';
            this.deployNext();
          }
          this.replanMsg = 'SCANNING ENVIRONMENT · 360° sweep';
        } else {
          this.deployOdom += Math.abs(this.actV) * dt;
          if (t - this.deploySampleT > 0.5) {
            this.deploySampleT = t;
            const soil = activeTerrain.soilAt(this.pose.x, this.pose.y);
            this.deploySoil[soil.id] = (this.deploySoil[soil.id] ?? 0) + 1;
            this.deployTempSum += this.effectiveThermal();
            this.deployTempN++;
            // obstacle census along the traverse (common kinds only — the
            // waste we dropped ourselves never votes on the land)
            for (const o of this.obstacles) {
              if (this.deployObsIds.has(o.id)) continue;
              const k = o.kind;
              if (k !== 'tree' && k !== 'boulder' && k !== 'bush' && k !== 'mud' && k !== 'water' && k !== 'sand' && k !== 'pit_small' && k !== 'pit_large' && k !== 'pothole' && k !== 'car_parked' && k !== 'cone' && k !== 'crop' && k !== 'post' && k !== 'building') continue;
              if (Math.hypot(o.x - this.pose.x, o.y - this.pose.y) > 15) continue;
              this.deployObsIds.add(o.id);
              this.deployObs[k] = (this.deployObs[k] ?? 0) + 1;
            }
          }
          if (!this.goal && this.simTime > this.deployRetryT) this.deployNext();
          if (this.deployOdom >= this.nextLandAt) {
            // live area read while traveling: LAND ≈ … until 50 m sets it
            this.nextLandAt += 5;
            this.landResult = this.classifyLand();
          }
          this.replanMsg = `TRAVEL-SCAN · ${this.deployOdom.toFixed(1)}/${this.deployTarget.toFixed(0)}m · ${this.dataset.length} novel${this.landResult ? ` · LAND ≈ ${this.landResult.label} ${this.landResult.conf.toFixed(0)}%` : ''}`;
          if (this.deployOdom >= this.deployTarget) this.finishDeploy();
        }
      }
      this.updateNovelty();
      this.driveState = this.estop ? 'estop' : this.override ? 'override' : surveying ? 'surveying' : this.deployActive ? 'enroute' : this.arrived ? 'arrived' : this.goalBlocked ? 'blocked' : this.caution ? 'caution' : this.goal ? 'enroute' : 'patrol';
    }

    // --- Terramechanics: soft-hazard proximity fields ---
    let mudProx = 0;
    let waterProx = 0;
    let sandProx = 0;
    let pitProx = 0;
    for (const o of this.obstacles) {
      const d = Math.hypot(o.x - this.pose.x, o.y - this.pose.y);
      const g = Math.exp(-(d * d) / (o.r * o.r * 2.2 + 2));
      if (o.kind === 'mud') mudProx = Math.max(mudProx, g);
      else if (o.kind === 'water') waterProx = Math.max(waterProx, g);
      else if (o.kind === 'sand') sandProx = Math.max(sandProx, g);
      else if (isPitKind(o.kind) && o.verdict !== 'fail') pitProx = Math.max(pitProx, g);
    }
    const slipBase = (1 - effMu) * 0.55 * (0.35 + 0.65 * Math.min(1, this.actV / 2.5)) * soil.slipMul;
    const burst = t < this.slipBurstUntil ? 0.35 * Math.sin(t * 9) ** 2 + 0.2 : 0;
    const extra = mudProx * 0.3 + waterProx * 0.45 + sandProx * 0.25 + pitProx * 0.35 + burst;
    const slipL = clamp(slipBase + extra + 0.05 * Math.sin(t * 3.1) + rnd(0.02 * jitter), 0, 1);
    const slipR = clamp(slipBase + extra + 0.05 * Math.sin(t * 3.7 + 1.3) + rnd(0.02 * jitter), 0, 1);
    const gradeLoad = slopeUp * this.actV * 2.4 + Math.max(0, slopeUp) * 3;
    const softLoad = sandProx * 4 + mudProx * 3 + waterProx * 2 + pitProx * 3.5;
    const curL = (3.5 + this.actV * 2.8 * soil.loadMul + slipL * 7 + gradeLoad + softLoad) * 1 + rnd(0.25 * jitter);
    const curR = (3.5 + this.actV * 2.8 * soil.loadMul + slipR * 7 + gradeLoad + softLoad) * 1 + rnd(0.25 * jitter);
    const vib = 0.4 + this.actV * 0.5 + (1 - effMu) * 1.6 + slope.mag * 1.8 + Math.abs(Math.sin(t * 11)) * 0.3 * jitter + rnd(0.1);
    const ax = (cmdV - this.actV) * 1.4 - slopeUp * 4.5 + rnd(0.15 * jitter);
    const az = 9.81 + rnd(0.12 * jitter) + vib * 0.08;

    // VIO drift bounded under 0.45 m/100m; ZUPT zeroes it at standstill
    if (this.actV < 0.08) this.vioAcc = Math.max(0.02, this.vioAcc - dt * 0.05);
    else this.vioAcc = Math.min(0.44, this.vioAcc + this.actV * dt * 0.0016 * (1.35 - effMu));
    const vio = clamp(this.vioAcc + 0.02 * Math.sin(t * 0.9) + rnd(0.006), 0, 0.45);

    // Jetson thermals + throttle
    const thermEff = this.effectiveThermal();
    const temp = clamp(thermEff * 0.82 + 12 + this.actV * 1.1 + this.obstacles.length * 0.03 + rnd(0.4), 40, 98);
    const throttled = temp > 82;
    const lat = 7.2 + this.obstacles.length * 0.02 + smokeEff * 0.03 + (throttled ? 6.5 : 0) + (snrDegraded ? 1.8 : 0) + rnd(0.5 * jitter);
    const fps = clamp(128 - (throttled ? 52 : 0) - smokeEff * 0.28 - this.obstacles.length * 0.08 + rnd(2.5), 30, 140);
    const vram = 1.15 + this.obstacles.length * 0.008 + smokeEff * 0.002;
    const lag = 300 + rnd(6) + (throttled ? 40 : 0);
    const planeInliers = clamp(97.5 - smokeEff * 0.06 - mudProx * 2 + rnd(0.4), 80, 99.5);

    this.latest = {
      slipL, slipR, curL, curR, ax, az, vib, vio, zupt: this.actV < 0.08,
      lat, fps, temp, vram, lag, cmdV, actV: this.actV,
      backpropHz: throttled ? 2 : 10, throttled, planeInliers, snrDegraded,
      soil: soil.id, soilLabel: soil.label, soilMu: effMu,
      caution: this.caution, goalDist: this.goal ? Math.hypot(this.goal.x - this.pose.x, this.goal.y - this.pose.y) : -1,
      margin: this.rawMargin, marginKind: this.rawMarginKind, lidarReturns: this.lidarReturns,
      health: this.health, compHull: this.compHull, compWheels: this.compWheels,
      compSensors: this.compSensors, compBattery: this.compBattery, contacts: this.contacts
    };

    if (t - this.lastPush > 0.1) {
      this.lastPush = t;
      const h = this.hist;
      const push = (k: keyof typeof h, v: number) => {
        h[k].push(v);
        if (h[k].length > HIST) h[k].shift();
      };
      push('slipL', slipL); push('slipR', slipR); push('curL', curL); push('curR', curR);
      push('vib', vib); push('vio', vio); push('lat', lat); push('temp', temp);
    }
    if (t - this.lastNotify > 0.1) {
      this.lastNotify = t;
      this.version++;
      this.emit();
    }
  }
}

const SimCtx = createContext<SparshSim | null>(null);

export function SimProvider({ children }: { children: React.ReactNode }) {
  const sim = useMemo(() => new SparshSim(), []);
  return <SimCtx.Provider value={sim}>{children}</SimCtx.Provider>;
}

export function useSim(): SparshSim {
  const s = useContext(SimCtx);
  if (!s) throw new Error('useSim outside provider');
  return s;
}

/** Re-render the component at ~10Hz with the live sim snapshot. */
export function useSimView(): SparshSim {
  const sim = useSim();
  const [, setTick] = useState(0);
  useEffect(() => sim.subscribe(() => setTick((x) => x + 1)), [sim]);
  return sim;
}
