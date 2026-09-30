import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { motion } from 'framer-motion';
import { MousePointerClick, Trash2 } from 'lucide-react';
import { HARD_KINDS, SparshSim, useSim, useSimView, WORLD_H, WORLD_W } from '../sim/store';
import { activeTerrain, effMuAt, mulberry32 } from '../sim/terrain';
import {
  MPPI_K, lidarPartial, lidarRadius, mppiRollouts, rayCircle, tauColor, traversability
} from '../sim/mppi';

const LIDAR_RAYS = 32;
const LIDAR_RANGE = 12;
const H_STEPS = 20;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function makePuffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(200,205,212,0.85)');
  grad.addColorStop(0.6, 'rgba(170,176,184,0.35)');
  grad.addColorStop(1, 'rgba(150,156,164,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const KIND_DOT: Record<string, string> = {
  boulder: '#a8a29e', tree: '#22c55e', mud: '#fb923c', water: '#38bdf8',
  sand: '#eab308', bush: '#4ade80', smoke: '#94a3b8'
};

const CAP = { tree: 260, rock: 150, bush: 150 };

export interface MapView {
  cx: number;
  cy: number;
  vw: number;
  follow: boolean;
}

export interface MapCache {
  last: { x: number; y: number }[];
  at: number;
}

/** Shared 2D tactical renderer: corner minimap and the full mission-map modal. */
export function drawTacticalMap(
  mctx: CanvasRenderingContext2D, MW: number, MH: number,
  v: MapView, sim: SparshSim, cache: MapCache, now: number, label: string
) {
  const { pose, obstacles, params } = sim;
  mctx.clearRect(0, 0, MW, MH);
  mctx.fillStyle = 'rgba(255,255,255,0.94)';
  mctx.fillRect(0, 0, MW, MH);
  mctx.strokeStyle = '#E7E5E0';
  mctx.strokeRect(0.5, 0.5, MW - 1, MH - 1);
  if (v.follow) {
    v.cx = pose.x;
    v.cy = pose.y;
  }
  const vw = v.vw;
  const vh = (MH / MW) * vw;
  const s = MW / vw;
  const mx = (wx: number) => (wx - v.cx) * s + MW / 2;
  const my = (wy: number) => (wy - v.cy) * s + MH / 2;
  for (let gx = Math.floor(v.cx - vw / 2); gx < v.cx + vw / 2; gx += 2) {
    for (let gy = Math.floor(v.cy - vh / 2); gy < v.cy + vh / 2; gy += 2) {
      mctx.fillStyle = tauColor(traversability(gx + 1, gy + 1, params.friction, obstacles), 0.8);
      mctx.fillRect(mx(gx), my(gy), 2 * s, 2 * s);
    }
  }
  if (now - cache.at > 350) {
    cache.at = now;
    const r = mppiRollouts(pose.x, pose.y, pose.theta, sim.actV, params.friction, obstacles, sim.simTime, sim.latest.snrDegraded, sim.caution);
    cache.last = r.paths[r.best].pts;
  }
  if (sim.route.length > 1) {
    mctx.strokeStyle = '#B45309';
    mctx.lineWidth = 1.5;
    mctx.setLineDash([4, 3]);
    mctx.beginPath();
    sim.route.forEach((p, i) => {
      if (i === 0) mctx.moveTo(mx(p.x), my(p.y));
      else mctx.lineTo(mx(p.x), my(p.y));
    });
    mctx.stroke();
    mctx.setLineDash([]);
  }
  if (cache.last.length) {
    mctx.strokeStyle = '#1B5E43';
    mctx.lineWidth = 2;
    mctx.beginPath();
    cache.last.forEach((p, i) => {
      if (i === 0) mctx.moveTo(mx(p.x), my(p.y));
      else mctx.lineTo(mx(p.x), my(p.y));
    });
    mctx.stroke();
  }
  for (const o of obstacles) {
    mctx.fillStyle = KIND_DOT[o.kind] ?? '#94a3b8';
    mctx.beginPath();
    mctx.arc(mx(o.x), my(o.y), Math.max(1.5, o.r * s * 0.5), 0, Math.PI * 2);
    mctx.fill();
  }
  if (sim.goal) {
    mctx.fillStyle = '#1B5E43';
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    mctx.arc(mx(sim.goal.x), my(sim.goal.y), 4, 0, Math.PI * 2);
    mctx.fill();
    mctx.stroke();
  }
  mctx.save();
  mctx.translate(mx(pose.x), my(pose.y));
  mctx.rotate(pose.theta);
  mctx.fillStyle = '#123F2E';
  mctx.beginPath();
  mctx.moveTo(7, 0);
  mctx.lineTo(-4, -4);
  mctx.lineTo(-4, 4);
  mctx.closePath();
  mctx.fill();
  mctx.restore();
  mctx.strokeStyle = sim.override ? '#DC2626' : sim.caution ? '#B45309' : '#1B5E43';
  mctx.beginPath();
  mctx.arc(mx(pose.x), my(pose.y), 0.8 * s, 0, Math.PI * 2);
  mctx.stroke();
  mctx.fillStyle = '#78716C';
  mctx.font = '600 8px Inter, sans-serif';
  mctx.fillText(label, 5, 11);
}

