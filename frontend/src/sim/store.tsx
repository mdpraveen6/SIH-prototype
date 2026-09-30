import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { PRESETS, PresetDef, SoilId, WORLD_H, WORLD_W, activeTerrain, effMuAt, mulberry32, setActivePreset } from './terrain';
import { planRoute } from './astar';
import { lidarPartial, lidarRadius, rayCircle } from './mppi';

export { WORLD_W, WORLD_H };

export type ObstacleKind = 'mud' | 'boulder' | 'smoke' | 'tree' | 'bush' | 'water' | 'sand';
export type OpMode = 'sim' | 'live' | 'replay';
export type UITheme = 'night' | 'desert';

/** Geometric blockers that trigger the Layer-0 hard override. Bushes are solid: the stack routes around undergrowth. */
export const HARD_KINDS: ObstacleKind[] = ['boulder', 'tree', 'bush'];

/** Per-object surface temperature (°C) for the LWIR thermal model. */
export function obstacleTemp(o: Obstacle, thermEff: number, night: boolean): number {
  const base: Record<ObstacleKind, number> = {
    water: 18, mud: 26, sand: 32, boulder: 34, tree: 24, bush: 25, smoke: 30
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
}

export interface SimParams {
  velocity: number; // m/s 0..4
  friction: number; // moisture/condition 0.10..0.95 (scales soil μ)
  smoke: number; // % 0..100
  thermal: number; // Jetson GPU thermal load degC 45..90
  bubble: number; // safety bubble radius (m) around the UGV, 1..4
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
}

export const SNR_SMOKE_CUTOVER = 80;

const HIST = 140;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rnd = (a: number) => (Math.random() - 0.5) * 2 * a;

export class SparshSim {
  params: SimParams = { velocity: 1.6, friction: 0.65, smoke: 8, thermal: 68, bubble: 2.0 };
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
  route: { x: number; y: number }[] = [];
  routeIdx = 0;
  routeLen = 0;
  routeVersion = 0;
  replanCount = 0;
  replanMsg = 'no goal — right-click map to set destination';
  arrived = false;
  goalBlocked = false;
  overrideCount = 0;
  lastOverrideMsg = 'none';
  lidarReturns = 32;
  driveState: 'patrol' | 'enroute' | 'caution' | 'override' | 'reversing' | 'arrived' | 'blocked' | 'estop' = 'patrol';
  private corridorT = 0;
  private stuckT = 0;
  private reverseT = 0;
  private reverseTurn = 0.9;
  private reverseCooldownUntil = -1;
  private travelAcc = 0;
  private stallWindowT = 0;
  private windowStartDist = Infinity;
  private lidarT = 0;
  private rawMargin = 99;
  private rawMarginKind = '—';

  /** Minimum edge clearance to hard blockers inside a cone. Used for rear checks. */
  private coneClearance(center: number, half: number, range: number): number {
    let best = range;
    for (const o of this.obstacles) {
      if (!HARD_KINDS.includes(o.kind)) continue;
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
    margin: 99, marginKind: '—', lidarReturns: 32
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
    const rng = mulberry32(p.seed ^ 0x9e3779b9);
    const place = (kind: ObstacleKind, count: number, rMin: number, rMax: number, maxElev: number | null = null) => {
      let placed = 0;
      let guard = 0;
      while (placed < count && guard++ < count * 15 + 30) {
        const x = (rng() * 2 - 1) * (WORLD_W / 2 - 4);
        const y = (rng() * 2 - 1) * (WORLD_H / 2 - 4);
        if (Math.hypot(x + 12, y) < 8) continue; // keep spawn clear
        if (maxElev !== null && activeTerrain.elevAt(x, y) > maxElev) continue; // treeline rule
        let ok = true;
        for (const o of this.obstacles) {
          if (Math.hypot(o.x - x, o.y - y) < o.r + 1.6) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        this.obstacles.push({ id: this.nextId++, x, y, r: rMin + rng() * (rMax - rMin), kind });
        placed++;
      }
    };
    place('tree', p.trees, 0.45, 0.75, p.treeline);
    place('boulder', p.rocks, 0.7, 1.5);
    place('bush', p.bushes, 0.7, 1.2);
    place('mud', p.mud, 1.4, 2.4);
    place('water', p.water, 1.2, 2.0);
    place('sand', p.sand, 1.6, 2.6);
    this.setParams({ smoke: p.smoke, thermal: p.thermal });
    this.goal = null;
    this.route = [];
    this.arrived = false;
    this.goalBlocked = false;
    this.replanMsg = 'no goal — right-click map to set destination';
    this.emit();
  }

  reset() {
    this.pose = { x: -12, y: 0, theta: 0 };
    this.actV = 0;
    this.simTime = 0;
    this.vioAcc = 0.05;
    this.estop = false;
    this.override = false;
    this.caution = false;
    this.arrived = false;
    this.routeIdx = 0;
    Object.keys(this.hist).forEach((k) => {
      this.hist[k as keyof typeof this.hist] = [];
    });
    if (this.goal) this.replan('reset');
    else this.emit();
  }
  clearObstacles() {
    this.obstacles = [];
    this.emit();
    if (this.goal && !this.arrived) this.replan('hazards cleared');
  }
  setGoal(x: number, y: number) {
    this.goal = { x, y };
    this.arrived = false;
    this.goalBlocked = false;
    this.windowStartDist = Math.hypot(x - this.pose.x, y - this.pose.y);
    this.travelAcc = 0;
    this.stallWindowT = 0;
    this.routeIdx = 0;
    this.replan('new goal');
  }
  clearGoal() {
    this.goal = null;
    this.route = [];
    this.arrived = false;
    this.goalBlocked = false;
    this.replanMsg = 'no goal — right-click map to set destination';
    this.emit();
  }
  private wrapPose() {
    if (this.pose.x > WORLD_W / 2) this.pose.x = -WORLD_W / 2;
    if (this.pose.x < -WORLD_W / 2) this.pose.x = WORLD_W / 2;
    if (this.pose.y > WORLD_H / 2) this.pose.y = -WORLD_H / 2;
    if (this.pose.y < -WORLD_H / 2) this.pose.y = WORLD_H / 2;
  }
  replan(reason: string) {
    if (!this.goal) return;
    const r = planRoute(this.pose.x, this.pose.y, this.goal.x, this.goal.y, this.params.friction, this.obstacles, this.params.bubble);
    if (r && r.pts.length > 1) {
      this.route = r.pts;
      this.routeIdx = 0;
      this.routeLen = r.length;
      this.replanCount++;
      this.routeVersion++;
      this.replanMsg = `${reason} · ${r.length.toFixed(0)}m route · #${this.replanCount}`;
    } else {
      this.replanMsg = `${reason} · no route found`;
    }
    this.emit();
  }
  private checkCorridor() {
    if (!this.goal || this.arrived || this.route.length < 2) return;
    const ahead = this.route.slice(this.routeIdx, this.routeIdx + 10);
    for (const pt of ahead) {
      for (const o of this.obstacles) {
        if (!HARD_KINDS.includes(o.kind)) continue;
        if (Math.hypot(o.x - pt.x, o.y - pt.y) < o.r + Math.max(0.6, this.params.bubble * 0.4)) {
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
    if (nearest > 6) this.replan('off-route');
  }
  addObstacle(kind: ObstacleKind, x: number, y: number) {
    const r =
      kind === 'boulder' ? 0.8 + Math.random() * 0.7
      : kind === 'tree' ? 0.45 + Math.random() * 0.3
      : kind === 'mud' ? 1.4 + Math.random() * 1.0
      : kind === 'water' ? 1.2 + Math.random() * 0.8
      : kind === 'sand' ? 1.6 + Math.random() * 1.0
      : kind === 'bush' ? 0.7 + Math.random() * 0.5
      : 2.0 + Math.random() * 1.0;
    this.obstacles.push({ id: this.nextId++, x, y, r, kind });
    if (this.obstacles.length > 420) this.obstacles.shift();
    this.emit();
    if (this.goal && !this.arrived) this.replan('dynamic hazard');
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

    // Soil + slope under the robot
    const { soil, mu: effMu } = effMuAt(this.pose.x, this.pose.y, p.friction);
    const slope = activeTerrain.slopeAt(this.pose.x, this.pose.y);
    const slopeUp = slope.dx * Math.cos(this.pose.theta) + slope.dy * Math.sin(this.pose.theta);

    // Nose position for Layer-0 shield check (hard geometric blockers only)
    const noseX = this.pose.x + Math.cos(this.pose.theta) * 0.9;
    const noseY = this.pose.y + Math.sin(this.pose.theta) * 0.9;
    let minEdge = Infinity;
    let minKind = '—';
    for (const o of this.obstacles) {
      if (!HARD_KINDS.includes(o.kind)) continue;
      const d = Math.hypot(o.x - noseX, o.y - noseY) - o.r;
      if (d < minEdge) {
        minEdge = d;
        minKind = o.kind;
      }
    }
    if (!this.override && minEdge < 0.8) {
      this.override = true;
      this.overrideCount++;
      this.lastOverrideMsg = `T+${this.simTime.toFixed(0)}s · ${minKind} @ ${Math.max(0, minEdge).toFixed(2)}m · CAN 0x201`;
    } else if (this.override && minEdge > 1.4) this.override = false;
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

    this.caution = !this.override && minEdge < Math.max(1.5, p.bubble);

    let cmdV = 0;
    if (this.reverseT > 0) {
      // collision-aware back-up: abort the moment the rear arc closes in
      const rear = this.coneClearance(this.pose.theta + Math.PI, 0.7, 4);
      if (rear < 0.8) {
        this.reverseT = 0;
        this.replanMsg = 'rear contact · turning in place';
        this.replan('rear blocked');
      } else {
        cmdV = -0.9;
        this.reverseT -= dt;
        this.pose.theta += this.reverseTurn * dt;
        this.pose.x += Math.cos(this.pose.theta) * -0.9 * dt;
        this.pose.y += Math.sin(this.pose.theta) * -0.9 * dt;
        this.wrapPose();
        this.actV += (-0.9 - this.actV) * Math.min(1, dt * 3);
        this.driveState = 'reversing';
        if (this.reverseT <= 0 && this.goal && !this.arrived) this.replan('stuck recovery');
      }
    } else {
      cmdV = this.estop || this.override ? 0 : this.arrived || this.goalBlocked ? 0 : this.caution ? Math.min(p.velocity, 0.9) : p.velocity;
      if (this.goal && !this.arrived && !this.goalBlocked && !this.estop) {
        // pure pursuit: track the route ribbon with speed-adaptive lookahead
        while (this.routeIdx < this.route.length - 1 && Math.hypot(this.pose.x - this.route[this.routeIdx].x, this.pose.y - this.route[this.routeIdx].y) < 2) this.routeIdx++;
        const Ld = clamp(2 + this.actV * 1.0, 2, 5);
        let target = this.route.length ? this.route[this.route.length - 1] : this.goal;
        for (let i = this.routeIdx; i < this.route.length; i++) {
          if (Math.hypot(this.route[i].x - this.pose.x, this.route[i].y - this.pose.y) > Ld) {
            target = this.route[i];
            break;
          }
        }
        const want = Math.atan2(target.y - this.pose.y, target.x - this.pose.x);
        let dh = want - this.pose.theta;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        const maxTurn = 1.8 * dt;
        // steer even while override-braked: turn in place toward the escape route
        this.pose.theta += Math.min(maxTurn, Math.max(-maxTurn, dh));
        if (!this.override) {
          // slow for curvature and for close proximity (smooth low-cost approach)
          cmdV *= clamp(1 - Math.abs(dh) / 1.2, 0.25, 1);
          if (minEdge < 3) cmdV = Math.min(cmdV, 0.9 + Math.max(0, minEdge - 1.5) * 1.2);
          if (Math.hypot(this.goal.x - this.pose.x, this.goal.y - this.pose.y) < 2.5) {
            this.arrived = true;
            this.replanMsg = `arrived · ${this.replanCount} replans en route`;
            this.emit();
          }
          this.corridorT += dt;
          if (this.corridorT > 3) {
            this.corridorT = 0;
            this.checkCorridor();
          }
        }
        // stuck detection runs even while braked: back out instead of grinding
        if (this.actV < 0.15 && !this.goalBlocked) {
          this.stuckT += dt;
          if (this.stuckT > 3 && this.simTime > this.reverseCooldownUntil) {
            this.stuckT = 0;
            this.reverseCooldownUntil = this.simTime + 10;
            const rear = this.coneClearance(this.pose.theta + Math.PI, 0.7, 4);
            if (rear < 1.0) {
              this.replanMsg = 'stuck · rear blocked · turning';
              this.replan('rear blocked');
            } else {
              // back toward the freer side: nose turns where front clearance is larger
              const left = this.coneClearance(this.pose.theta + 0.9, 0.6, 4);
              const right = this.coneClearance(this.pose.theta - 0.9, 0.6, 4);
              this.reverseTurn = left >= right ? 0.9 : -0.9;
              this.reverseT = 1.2;
              this.replanMsg = 'stuck · reversing';
            }
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
            this.goalBlocked = true;
            this.replanMsg = `goal unreachable · holding at ${dGoal.toFixed(0)}m`;
            this.emit();
          }
          this.travelAcc = 0;
          this.stallWindowT = 0;
          this.windowStartDist = dGoal;
        }
      } else if (!this.goal) {
        this.pose.theta = 0.22 * Math.sin(t * 0.07);
      }
      this.actV += (cmdV - this.actV) * Math.min(1, dt * 2.5);
      this.pose.x += Math.cos(this.pose.theta) * this.actV * dt;
      this.pose.y += Math.sin(this.pose.theta) * this.actV * dt;
      this.wrapPose();
      this.driveState = this.estop ? 'estop' : this.override ? 'override' : this.arrived ? 'arrived' : this.goalBlocked ? 'blocked' : this.caution ? 'caution' : this.goal ? 'enroute' : 'patrol';
    }

    // --- Terramechanics: soft-hazard proximity fields ---
    let mudProx = 0;
    let waterProx = 0;
    let sandProx = 0;
    for (const o of this.obstacles) {
      const d = Math.hypot(o.x - this.pose.x, o.y - this.pose.y);
      const g = Math.exp(-(d * d) / (o.r * o.r * 2.2 + 2));
      if (o.kind === 'mud') mudProx = Math.max(mudProx, g);
      else if (o.kind === 'water') waterProx = Math.max(waterProx, g);
      else if (o.kind === 'sand') sandProx = Math.max(sandProx, g);
    }
    const slipBase = (1 - effMu) * 0.55 * (0.35 + 0.65 * Math.min(1, this.actV / 2.5)) * soil.slipMul;
    const burst = t < this.slipBurstUntil ? 0.35 * Math.sin(t * 9) ** 2 + 0.2 : 0;
    const extra = mudProx * 0.3 + waterProx * 0.45 + sandProx * 0.25 + burst;
    const slipL = clamp(slipBase + extra + 0.05 * Math.sin(t * 3.1) + rnd(0.02 * jitter), 0, 1);
    const slipR = clamp(slipBase + extra + 0.05 * Math.sin(t * 3.7 + 1.3) + rnd(0.02 * jitter), 0, 1);
    const gradeLoad = slopeUp * this.actV * 2.4 + Math.max(0, slopeUp) * 3;
    const softLoad = sandProx * 4 + mudProx * 3 + waterProx * 2;
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
      margin: this.rawMargin, marginKind: this.rawMarginKind, lidarReturns: this.lidarReturns
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