export default function SimulationCanvas() {
  const sim = useSim();
  const view = useSimView();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  type CamMode = 'chase' | 'front' | 'top' | 'side' | 'orbit' | 'follow';
  const camCtl = useRef<{ setMode: (m: CamMode) => void }>({ setMode: () => {} });
  const [camMode, setCamMode] = useState<CamMode>('chase');
  // tac-map view: zoomable, pannable; follow tracks the robot until the user pans
  const mapView = useRef({ cx: 0, cy: 0, vw: 34, follow: true });
  const mapDrag = useRef<null | { lx: number; ly: number; moved: boolean }>(null);
  const [cursor, setCursor] = useState('');
  const [mapOpen, setMapOpen] = useState(false);
  const modalMapRef = useRef<HTMLCanvasElement>(null);
  const modalWrapRef = useRef<HTMLDivElement>(null);
  const modalView = useRef<MapView>({ cx: 0, cy: 0, vw: 70, follow: true });
  const modalCache = useRef<MapCache>({ last: [], at: 0 });
  const modalDrag = useRef<null | { lx: number; ly: number; moved: boolean }>(null);
  const [modalCursor, setModalCursor] = useState('');

  useEffect(() => {
    if (!mapOpen) return;
    const canvas = modalMapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const wrap = modalWrapRef.current!;
    const w = Math.max(320, Math.min(wrap.clientWidth || 800, 1000));
    const h = Math.round(w * 0.55);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    modalView.current = { cx: mapView.current.cx, cy: mapView.current.cy, vw: Math.max(60, mapView.current.vw), follow: true };
    let raf = 0;
    const loop = () => {
      drawTacticalMap(ctx, w, h, modalView.current, sim, modalCache.current, performance.now(), 'MISSION MAP · CLICK TO SEND GOAL');
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMapOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapOpen]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#b9c8cc');
    scene.fog = new THREE.Fog('#b9c8cc', 70, 230);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);

    const sun = new THREE.DirectionalLight('#fff4e0', 2.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    sun.shadow.camera.far = 160;
    sun.shadow.bias = -0.0006;
    scene.add(sun);
    scene.add(sun.target);
    const hemi = new THREE.HemisphereLight('#cfe4ea', '#2a3327', 0.75);
    scene.add(hemi);
    scene.add(new THREE.AmbientLight('#ffffff', 0.15));

    const applyTheme = (desert: boolean, night: boolean) => {
      const bg = scene.background as THREE.Color;
      const fog = scene.fog as THREE.Fog;
      if (night) {
        // moonlight ops: LiDAR + thermal carry detection, headlights on
        bg.set('#0a1220');
        fog.color.set('#0a1220');
        fog.near = 45;
        fog.far = 170;
        sun.color.set('#9db8dd');
        sun.intensity = 0.35;
        hemi.intensity = 0.22;
        renderer.toneMappingExposure = 1.0;
      } else if (desert) {
        bg.set('#e3cfa3');
        fog.color.set('#e3cfa3');
        fog.near = 80;
        fog.far = 260;
        sun.color.set('#ffedd0');
        sun.intensity = 2.7;
        hemi.intensity = 0.9;
        renderer.toneMappingExposure = 1.12;
      } else {
        bg.set('#b9c8cc');
        fog.color.set('#b9c8cc');
        fog.near = 70;
        fog.far = 230;
        sun.color.set('#fff4e0');
        sun.intensity = 2.1;
        hemi.intensity = 0.85;
        renderer.toneMappingExposure = 1.12;
      }
    };

    // world (x,y) <-> three (x, z=-y)
    const w2x = (wx: number) => wx;
    const w2z = (wy: number) => -wy;

    // ---------- terrain ----------
    let terrainMesh: THREE.Mesh | null = null;
    const buildTerrain = () => {
      if (terrainMesh) {
        scene.remove(terrainMesh);
        terrainMesh.geometry.dispose();
        (terrainMesh.material as THREE.Material).dispose();
        terrainMesh = null;
      }
      const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_H, 200, 120);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 3);
      const amp = Math.max(0.5, activeTerrain.preset.elevAmp);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i);
        const wy = -pos.getZ(i);
        const e = activeTerrain.elevAt(wx, wy);
        pos.setY(i, e);
        const soil = activeTerrain.soilAt(wx, wy);
        const sl = activeTerrain.slopeAt(wx, wy);
        const sh = clamp(1 + (e / amp) * 0.22 - sl.mag * 0.05, 0.68, 1.3);
        const rockK = clamp((sl.mag - 0.35) * 1.4, 0, 0.6);
        c.setRGB(
          clamp((soil.rgb[0] * sh * (1 - rockK) + 122 * rockK) / 255, 0, 1),
          clamp((soil.rgb[1] * sh * (1 - rockK) + 118 * rockK) / 255, 0, 1),
          clamp((soil.rgb[2] * sh * (1 - rockK) + 112 * rockK) / 255, 0, 1)
        );
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      terrainMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
      terrainMesh.receiveShadow = true;
      scene.add(terrainMesh);
    };
    buildTerrain();

    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(520, 32),
      new THREE.MeshStandardMaterial({ color: '#31402f', roughness: 1 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -1.4;
    apron.receiveShadow = true;
    scene.add(apron);

    const mountainMat = new THREE.MeshStandardMaterial({ color: '#5c6b74', roughness: 1, flatShading: true });
    {
      const rng = mulberry32(777);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + rng() * 0.5;
        const dist = 210 + rng() * 60;
        const h = 55 + rng() * 45;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(34 + rng() * 22, h, 5), mountainMat);
        cone.position.set(Math.cos(a) * dist, h / 2 - 2, Math.sin(a) * dist);
        cone.rotation.y = rng() * Math.PI;
        scene.add(cone);
      }
    }

    // ---------- background forest (decorative) ----------
    const bgForest = new THREE.Group();
    scene.add(bgForest);
    const buildBackgroundForest = () => {
      bgForest.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        if (mat) mat.dispose();
      });
      bgForest.clear();
      const preset = activeTerrain.preset;
      const rng = mulberry32(preset.seed ^ 0xbeef);
      // Decorative ring mirrors the biome: deserts get (almost) no backdrop trees.
      const N = Math.max(8, Math.round(260 * Math.min(1, preset.trees / 40)));
      const trunks = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.16, 0.24, 2.2, 5),
        new THREE.MeshStandardMaterial({ color: '#3a2417', roughness: 1 }),
        N
      );
      const cones = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1.9, 3.0, 6),
        new THREE.MeshStandardMaterial({ color: preset.canopy, roughness: 1, flatShading: true }),
        N * 2
      );
      const d = new THREE.Object3D();
      let ti = 0;
      let ci = 0;
      let guard = 0;
      while (ti < N && guard++ < N * 20) {
        const a = rng() * Math.PI * 2;
        const r = 128 + rng() * 90;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r * 0.8;
        if (Math.abs(x) < WORLD_W / 2 + 3 && Math.abs(z) < WORLD_H / 2 + 3) continue;
        const y = activeTerrain.elevAt(x, -z) * 0.5 - 0.6;
        const s = 0.9 + rng() * 1.3;
        d.position.set(x, y + 1.1 * s, z);
        d.scale.setScalar(s);
        d.rotation.set(0, rng() * Math.PI, 0);
        d.updateMatrix();
        trunks.setMatrixAt(ti++, d.matrix);
        d.position.y = y + 3.6 * s;
        d.updateMatrix();
        cones.setMatrixAt(ci++, d.matrix);
        d.position.y = y + 5.1 * s;
        d.scale.setScalar(s * 0.7);
        d.updateMatrix();
        cones.setMatrixAt(ci++, d.matrix);
        d.scale.setScalar(1);
      }
      trunks.count = ti;
      cones.count = ci;
      trunks.castShadow = true;
      cones.castShadow = true;
      bgForest.add(trunks, cones);
    };
    buildBackgroundForest();

    // ---------- persistent instanced meshes for sim obstacles ----------
    const dynGroup = new THREE.Group();
    scene.add(dynGroup);
    const dummy = new THREE.Object3D();
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.14, 0.22, 1.9, 6),
      new THREE.MeshStandardMaterial({ color: '#3a2417', roughness: 1 }),
      CAP.tree
    );
    const canopyMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.7, 2.6, 7),
      new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
      CAP.tree * 2
    );
    const canopyTopMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.7, 2.6, 7),
      new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
      CAP.tree
    );
    const rockMesh = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
      CAP.rock
    );
    const bushMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: '#2f6b3c', roughness: 1, flatShading: true }),
      CAP.bush
    );
    for (const m of [trunkMesh, canopyMesh, canopyTopMesh, rockMesh, bushMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      dynGroup.add(m);
    }
    const tmpColor = new THREE.Color();

    const updateInstances = () => {
      const obs = sim.obstacles;
      const preset = activeTerrain.preset;
      (canopyMesh.material as THREE.MeshStandardMaterial).color.set(preset.canopy);
      (canopyTopMesh.material as THREE.MeshStandardMaterial).color.set(preset.canopyHi);
      let ti = 0;
      let ci = 0;
      let pi = 0;
      let ri = 0;
      let bi = 0;
      for (const o of obs) {
        const y = activeTerrain.elevAt(o.x, o.y);
        if (o.kind === 'tree' && ti < CAP.tree) {
          const s = 0.8 + o.r * 0.9;
          dummy.rotation.set(0, o.id, 0);
          dummy.position.set(w2x(o.x), y + 0.95 * s, w2z(o.y));
          dummy.scale.setScalar(s);
          dummy.updateMatrix();
          trunkMesh.setMatrixAt(ti, dummy.matrix);
          dummy.position.y = y + 3.0 * s;
          dummy.updateMatrix();
          canopyMesh.setMatrixAt(ci++, dummy.matrix);
          dummy.position.y = y + 4.2 * s;
          dummy.scale.setScalar(s * 0.72);
          dummy.updateMatrix();
          canopyMesh.setMatrixAt(ci++, dummy.matrix);
          dummy.position.y = y + 5.2 * s;
          dummy.scale.setScalar(s * 0.5);
          dummy.updateMatrix();
          canopyTopMesh.setMatrixAt(pi++, dummy.matrix);
          dummy.scale.setScalar(1);
          ti++;
        } else if (o.kind === 'boulder' && ri < CAP.rock) {
          dummy.position.set(w2x(o.x), y + o.r * 0.35, w2z(o.y));
          dummy.scale.set(o.r * (0.9 + (o.id % 5) * 0.08), o.r * 0.72, o.r * (0.85 + (o.id % 7) * 0.06));
          dummy.rotation.set(0, o.id * 1.3, 0);
          dummy.updateMatrix();
          rockMesh.setMatrixAt(ri, dummy.matrix);
          const v = 0.85 + ((o.id * 37) % 10) / 10 * 0.3;
          rockMesh.setColorAt(ri, tmpColor.setRGB(0.55 * v, 0.55 * v, 0.58 * v));
          dummy.scale.setScalar(1);
          ri++;
        } else if (o.kind === 'bush' && bi < CAP.bush) {
          dummy.position.set(w2x(o.x), y + o.r * 0.3, w2z(o.y));
          dummy.scale.set(o.r, o.r * 0.55, o.r);
          dummy.rotation.set(0, o.id, 0);
          dummy.updateMatrix();
          bushMesh.setMatrixAt(bi++, dummy.matrix);
          dummy.scale.setScalar(1);
        }
      }
      trunkMesh.count = ti;
      canopyMesh.count = ci;
      canopyTopMesh.count = pi;
      rockMesh.count = ri;
      bushMesh.count = bi;
      for (const m of [trunkMesh, canopyMesh, canopyTopMesh, rockMesh, bushMesh]) m.instanceMatrix.needsUpdate = true;
      if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    };

    // ---------- decals + smoke (rebuilt only when the set changes) ----------
    const decalGroup = new THREE.Group();
    scene.add(decalGroup);
    const puffTex = makePuffTexture();
    let smokeSprites: THREE.Sprite[] = [];
    let decalSig = '';
    const disposeGroup = (g: THREE.Group) => {
      for (const child of [...g.children]) {
        g.remove(child);
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        if (mat) {
          const sm = mat as THREE.SpriteMaterial;
          if (sm.map && sm.map !== puffTex) sm.map.dispose();
          mat.dispose();
        }
      }
    };
    const syncDecals = () => {
      const sig = sim.obstacles.map((o) => `${o.id}:${o.kind}:${o.r.toFixed(2)}`).join(',');
      if (sig === decalSig) return;
      decalSig = sig;
      disposeGroup(decalGroup);
      smokeSprites = [];
      for (const o of sim.obstacles) {
        const y = activeTerrain.elevAt(o.x, o.y);
        if (o.kind === 'mud' || o.kind === 'water' || o.kind === 'sand') {
          const color = o.kind === 'mud' ? '#4a2f1c' : o.kind === 'water' ? '#0e7490' : '#c9a86a';
          const mesh = new THREE.Mesh(
            new THREE.CircleGeometry(o.r, 26),
            new THREE.MeshStandardMaterial({
              color, roughness: 0.7, transparent: true, opacity: o.kind === 'water' ? 0.8 : 0.92,
              polygonOffset: true, polygonOffsetFactor: -2,
              emissive: o.kind === 'water' ? '#0ea5e9' : '#000000', emissiveIntensity: o.kind === 'water' ? 0.35 : 0
            })
          );
          mesh.rotation.x = -Math.PI / 2;
          mesh.scale.y = 0.72;
          mesh.position.set(w2x(o.x), y + 0.05, w2z(o.y));
          mesh.receiveShadow = true;
          decalGroup.add(mesh);
        } else if (o.kind === 'smoke') {
          for (let k = 0; k < 3; k++) {
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, opacity: 0.5, depthWrite: false }));
            sp.position.set(w2x(o.x), y + 1.5 + k, w2z(o.y));
            sp.scale.setScalar(o.r * (1.2 + k * 0.5));
            sp.userData = { bx: w2x(o.x), bz: w2z(o.y), y0: y, k, id: o.id, r: o.r };
            smokeSprites.push(sp);
            decalGroup.add(sp);
          }
        }
      }
    };

    // ---------- UGV ----------
    const ugv = new THREE.Group();
    ugv.rotation.order = 'YXZ';
    // ----- armored 4x4 scout hull (expo floor language, same footprint) -----
    const olive = new THREE.MeshStandardMaterial({ color: '#4a4f35', roughness: 0.72, metalness: 0.25 });
    const oliveDark = new THREE.MeshStandardMaterial({ color: '#33361f', roughness: 0.8, metalness: 0.2 });
    const steel = new THREE.MeshStandardMaterial({ color: '#2a2d24', roughness: 0.6, metalness: 0.5 });
    const castAll = (m: THREE.Mesh) => {
      m.castShadow = true;
      m.receiveShadow = true;
      ugv.add(m);
      return m;
    };
    const lowerHull = castAll(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.32, 1.05), olive));
    lowerHull.position.y = 0.42;
    const upperHull = castAll(new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.3, 0.92), olive));
    upperHull.position.y = 0.72;
    const glacis = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.95), olive));
    glacis.position.set(0.72, 0.55, 0);
    glacis.rotation.z = -0.45;
    const rearPlate = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.95), oliveDark));
    rearPlate.position.set(-0.72, 0.55, 0);
    rearPlate.rotation.z = 0.4;
    for (const sz of [0.56, -0.56]) {
      const skirt = castAll(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 0.07), oliveDark));
      skirt.position.set(0, 0.52, sz);
      const stow = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.22, 0.12), oliveDark));
      stow.position.set(0.1, 0.66, sz * 0.92);
      const rail = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.06), steel));
      rail.position.set(-0.35, 0.9, sz * 0.45);
    }
    // brush guard: two uprights + crossbar
    const guardMat = steel;
    for (const gz of [0.42, -0.42]) {
      const post = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.55, 8), guardMat));
      post.position.set(1.0, 0.5, gz);
    }
    const crossbar = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.95, 8), guardMat));
    crossbar.rotation.x = Math.PI / 2;
    crossbar.position.set(1.0, 0.75, 0);
    // sensor mast: LiDAR puck + stereo camera bar + whip antenna
    const mast = castAll(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.75, 8), steel));
    mast.position.set(-0.35, 1.2, 0);
    const camBar = castAll(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.55), oliveDark));
    camBar.position.set(-0.35, 1.5, 0);
    const lensMat = new THREE.MeshStandardMaterial({ color: '#0a0f14', roughness: 0.15, metalness: 0.7 });
    for (const lz of [0.16, -0.16]) {
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), lensMat);
      lens.position.set(-0.28, 1.5, lz);
      ugv.add(lens);
    }
    const puck = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.1, 0.12),
      new THREE.MeshStandardMaterial({ color: '#22d3ee', emissive: '#22d3ee', emissiveIntensity: 0.9 })
    );
    puck.position.set(-0.35, 1.68, 0);
    ugv.add(puck);
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 1.4, 6), steel);
    whip.position.set(-0.62, 1.6, -0.35);
    whip.rotation.z = 0.06;
    ugv.add(whip);
    const beaconTip = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 8),
      new THREE.MeshStandardMaterial({ color: '#7f1d1d', emissive: '#ef4444', emissiveIntensity: 1.6 })
    );
    beaconTip.position.set(-0.66, 2.32, -0.35);
    ugv.add(beaconTip);
    // wheels: oversized off-road tires, steel hubs, steered front axle
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 16);
    wheelGeo.rotateX(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: '#1a1d18', roughness: 0.95 });
    const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.32, 10);
    hubGeo.rotateX(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({ color: '#6b6f66', roughness: 0.5, metalness: 0.6 });
    // tread blocks
    const treadGeo = new THREE.BoxGeometry(0.12, 0.05, 0.32);
    const wheels: THREE.Mesh[] = [];
    const steerGroups: THREE.Group[] = [];
    const steerState = { prev: 0, cur: 0 };
    [[0.52, 0.62, true], [0.52, -0.62, true], [-0.52, 0.62, false], [-0.52, -0.62, false]].forEach(([wx, wz, steer]) => {
      const g = new THREE.Group();
      g.position.set(wx as number, 0.34, wz as number);
      const w = new THREE.Mesh(wheelGeo, tireMat);
      w.castShadow = true;
      const hub = new THREE.Mesh(hubGeo, hubMat);
      g.add(w, hub);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const lug = new THREE.Mesh(treadGeo, tireMat);
        lug.position.set(Math.cos(a) * 0.33, Math.sin(a) * 0.33, 0);
        lug.rotation.z = a;
        w.add(lug);
      }
      wheels.push(w);
      if (steer) steerGroups.push(g);
      ugv.add(g);
    });
    // headlights: spotlight + lamp emissives + visible beam cone (night ops)
    const headlampMat = new THREE.MeshStandardMaterial({ color: '#fff6d8', emissive: '#ffedb0', emissiveIntensity: 0 });
    const lampL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), headlampMat);
    lampL.position.set(0.72, 0.62, 0.28);
    const lampR = lampL.clone();
    lampR.position.z = -0.28;
    ugv.add(lampL, lampR);
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(1.7, 7.5, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ffedb0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.rotation.z = Math.PI / 2 - 0.09;
    beam.position.set(4.4, 0.1, 0);
    ugv.add(beam);
    const head = new THREE.SpotLight('#fff2cc', 0, 48, 0.5, 0.55, 1.1);
    head.position.set(0.7, 0.9, 0);
    const headTarget = new THREE.Object3D();
    headTarget.position.set(12, -1.5, 0);
    ugv.add(headTarget);
    head.target = headTarget;
    ugv.add(head);
    scene.add(ugv);

    // ---------- MPPI lines ----------
    const lineGroup = new THREE.Group();
    scene.add(lineGroup);
    const pathLines: THREE.Line[] = [];
    for (let i = 0; i < MPPI_K; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((H_STEPS + 1) * 3), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.4 }));
      l.frustumCulled = false;
      pathLines.push(l);
      lineGroup.add(l);
    }
    const bestGeo = new THREE.BufferGeometry();
    bestGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((H_STEPS + 1) * 3), 3));
    const bestLine = new THREE.Line(bestGeo, new THREE.LineBasicMaterial({ color: '#39ff88', transparent: true, opacity: 0.95 }));
    bestLine.frustumCulled = false;
    lineGroup.add(bestLine);

    // ---------- LiDAR ----------
    const lidarGeo = new THREE.BufferGeometry();
    lidarGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIDAR_RAYS * 2 * 3), 3));
    const lidarLines = new THREE.LineSegments(lidarGeo, new THREE.LineBasicMaterial({ color: '#34d399', transparent: true, opacity: 0.35 }));
    lidarLines.frustumCulled = false;
    scene.add(lidarLines);
    const hitGeo = new THREE.BufferGeometry();
    hitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIDAR_RAYS * 3), 3));
    const hitPts = new THREE.Points(hitGeo, new THREE.PointsMaterial({ color: '#f43f5e', size: 0.22 }));
    hitPts.frustumCulled = false;
    scene.add(hitPts);

    // ---------- rings + goal beacon + global route ----------
    const shield = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.88, 40),
      new THREE.MeshBasicMaterial({ color: '#34d399', transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    shield.rotation.x = -Math.PI / 2;
    scene.add(shield);
    // safety bubble: guaranteed-clear maneuvering radius, driven by params.bubble
    const bubbleRing = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.0, 64),
      new THREE.MeshBasicMaterial({ color: '#1B5E43', transparent: true, opacity: 0.55, side: THREE.DoubleSide })
    );
    bubbleRing.rotation.x = -Math.PI / 2;
    scene.add(bubbleRing);
    const alertPool: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const r = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.0, 40),
        new THREE.MeshBasicMaterial({ color: '#f59e0b', transparent: true, opacity: 0.8, side: THREE.DoubleSide })
      );
      r.rotation.x = -Math.PI / 2;
      r.visible = false;
      scene.add(r);
      alertPool.push(r);
    }

    const beacon = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 3.4, 8),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 })
    );
    pole.position.y = 1.7;
    pole.castShadow = true;
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 0.75),
      new THREE.MeshStandardMaterial({ color: '#1B5E43', roughness: 0.8, side: THREE.DoubleSide })
    );
    flag.position.set(0.66, 2.9, 0);
    const beaconRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.08, 40),
      new THREE.MeshBasicMaterial({ color: '#1B5E43', transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    beaconRing.rotation.x = -Math.PI / 2;
    beaconRing.position.y = 0.12;
    beacon.add(pole, flag, beaconRing);
    beacon.visible = false;
    scene.add(beacon);

    const ROUTE_MAX = 512;
    const routeGeo = new THREE.BufferGeometry();
    routeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ROUTE_MAX * 3), 3));
    const routeLine = new THREE.Line(
      routeGeo,
      new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 })
    );
    routeLine.frustumCulled = false;
    routeLine.visible = false;
    scene.add(routeLine);

    // ---------- camera + picking ----------
    type CamMode = 'chase' | 'front' | 'top' | 'side' | 'orbit' | 'follow';
    const cam = { yawOff: 0, pitch: 0.42, dist: 13 };
    const camGoal = { yawOff: 0, pitch: 0.42, dist: 13 };
    const camLook = { v: 4, goal: 4 };
    const wrapAngle = (a: number) => {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    camCtl.current.setMode = (m: CamMode) => {
      if (m === 'orbit') {
        if (!sim.orbit) sim.toggleOrbit();
        camGoal.pitch = 0.5;
        camGoal.dist = 15;
        camLook.goal = 4;
      } else {
        if (sim.orbit) sim.toggleOrbit();
        if (m === 'chase') {
          camGoal.yawOff = cam.yawOff + wrapAngle(0 - cam.yawOff);
          camGoal.pitch = 0.42;
          camGoal.dist = 13;
          camLook.goal = 4;
        } else if (m === 'front') {
          camGoal.yawOff = cam.yawOff + wrapAngle(Math.PI - cam.yawOff);
          camGoal.pitch = 0.38;
          camGoal.dist = 12;
          camLook.goal = 4;
        } else if (m === 'side') {
          camGoal.yawOff = cam.yawOff + wrapAngle(Math.PI / 2 - cam.yawOff);
          camGoal.pitch = 0.25;
          camGoal.dist = 12;
          camLook.goal = 4;
        } else if (m === 'follow') {
          // sensor-eye: ride just behind the LiDAR mast, stare down the path
          camGoal.yawOff = cam.yawOff + wrapAngle(0 - cam.yawOff);
          camGoal.pitch = 0.12;
          camGoal.dist = 2.4;
          camLook.goal = 16;
        } else {
          camGoal.yawOff = cam.yawOff + wrapAngle(0 - cam.yawOff);
          camGoal.pitch = 1.35;
          camGoal.dist = 26;
          camLook.goal = 0;
        }
      }
    };
    const camPos = new THREE.Vector3(-21, 8, 0);
    let dragging = false;
    let downX = 0;
    let downY = 0;
    let moved = 0;
    let downT = 0;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const onDown = (e: PointerEvent) => {
      dragging = true;
      downX = e.clientX;
      downY = e.clientY;
      moved = 0;
      downT = performance.now();
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      moved += Math.abs(dx) + Math.abs(dy);
      downX = e.clientX;
      downY = e.clientY;
      cam.yawOff -= dx * 0.005;
      camGoal.yawOff -= dx * 0.005;
      cam.pitch = clamp(cam.pitch + dy * 0.003, 0.15, 1.45);
      camGoal.pitch = clamp(camGoal.pitch + dy * 0.003, 0.15, 1.45);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      if (moved < 6 && performance.now() - downT < 500 && (e.button === 0 || e.button === 2)) {
        const rect = canvas.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        if (terrainMesh) {
          const hit = raycaster.intersectObject(terrainMesh, false)[0];
          if (hit) {
            const wx = clamp(hit.point.x, -WORLD_W / 2 + 1, WORLD_W / 2 - 1);
            const wy = clamp(-hit.point.z, -WORLD_H / 2 + 1, WORLD_H / 2 - 1);
            if (e.button === 2) sim.setGoal(wx, wy);
            else sim.addObstacle(sim.tool, wx, wy);
          }
        }
      }
    };
    const onCtx = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', onCtx);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.dist = clamp(cam.dist + e.deltaY * 0.01, 7, 30);
      camGoal.dist = clamp(camGoal.dist + e.deltaY * 0.01, 7, 30);
    };
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const resize = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      const w = Math.max(300, r.width);
      const h = Math.max(300, r.width * 0.62);
      renderer.setSize(w, h, false);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current!);

    // ---------- minimap ----------
    const mmap = mapRef.current!;
    const mctx = mmap.getContext('2d')!;
    const MW = (mmap.width = 216);
    const MH = (mmap.height = 150);
    const miniCache: MapCache = { last: [], at: 0 };

    const drawMinimap = (now: number) => {
      drawTacticalMap(mctx, MW, MH, mapView.current, sim, miniCache, now, 'TAC-MAP');
    };

    // ---------- main loop ----------
    let raf = 0;
    let last = performance.now();
    let frameNo = 0;
    let lastPreset = sim.preset.id;
    let lastVersion = -1;
    let lastLook = `${sim.uiTheme}:${sim.night}`;
    applyTheme(sim.uiTheme === 'desert', sim.night);
    updateInstances();
    syncDecals();

    const fwd = new THREE.Vector3();
    const desired = new THREE.Vector3();
    const look = new THREE.Vector3();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      sim.step(dt);
      const t = sim.simTime;
      const { pose, obstacles, params } = sim;
      const snr = sim.latest.snrDegraded;

      if (sim.preset.id !== lastPreset) {
        lastPreset = sim.preset.id;
        buildTerrain();
        buildBackgroundForest();
      }
      if (sim.version !== lastVersion) {
        lastVersion = sim.version;
        updateInstances();
        syncDecals();
      }
      const lookKey = `${sim.uiTheme}:${sim.night}`;
      if (lookKey !== lastLook) {
        lastLook = lookKey;
        applyTheme(sim.uiTheme === 'desert', sim.night);
      }
      // headlights fade with nightfall
      const lampK = sim.night ? 1 : 0;
      head.intensity += ((lampK ? 55 : 0) - head.intensity) * Math.min(1, dt * 4);
      headlampMat.emissiveIntensity = lampK ? 2.4 : 0;
      const beamMat = beam.material as THREE.MeshBasicMaterial;
      beamMat.opacity += ((lampK ? 0.1 : 0) - beamMat.opacity) * Math.min(1, dt * 4);

      const rx = w2x(pose.x);
      const rz = w2z(pose.y);
      const groundY = activeTerrain.elevAt(pose.x, pose.y);
      const sl = activeTerrain.slopeAt(pose.x, pose.y);
      const slopeUp = sl.dx * Math.cos(pose.theta) + sl.dy * Math.sin(pose.theta);
      const slopeRight = sl.dx * Math.sin(pose.theta) - sl.dy * Math.cos(pose.theta);

      ugv.position.set(rx, groundY + 0.12, rz);
      ugv.rotation.y = pose.theta;
      ugv.rotation.z = Math.atan(slopeUp) * 0.6;
      ugv.rotation.x = -Math.atan(slopeRight) * 0.6;
      for (const w of wheels) w.rotation.z -= (sim.actV * dt) / 0.34;
      const yawRate = (pose.theta - steerState.prev) / Math.max(dt, 1e-3);
      steerState.prev = pose.theta;
      const steerTarget = clamp(yawRate * 0.35, -0.5, 0.5);
      steerState.cur += (steerTarget - steerState.cur) * Math.min(1, dt * 6);
      for (const g of steerGroups) g.rotation.y = steerState.cur;
      puck.rotation.y += dt * 7;

      sun.position.set(rx + 28, 42, rz + 18);
      sun.target.position.set(rx, 0, rz);

      const { paths, best } = mppiRollouts(pose.x, pose.y, pose.theta, sim.actV, params.friction, obstacles, t, snr, sim.caution);
      const costs = paths.map((p) => p.cost).sort((a, b) => a - b);
      const cmax = costs[Math.floor(costs.length * 0.9)] || 1;
      paths.forEach((p, i) => {
        const attr = pathLines[i].geometry.attributes.position as THREE.BufferAttribute;
        p.pts.forEach((pt, j) => {
          attr.setXYZ(j, w2x(pt.x), activeTerrain.elevAt(pt.x, pt.y) + 0.28, w2z(pt.y));
        });
        attr.needsUpdate = true;
        const m = pathLines[i].material as THREE.LineBasicMaterial;
        if (i === best) {
          pathLines[i].visible = false;
        } else {
          pathLines[i].visible = true;
          m.opacity = Math.max(0.05, 0.45 * (1 - p.cost / (cmax + 1e-6)));
        }
      });
      const bAttr = bestGeo.attributes.position as THREE.BufferAttribute;
      paths[best].pts.forEach((pt, j) => {
        bAttr.setXYZ(j, w2x(pt.x), activeTerrain.elevAt(pt.x, pt.y) + 0.32, w2z(pt.y));
      });
      bAttr.needsUpdate = true;

      const lAttr = lidarGeo.attributes.position as THREE.BufferAttribute;
      const hAttr = hitGeo.attributes.position as THREE.BufferAttribute;
      const ly = groundY + 1.8;
      for (let i = 0; i < LIDAR_RAYS; i++) {
        const a = t * 1.4 + (i / LIDAR_RAYS) * Math.PI * 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let range = LIDAR_RANGE;
        for (const o of obstacles) {
          const rr = lidarRadius(o);
          if (rr === null) continue;
          if (lidarPartial(o.kind) && Math.random() < 0.45) continue;
          const tt = rayCircle(pose.x, pose.y, dx, dy, o.x, o.y, rr);
          if (tt !== null && tt < range) range = tt;
        }
        const ex = pose.x + dx * range;
        const ey = pose.y + dy * range;
        const hitY = Math.max(activeTerrain.elevAt(ex, ey) + 0.6, ly - 2.5);
        lAttr.setXYZ(i * 2, rx, ly, rz);
        lAttr.setXYZ(i * 2 + 1, w2x(ex), hitY, w2z(ey));
        const hit = range < LIDAR_RANGE - 0.01;
        hAttr.setXYZ(i, w2x(ex), hit ? hitY : ly - 50, w2z(ey));
      }
      lAttr.needsUpdate = true;
      hAttr.needsUpdate = true;

      shield.position.set(rx, groundY + 0.12, rz);
      (shield.material as THREE.MeshBasicMaterial).color.set(sim.override ? '#f43f5e' : sim.caution ? '#f59e0b' : '#34d399');
      bubbleRing.position.set(rx, groundY + 0.1, rz);
      bubbleRing.scale.setScalar(Math.max(0.2, sim.params.bubble));
      (bubbleRing.material as THREE.MeshBasicMaterial).color.set(sim.override ? '#f43f5e' : sim.caution ? '#f59e0b' : '#1B5E43');

      let ai = 0;
      for (const o of obstacles) {
        if (ai >= alertPool.length) break;
        if (!HARD_KINDS.includes(o.kind)) continue;
        const edge = Math.hypot(o.x - pose.x, o.y - pose.y) - o.r;
        if (edge > 3.5) continue;
        const ring = alertPool[ai++];
        const pulse = 1 + ((t * 1.4 + o.id) % 1) * 0.9;
        ring.visible = true;
        ring.position.set(w2x(o.x), activeTerrain.elevAt(o.x, o.y) + 0.15, w2z(o.y));
        ring.scale.setScalar((o.r + 0.6) * pulse);
        const rm = ring.material as THREE.MeshBasicMaterial;
        rm.color.set(edge < 0.8 ? '#f43f5e' : '#f59e0b');
        rm.opacity = 0.9 - ((t * 1.4 + o.id) % 1) * 0.5;
      }
      for (; ai < alertPool.length; ai++) alertPool[ai].visible = false;

      // goal beacon + global route ribbon
      if (sim.goal) {
        const gy = activeTerrain.elevAt(sim.goal.x, sim.goal.y);
        beacon.visible = true;
        beacon.position.set(w2x(sim.goal.x), gy, w2z(sim.goal.y));
        flag.rotation.y = Math.sin(t * 3) * 0.35;
        const bp = 1 + ((t * 0.9) % 1) * 0.5;
        beaconRing.scale.setScalar(bp);
        (beaconRing.material as THREE.MeshBasicMaterial).opacity = 0.9 - ((t * 0.9) % 1) * 0.45;
        (flag.material as THREE.MeshStandardMaterial).color.set(sim.arrived ? '#4D7C0F' : '#1B5E43');
      } else {
        beacon.visible = false;
      }
      if (sim.route.length > 1) {
        const attr = routeGeo.attributes.position as THREE.BufferAttribute;
        const n = Math.min(sim.route.length, ROUTE_MAX);
        for (let k = 0; k < n; k++) {
          const pt = sim.route[k];
          attr.setXYZ(k, w2x(pt.x), activeTerrain.elevAt(pt.x, pt.y) + 0.45, w2z(pt.y));
        }
        routeGeo.setDrawRange(0, n);
        attr.needsUpdate = true;
        routeLine.visible = true;
      } else {
        routeLine.visible = false;
      }

      for (const sp of smokeSprites) {
        const u = sp.userData as { bx: number; bz: number; y0: number; k: number; id: number; r: number };
        const a = t * 0.25 + u.k * 2.1 + u.id;
        sp.position.x = u.bx + Math.cos(a) * u.r * 0.5;
        sp.position.z = u.bz + Math.sin(a) * u.r * 0.35;
        sp.position.y = u.y0 + 1.5 + u.k + Math.sin(t * 0.6 + u.k) * 0.4;
        (sp.material as THREE.SpriteMaterial).opacity = 0.4 + 0.15 * Math.sin(t * 0.8 + u.k * 2);
      }

      if (sim.orbit) {
        cam.yawOff += dt * 0.22;
        camGoal.yawOff += dt * 0.22;
      }
      // ease toward preset goals (smooth view transitions)
      const ek = 1 - Math.exp(-dt * 3);
      cam.yawOff += wrapAngle(camGoal.yawOff - cam.yawOff) * ek;
      cam.pitch += (camGoal.pitch - cam.pitch) * ek;
      cam.dist += (camGoal.dist - cam.dist) * ek;
      camLook.v += (camLook.goal - camLook.v) * ek;
      const yaw = pose.theta + Math.PI + cam.yawOff;
      fwd.set(Math.cos(yaw), 0, -Math.sin(yaw));
      desired.set(
        rx + fwd.x * cam.dist * Math.cos(cam.pitch),
        groundY + cam.dist * Math.sin(cam.pitch) + 1.2,
        rz + fwd.z * cam.dist * Math.cos(cam.pitch)
      );
      camPos.lerp(desired, 1 - Math.exp(-dt * 4.5));
      camera.position.copy(camPos);
      look.set(rx + Math.cos(pose.theta) * camLook.v, groundY + 1.2, rz - Math.sin(pose.theta) * camLook.v);
      camera.lookAt(look);

      renderer.render(scene, camera);
      if ((frameNo++ & 1) === 0) drawMinimap(now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('wheel', onWheel);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      puffTex.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mapPoint = (e: React.PointerEvent) => {
    const rect = mapRef.current!.getBoundingClientRect();
    const v = mapView.current;
    const s = rect.width / v.vw;
    return {
      wx: v.cx + (e.clientX - rect.left - rect.width / 2) / s,
      wy: v.cy + (e.clientY - rect.top - rect.height / 2) / s,
      s
    };
  };
  const clampGoal = (wx: number, wy: number) => ({
    x: Math.max(-WORLD_W / 2 + 1, Math.min(WORLD_W / 2 - 1, wx)),
    y: Math.max(-WORLD_H / 2 + 1, Math.min(WORLD_H / 2 - 1, wy))
  });

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="glass p-4">
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="panel-title">
          {view.preset.label} Forest <span className="text-pine-700 normal-case tracking-normal font-semibold">· 3D live{sim.orbit ? ' · orbit' : ''}</span>
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-sans text-[11px] text-stone-500 hidden sm:inline-flex items-center gap-1.5">
            <MousePointerClick size={12} /> Left-click drops {view.tool.toUpperCase()} · right-click sets goal · drag to orbit
          </span>
          <button onClick={() => sim.clearObstacles()} className="tactical-btn !py-1 !text-[11px]" title="Clear hazards">
            <Trash2 size={12} /> CLEAR
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <span className="font-sans text-[10px] font-semibold tracking-wider text-stone-400 mr-0.5">CAMERA</span>
        {(['chase', 'front', 'follow', 'top', 'side', 'orbit'] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              camCtl.current.setMode(m);
              setCamMode(m);
            }}
            className={`font-sans text-[11px] font-semibold px-2.5 py-1 rounded-md border transition active:scale-95 ${
              camMode === m ? 'border-pine-700 bg-pine-700 text-white shadow-sm' : 'border-stone-300 bg-white text-stone-600 hover:border-stone-400'
            }`}
          >
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
        <span className="ml-auto font-sans text-[10px] text-stone-400 hidden md:inline">drag to look · scroll to zoom · right-click sets goal</span>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <canvas ref={canvasRef} className="w-full rounded-lg border border-stone-300 cursor-crosshair" />
        <div className="absolute top-3 right-3 w-40 sm:w-52">
          <canvas
            ref={mapRef}
            className="w-full rounded-lg border border-stone-300 shadow-lift bg-white cursor-crosshair"
            style={{ touchAction: 'none' }}
            onPointerDown={(e) => {
              mapDrag.current = { lx: e.clientX, ly: e.clientY, moved: false };
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const p = mapPoint(e);
              setCursor(`${p.wx.toFixed(0)}, ${p.wy.toFixed(0)}`);
              const d = mapDrag.current;
              if (d && e.buttons) {
                const dx = e.clientX - d.lx;
                const dy = e.clientY - d.ly;
                if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = d.moved || Math.abs(e.clientX - d.lx) + Math.abs(e.clientY - d.ly) > 4;
                mapView.current.cx -= dx / p.s;
                mapView.current.cy -= dy / p.s;
                mapView.current.follow = false;
                d.lx = e.clientX;
                d.ly = e.clientY;
              }
            }}
            onPointerUp={(e) => {
              const d = mapDrag.current;
              mapDrag.current = null;
              if (!d || d.moved) return;
              const p = mapPoint(e);
              const g = clampGoal(p.wx, p.wy);
              sim.setGoal(g.x, g.y);
            }}
            onPointerLeave={() => {
              setCursor('');
              mapDrag.current = null;
            }}
          />
          <div className="absolute top-1.5 left-1.5 flex gap-1">
            <button
              onClick={() => { mapView.current.vw = Math.max(12, mapView.current.vw / 1.6); }}
              className="w-6 h-6 rounded-md bg-white/95 border border-stone-300 font-sans text-sm font-bold text-stone-700 shadow-sm hover:bg-stone-100 active:scale-95"
              title="Zoom in"
            >+</button>
            <button
              onClick={() => { mapView.current.vw = Math.min(150, mapView.current.vw * 1.6); }}
              className="w-6 h-6 rounded-md bg-white/95 border border-stone-300 font-sans text-sm font-bold text-stone-700 shadow-sm hover:bg-stone-100 active:scale-95"
              title="Zoom out"
            >−</button>
            <button
              onClick={() => { mapView.current.follow = true; }}
              className={`h-6 px-1.5 rounded-md bg-white/95 border font-sans text-[10px] font-bold shadow-sm active:scale-95 ${mapView.current.follow ? 'border-pine-700 text-pine-700' : 'border-stone-300 text-stone-500 hover:bg-stone-100'}`}
              title="Follow robot"
            >◎</button>
            <button
              onClick={() => setMapOpen(true)}
              className="h-6 px-1.5 rounded-md bg-white/95 border border-stone-300 font-sans text-[10px] font-bold text-stone-600 shadow-sm hover:bg-stone-100 active:scale-95"
              title="Open mission map"
            >⤢</button>
          </div>
          <div className="absolute bottom-1.5 left-1.5 font-mono text-[9px] text-stone-600 bg-white/92 px-1.5 py-0.5 rounded border border-stone-200">
            {cursor || `${Math.round(mapView.current.vw)}m · click: send goal`}
          </div>
        </div>
        {view.override && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-signal text-white font-sans text-xs font-bold px-4 py-1.5 rounded-lg tracking-wide shadow-lift">
            Layer-0 override active · obstacle &lt; 0.8 m
          </div>
        )}
        {view.caution && !view.override && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-400 text-stone-900 font-sans text-xs font-bold px-4 py-1.5 rounded-lg tracking-wide shadow-lift">
            Caution · bubble {view.params.bubble.toFixed(1)} m breached — derated, replanning
          </div>
        )}
        {view.latest.snrDegraded && !view.override && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-clay-700 text-white font-sans text-xs font-bold px-4 py-1.5 rounded-lg tracking-wide shadow-lift">
            SNR degradation · navigation exclusive to Layer-0
          </div>
        )}
        <HudInner />
        <div className="absolute bottom-3 right-3 font-sans text-[10px] font-medium text-stone-600 bg-white/90 px-2 py-1 rounded-md border border-stone-200">
          Three.js · Ouster OS1-32 3D · tac-map live
        </div>
      </div>
      {mapOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/70 p-4" onClick={() => setMapOpen(false)}>
          <div
            className="bg-white rounded-xl shadow-lift border border-stone-200 p-3 w-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2">
              <h3 className="panel-title">Mission map — click a point to send the goal</h3>
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => { modalView.current.vw = Math.max(12, modalView.current.vw / 1.6); }}
                  className="w-7 h-7 rounded-md border border-stone-300 font-sans text-sm font-bold text-stone-700 hover:bg-stone-100 active:scale-95"
                  title="Zoom in"
                >+</button>
                <button
                  onClick={() => { modalView.current.vw = Math.min(240, modalView.current.vw * 1.6); }}
                  className="w-7 h-7 rounded-md border border-stone-300 font-sans text-sm font-bold text-stone-700 hover:bg-stone-100 active:scale-95"
                  title="Zoom out"
                >−</button>
                <button
                  onClick={() => { modalView.current.follow = true; }}
                  className="h-7 px-2 rounded-md border border-stone-300 font-sans text-[11px] font-bold text-stone-600 hover:bg-stone-100 active:scale-95"
                  title="Follow robot"
                >◎ Follow</button>
                <button
                  onClick={() => setMapOpen(false)}
                  className="h-7 px-2.5 rounded-md bg-pine-700 font-sans text-[11px] font-bold text-white hover:bg-pine-800 active:scale-95"
                >Done</button>
              </div>
            </div>
            <div ref={modalWrapRef} className="relative w-full">
              <canvas
                ref={modalMapRef}
                className="w-full rounded-lg border border-stone-300 cursor-crosshair"
                style={{ touchAction: 'none' }}
                onPointerDown={(e) => {
                  modalDrag.current = { lx: e.clientX, ly: e.clientY, moved: false };
                  (e.target as Element).setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const rect = modalMapRef.current!.getBoundingClientRect();
                  const v = modalView.current;
                  const s = rect.width / v.vw;
                  const wx = v.cx + (e.clientX - rect.left - rect.width / 2) / s;
                  const wy = v.cy + (e.clientY - rect.top - rect.height / 2) / s;
                  setModalCursor(`${wx.toFixed(0)}, ${wy.toFixed(0)}`);
                  const d = modalDrag.current;
                  if (d && e.buttons) {
                    const dx = e.clientX - d.lx;
                    const dy = e.clientY - d.ly;
                    if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = d.moved || Math.abs(dx) + Math.abs(dy) > 4;
                    modalView.current.cx -= dx / s;
                    modalView.current.cy -= dy / s;
                    modalView.current.follow = false;
                    d.lx = e.clientX;
                    d.ly = e.clientY;
                  }
                }}
                onPointerUp={(e) => {
                  const d = modalDrag.current;
                  modalDrag.current = null;
                  if (!d || d.moved) return;
                  const rect = modalMapRef.current!.getBoundingClientRect();
                  const v = modalView.current;
                  const s = rect.width / v.vw;
                  const wx = v.cx + (e.clientX - rect.left - rect.width / 2) / s;
                  const wy = v.cy + (e.clientY - rect.top - rect.height / 2) / s;
                  sim.setGoal(
                    Math.max(-WORLD_W / 2 + 1, Math.min(WORLD_W / 2 - 1, wx)),
                    Math.max(-WORLD_H / 2 + 1, Math.min(WORLD_H / 2 - 1, wy))
                  );
                  setMapOpen(false);
                }}
                onPointerLeave={() => {
                  setModalCursor('');
                  modalDrag.current = null;
                }}
              />
              <div className="absolute bottom-2 left-2 font-mono text-[10px] text-stone-700 bg-white/92 px-2 py-0.5 rounded border border-stone-300">
                {modalCursor || 'click: send goal · drag: pan · Esc: close'}
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function HudInner() {
  const sim = useSimView();
  const { pose } = sim;
  const { soil, mu } = effMuAt(pose.x, pose.y, sim.params.friction);
  const elev = activeTerrain.elevAt(pose.x, pose.y);
  return (
    <div className="absolute bottom-3 left-3 font-sans text-[10px] leading-5 bg-white/92 px-2.5 py-1.5 rounded-lg border border-stone-200 shadow-soft">
      <div className="font-mono text-stone-800">x:{pose.x.toFixed(1)} y:{pose.y.toFixed(1)} θ:{((pose.theta * 180) / Math.PI).toFixed(0)}° · v:{sim.actV.toFixed(2)} m/s</div>
      <div className="font-semibold text-clay-700">TERR {soil.label} · μ{mu.toFixed(2)} · z{elev >= 0 ? '+' : ''}{elev.toFixed(1)} m · bubble {sim.params.bubble.toFixed(1)} m</div>
      <div className={`font-semibold ${sim.override ? 'text-signal' : sim.caution ? 'text-clay-700' : 'text-pine-700'}`}>
        {sim.override ? 'Layer-0 override · braking' : sim.caution ? 'Caution · derated to 0.9 m/s' : 'Shield nominal'}
        <span className="text-stone-400 font-medium"> · {sim.latest.snrDegraded ? 'nav Layer-0 only' : 'nav Layer-0 + Layer-1'}</span>
      </div>
      <div className="text-stone-600 truncate max-w-[320px]" title={sim.replanMsg}>
        {sim.goal
          ? <><span className="font-semibold text-pine-700">Goal</span> {sim.goal.x.toFixed(0)},{sim.goal.y.toFixed(0)} · {sim.latest.goalDist >= 0 ? `${sim.latest.goalDist.toFixed(0)}m` : ''} · {sim.arrived ? 'arrived' : `${sim.routeLen.toFixed(0)}m route`} · {sim.replanMsg}</>
          : 'No goal — right-click the terrain to set a destination'}
      </div>
    </div>
  );
}
