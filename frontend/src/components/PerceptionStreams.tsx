import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Brain, ShieldAlert } from 'lucide-react';
import { SNR_SMOKE_CUTOVER, obstacleTemp, useSim, useSimView } from '../sim/store';

function useFeed(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void) {
  const sim = useSim();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const parent = canvas.parentElement!;
    const resize = () => {
      const r = parent.getBoundingClientRect();
      canvas.width = Math.max(200, r.width * dpr);
      canvas.height = canvas.width * (9 / 16);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    const loop = () => {
      draw(ctx, canvas.width, canvas.height, sim.simTime);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

const KIND_COLOR: Record<string, string> = {
  boulder: '#f43f5e', mud: '#fb923c', smoke: '#94a3b8', tree: '#22c55e',
  bush: '#4ade80', water: '#38bdf8', sand: '#eab308',
  pit_small: '#d97706', pit_large: '#92400e', pothole: '#a8a29e',
  barrel: '#ef4444', tirepile: '#57534e', log: '#a16207',
  drum: '#f97316', cairn: '#d6d3d1', mound: '#ca8a04',
  car_parked: '#60a5fa', cone: '#fb923c', crop: '#4ade80',
  post: '#a8a29e', building: '#78716c',
  car: '#93c5fd', moto: '#fcd34d', ped: '#f472b6',
  tractor: '#4ade80', animal: '#d6a05c'
};
const KIND_LABEL: Record<string, string> = {
  boulder: 'BOULDER', mud: 'MUD-PIT', smoke: 'SMOKE', tree: 'TREE',
  bush: 'BUSH', water: 'WATER', sand: 'SAND-PIT',
  pit_small: 'PIT-S', pit_large: 'PIT-L', pothole: 'POTHOLE',
  barrel: 'BARREL', tirepile: 'TIRE PILE', log: 'FALLEN LOG',
  drum: 'RUSTED DRUM', cairn: 'STONE CAIRN', mound: 'TERMITE MOUND',
  car_parked: 'PARKED CAR', cone: 'CONE', crop: 'CROP',
  post: 'POST', building: 'BUILDING',
  car: 'CAR', moto: 'MOTO', ped: 'PEDESTRIAN',
  tractor: 'TRACTOR', animal: 'LIVESTOCK'
};

// Classic ironbow: black -> violet -> red -> orange -> yellow -> white
const IRON_STOPS: [number, [number, number, number]][] = [
  [0, [5, 5, 12]],
  [0.2, [78, 18, 123]],
  [0.45, [203, 32, 70]],
  [0.7, [255, 148, 28]],
  [0.88, [255, 232, 120]],
  [1, [255, 255, 255]]
];
function ironbow(t01: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, t01));
  for (let i = 1; i < IRON_STOPS.length; i++) {
    if (t <= IRON_STOPS[i][0]) {
      const [t0, c0] = IRON_STOPS[i - 1];
      const [t1, c1] = IRON_STOPS[i];
      const k = (t - t0) / Math.max(1e-6, t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return [255, 255, 255];
}
const ironCss = (t01: number, a: number) => {
  const [r, g, b] = ironbow(t01);
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
};
/** Ambient air estimate from the Jetson thermal-load slider. */
export function airTemp(thermEff: number): number {
  return 12 + (thermEff - 45) * 0.5;
}

export type ThermoPalette = 'white' | 'black' | 'iron';

/** White-hot / black-hot grayscale plus ironbow, all on 0..1 radiometric input. */
export function thermoCss(pal: ThermoPalette, t01: number, a: number): string {
  const t = Math.min(1, Math.max(0, t01));
  if (pal === 'white') {
    const v = Math.round(t * 255);
    return `rgba(${v},${v},${v},${a})`;
  }
  if (pal === 'black') {
    const v = Math.round((1 - t) * 255);
    return `rgba(${v},${v},${v},${a})`;
  }
  return ironCss(t, a);
}

/** Device-OSD corner brackets + name plate. */
export function bracketBox(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  color: string, lw: number, label: string
) {
  const L = Math.min(10, w * 0.25, h * 0.3);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y);
  ctx.moveTo(x + w - L, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + L);
  ctx.moveTo(x + w, y + h - L); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - L, y + h);
  ctx.moveTo(x + L, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - L);
  ctx.stroke();
  ctx.font = '9px "IBM Plex Mono", monospace';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.68)';
  ctx.fillRect(x - 1, y - 18, tw + 8, 14);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + 3, y - 7);
}

export default function PerceptionStreams() {
  const sim = useSim();
  const view = useSimView();
  const smoke = sim.effectiveSmoke();
  const snr = smoke > SNR_SMOKE_CUTOVER;
  const degraded = smoke > 55;
  const palRef = useRef<ThermoPalette>('iron');
  const [pal, setPal] = useState<ThermoPalette>('iron');
  const setPalette = (p: ThermoPalette) => {
    palRef.current = p;
    setPal(p);
  };

  const rgbRef = useFeed((ctx, W, H, t) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = W / dpr;
    const h = H / dpr;
    const night = sim.night;
    // thermal black screen: heat sources read as glowing circles on black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(148,163,184,0.9)';
    ctx.font = '600 9px Inter, sans-serif';
    ctx.fillText(night ? 'LWIR · BLACK-HOT THERMAL · 25 M' : 'LWIR · THERMAL OVERLAY · 25 M', 8, 14);

    if (snr) {
      for (let i = 0; i < 900; i++) {
        const v = Math.floor(Math.random() * 120);
        ctx.fillStyle = `rgba(${v},${v},${v + 20},0.5)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      ctx.fillStyle = 'rgba(2,6,23,0.82)';
      ctx.fillRect(w * 0.06, h * 0.3, w * 0.88, h * 0.3);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(w * 0.06, h * 0.3, w * 0.88, h * 0.3);
      ctx.fillStyle = '#fca5a5';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DYNAMIC SNR DEGRADATION', w / 2, h * 0.43);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText('NAV EXCLUSIVE → LAYER-0 LiDAR', w / 2, h * 0.53);
      ctx.textAlign = 'left';
      return;
    }

    const { pose } = sim;
    const fx = Math.cos(pose.theta);
    const fy = Math.sin(pose.theta);
    const air = airTemp(sim.effectiveThermal());
    interface Vis {
      o: (typeof sim.obstacles)[number];
      bx: number; by: number; bw: number; bh: number; fwd: number; temp: number;
    }
    const vis: Vis[] = [];
    // Layer-1 detection window: everything inside 25 m, nothing beyond
    const DETECT_M = 25;
    for (const o of sim.obstacles) {
      const rx = o.x - pose.x;
      const ry = o.y - pose.y;
      const fwd = rx * fx + ry * fy;
      if (fwd < 0.5 || fwd > DETECT_M) continue;
      const lat = rx * fy - ry * fx;
      if (Math.abs(lat) > 8) continue;
      const bx = w / 2 + (lat / 8) * (w / 2);
      // fixed detection box: same height/width at every range — nearness
      // reads from screen position + distance label, never from box growth
      const bw = 52;
      const bh = 52;
      const by = h * 0.45 + (1 - fwd / DETECT_M) * h * 0.4;
      vis.push({ o, bx, by, bw, bh, fwd, temp: obstacleTemp(o, sim.effectiveThermal(), night) });
    }
    // radiometric scale shared by colors, contours and tags
    let tMax = air + 4;
    for (const v of vis) tMax = Math.max(tMax, v.temp + 2);
    const tMin = air - 4;
    const tnorm = (c: number) => (c - tMin) / Math.max(1e-6, tMax - tMin);
    const pal = palRef.current;
    // nearest detection for the range readout + sightline
    let nearFwd = Infinity;
    let nearBX = 0;
    let nearBY = 0;
    let nearLabel = '—';
    for (const v of vis) {
      if (v.fwd < nearFwd) {
        nearFwd = v.fwd;
        nearBX = v.bx;
        nearBY = v.by;
        nearLabel = KIND_LABEL[v.o.kind] ?? v.o.kind;
      }
    }
    // every heat source is a glowing circle on the black screen
    for (const v of vis) {
      const t01 = tnorm(v.temp);
      const r = 26; // fixed heat-circle radius, matches the fixed box
      const g = ctx.createRadialGradient(v.bx, v.by, 0, v.bx, v.by, r);
      g.addColorStop(0, thermoCss(pal, t01, 0.95));
      g.addColorStop(0.55, thermoCss(pal, t01 * 0.62, 0.8));
      g.addColorStop(1, thermoCss(pal, tnorm(air), 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(v.bx, v.by, r, 0, Math.PI * 2);
      ctx.fill();
      // heat circle outline + isotherm rings on hot targets
      ctx.strokeStyle = thermoCss(pal, Math.min(1, t01 + 0.1), 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(v.bx, v.by, r, 0, Math.PI * 2);
      ctx.stroke();
      if (t01 > 0.55) {
        ctx.strokeStyle = thermoCss(pal, Math.min(1, t01 + 0.15), 0.5);
        ctx.lineWidth = 1;
        for (let k = 1; k <= 2; k++) {
          ctx.beginPath();
          ctx.arc(v.bx, v.by, (r * k) / 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // square detection box with obstacle name (10 m window, near or far)
      const boxColor = KIND_COLOR[v.o.kind] ?? '#ffffff';
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(v.bx - r, v.by - r, r * 2, r * 2);
      const name = `${KIND_LABEL[v.o.kind] ?? v.o.kind} · ${v.fwd.toFixed(1)}m`;
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      const nw = ctx.measureText(name).width;
      const nx = Math.min(Math.max(v.bx - nw / 2, 2), w - nw - 4);
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(nx - 3, v.by - r - 17, nw + 10, 14);
      ctx.fillStyle = boxColor;
      ctx.fillText(name, nx + 2, v.by - r - 6);
      const conf = Math.max(41, 98 - v.fwd * 1.6 - smoke * 0.25).toFixed(1);
      const label = `${KIND_LABEL[v.o.kind] ?? v.o.kind} ${conf}% · ${v.temp.toFixed(1)}°C · ${v.fwd.toFixed(1)}m`;
      ctx.font = '9px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(label).width;
      const tx = Math.min(Math.max(v.bx - tw / 2, 2), w - tw - 4);
      ctx.fillStyle = 'rgba(0,0,0,0.68)';
      ctx.fillRect(tx - 2, v.by + r + 3, tw + 8, 14);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, tx + 2, v.by + r + 13);
    }
    // toy UGV ego marker (bottom-center) + sightline + range readout:
    // every Layer-1 distance is measured from this toy
    const egoX = w / 2;
    const egoY = h - 12;
    if (nearFwd < Infinity) {
      ctx.strokeStyle = 'rgba(52,211,153,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(egoX, egoY - 8);
      ctx.lineTo(nearBX, nearBY);
      ctx.stroke();
      ctx.setLineDash([]);
      const midX = (egoX + nearBX) / 2;
      const midY = (egoY - 8 + nearBY) / 2;
      const rl = `${nearFwd.toFixed(1)}m`;
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      const rw = ctx.measureText(rl).width;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(midX - rw / 2 - 3, midY - 8, rw + 6, 12);
      ctx.fillStyle = '#34d399';
      ctx.fillText(rl, midX - rw / 2, midY + 2);
    }
    // toy: rounded hull + 4 wheels + heading notch, facing up-screen
    ctx.fillStyle = '#0b1220';
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(egoX - 11, egoY - 9, 22, 15, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#34d399';
    for (const [wx, wy] of [[-13, -7], [9, -7], [-13, 2], [9, 2]] as const) {
      ctx.fillRect(egoX + wx, egoY + wy, 4, 4);
    }
    ctx.beginPath();
    ctx.moveTo(egoX - 4, egoY - 9);
    ctx.lineTo(egoX + 4, egoY - 9);
    ctx.lineTo(egoX, egoY - 13);
    ctx.closePath();
    ctx.fill();
    ctx.font = '600 8px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#34d399';
    ctx.fillText('UGV', egoX - 9, egoY + 14);
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    const rangeLine = nearFwd < Infinity
      ? `NEAREST ${nearLabel} ${nearFwd.toFixed(1)}m · ${vis.length} ≤25m`
      : `${vis.length} ≤25m · CLEAR`;
    const rlw = ctx.measureText(rangeLine).width;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(w - rlw - 10, 6, rlw + 8, 15);
    ctx.fillStyle = nearFwd < 2 ? '#f43f5e' : '#e2e8f0';
    ctx.fillText(rangeLine, w - rlw - 6, 17);
    // NETD sensor grain
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 220; i++) {
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
    }
    ctx.fillStyle = 'rgba(34,211,238,0.05)';
    for (let i = 0; i < 5; i++) {
      const y = h * 0.5 + ((t * 30 + i * 47) % (h * 0.5));
      ctx.fillRect(0, y, w, 3);
    }
    ctx.strokeStyle = 'rgba(34,211,238,0.7)';
    ctx.beginPath();
    ctx.moveTo(w / 2 - 12, h / 2);
    ctx.lineTo(w / 2 + 12, h / 2);
    ctx.moveTo(w / 2, h / 2 - 12);
    ctx.lineTo(w / 2, h / 2 + 12);
    ctx.stroke();
    if (degraded) {
      ctx.fillStyle = `rgba(100,116,139,${0.35 + smoke / 200})`;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(2,6,23,0.75)';
      ctx.fillRect(w * 0.12, h * 0.32, w * 0.76, h * 0.24);
      ctx.strokeStyle = '#f59e0b';
      ctx.strokeRect(w * 0.12, h * 0.32, w * 0.76, h * 0.24);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('VISION DEGRADED — LAYER-0 FALLBACK', w / 2, h * 0.45);
      ctx.textAlign = 'left';
    }
  });

  const depthRef = useFeed((ctx, W, H, t) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = W / dpr;
    const h = H / dpr;
    ctx.fillStyle = '#010409';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(226,232,240,0.5)';
    const off = (t * sim.actV * 18) % 16;
    for (let y = h * 0.3; y < h; y += 11) {
      for (let x = 4; x < w; x += 11) {
        if (Math.random() < 0.12) continue;
        ctx.fillRect(x, y + ((off / 16) % 1) * 4, 1.6, 1.6);
      }
    }
    const { pose } = sim;
    const fx = Math.cos(pose.theta);
    const fy = Math.sin(pose.theta);
    for (const o of sim.obstacles) {
      if (o.kind === 'smoke' || o.kind === 'sand' || o.kind === 'mud') continue;
      const rx = o.x - pose.x;
      const ry = o.y - pose.y;
      const fwd = rx * fx + ry * fy;
      if (fwd < 0.3 || fwd > 14) continue;
      const lat = rx * fy - ry * fx;
      if (Math.abs(lat) > 6) continue;
      const edge = Math.hypot(o.x - (pose.x + fx * 0.9), o.y - (pose.y + fy * 0.9)) - o.r;
      const danger = edge < 2.5 && (o.kind === 'boulder' || o.kind === 'tree' || o.kind === 'bush');
      const bx = w / 2 + (lat / 6) * (w / 2);
      const bw = Math.min(w * 0.6, (2.4 / Math.max(0.6, fwd)) * w * 0.22 + 14);
      const bh = bw * 0.8;
      const by = h * 0.55 + (1 - fwd / 14) * h * 0.25;
      ctx.fillStyle = '#000';
      ctx.fillRect(bx - bw / 2, by - bh, bw, bh);
      ctx.strokeStyle = danger ? '#f43f5e' : '#e2e8f0';
      ctx.lineWidth = danger ? 2.5 : 1;
      if (danger) {
        ctx.save();
        ctx.shadowColor = '#f43f5e';
        ctx.shadowBlur = 12;
      }
      ctx.strokeRect(bx - bw / 2, by - bh, bw, bh);
      if (danger) ctx.restore();
      ctx.fillStyle = danger ? '#f43f5e' : '#94a3b8';
      ctx.font = '9px "IBM Plex Mono", monospace';
      ctx.fillText(`${fwd.toFixed(1)}m`, bx - 14, by - bh - 4);
    }
    ctx.strokeStyle = view.override ? '#f43f5e' : 'rgba(52,211,153,0.6)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, h * 0.92);
    ctx.lineTo(w, h * 0.92);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = view.override ? '#f43f5e' : 'rgba(52,211,153,0.8)';
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.fillText('SHIELD 0.8m', 6, h * 0.92 - 4);
  });

  const L = view.latest;
  const thermEff = sim.effectiveThermal();
  const tAir = airTemp(thermEff);
  let tHi = tAir + 4;
  for (const o of sim.obstacles) tHi = Math.max(tHi, obstacleTemp(o, thermEff, sim.night) + 2);
  const tLo = tAir - 4;
  // Layer-1 detection census: obstacles inside the 25 m thermal window
  let tracked10 = 0;
  {
    const fx = Math.cos(sim.pose.theta);
    const fy = Math.sin(sim.pose.theta);
    for (const o of sim.obstacles) {
      const rx = o.x - sim.pose.x;
      const ry = o.y - sim.pose.y;
      const fwd = rx * fx + ry * fy;
      if (fwd < 0.5 || fwd > 25) continue;
      if (Math.abs(rx * fy - ry * fx) > 8) continue;
      tracked10++;
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.08 }} className="glass p-4">
      <div className="flex items-center justify-between border-b border-hairline pb-2.5 mb-3">
        <h2 className="panel-title">Dual-channel perception</h2>
        <span className="font-sans text-[11px] font-semibold text-stone-500">L0 vs L1</span>
      </div>
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="badge border-pine-700/25 bg-pine-50 text-pine-800">
              <Brain size={12} /> Layer-1 · DINOv2 + LWIR
            </span>
            <span className="font-mono text-[11px] font-semibold text-pine-700">{L.lat.toFixed(1)} ms · {L.fps.toFixed(0)} FPS</span>
          </div>
          <canvas ref={rgbRef} className="w-full rounded-lg border border-stone-200" />
          <p className="font-sans text-[10px] text-stone-400 mt-1">
            TensorRT INT8 · {L.fps.toFixed(0)} FPS · {L.lat.toFixed(1)} ms · {tracked10} tracked ≤25m · {snr ? 'SNR collapse — Layer-0 exclusive' : degraded ? 'Fallback to Layer-0' : sim.night ? 'Night — thermal primary' : 'Segmentation live'}
          </p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <div className="flex rounded-md overflow-hidden border border-stone-300">
              {(['white', 'black', 'iron'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPalette(p)}
                  className={`font-sans text-[10px] font-semibold px-2 py-1 transition ${
                    pal === p ? 'bg-stone-900 text-white' : 'bg-white text-stone-500 hover:text-stone-800'
                  }`}
                  title={p === 'white' ? 'White hot' : p === 'black' ? 'Black hot' : 'Ironbow'}
                >
                  {p === 'white' ? 'White hot' : p === 'black' ? 'Black hot' : 'Ironbow'}
                </button>
              ))}
            </div>
            <span className="font-mono text-[9px] text-stone-500">{tLo.toFixed(0)}°</span>
            <div
              className="h-1.5 w-24 rounded-full shrink-0"
              style={{
                background:
                  pal === 'white'
                    ? 'linear-gradient(90deg,#000000,#ffffff)'
                    : pal === 'black'
                      ? 'linear-gradient(90deg,#ffffff,#000000)'
                      : 'linear-gradient(90deg,#05050c,#4e127b,#cb2046,#ff941c,#ffe878,#ffffff)'
              }}
            />
            <span className="font-mono text-[9px] text-stone-500">{tHi.toFixed(0)}°</span>
            <span className="font-sans text-[10px] text-stone-500">LWIR · NETD 50mK · src: {sim.night ? 'THERMAL + LiDAR' : 'RGB + THERMAL'}</span>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className={`badge ${view.override ? 'border-signal/40 bg-red-50 text-signal' : 'border-stone-300 bg-stone-100 text-stone-600'}`}>
              <ShieldAlert size={12} /> Layer-0 · RANSAC shield
            </span>
            <span className="font-mono text-[11px] text-stone-500">{L.planeInliers.toFixed(1)}% plane</span>
          </div>
          <div className="relative">
            <canvas ref={depthRef} className="w-full rounded-lg border border-stone-200" />
            {view.override && (
              <div className="absolute inset-x-0 top-2 mx-auto w-fit bg-signal text-white font-sans text-[11px] font-bold px-3 py-1 rounded-md tracking-wide shadow-lift">
                LAYER-0 OVERRIDE ACTIVE
              </div>
            )}
          </div>
          <p className="font-sans text-[10px] text-stone-400 mt-1">Binary depth · ground plane vs geometric hazards · LiDAR day/night invariant</p>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
              <div className="flex justify-between font-sans text-[10px] font-semibold text-stone-500">
                <span>GROUND PLANE</span><span className="font-mono text-stone-700">{L.planeInliers.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-stone-200 overflow-hidden mt-1">
                <div className="h-full rounded-full bg-pine-600" style={{ width: `${Math.min(100, L.planeInliers)}%` }} />
              </div>
              <div className="font-mono text-[9px] text-stone-400 mt-1">OS1-32 · 32 rays · {L.lidarReturns} returns · 10 Hz · 12 m</div>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
              <div className="flex justify-between font-sans text-[10px] font-semibold text-stone-500">
                <span>SHIELD MARGIN</span>
                <span className="font-mono" style={{ color: L.margin < 0.8 ? '#DC2626' : L.margin < 1.5 ? '#B45309' : '#1B5E43' }}>
                  {L.margin > 20 ? 'CLEAR' : `${L.margin.toFixed(2)}m ${L.marginKind}`}
                </span>
              </div>
              <div className="relative h-1.5 rounded-full bg-stone-200 overflow-visible mt-1">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (Math.min(4, L.margin) / 4) * 100)}%`,
                    background: L.margin < 0.8 ? '#DC2626' : L.margin < 1.5 ? '#B45309' : '#1B5E43'
                  }}
                />
                <div className="absolute top-[-3px] h-[12px] w-px bg-clay-700" style={{ left: '37.5%' }} title="caution 1.5m" />
                <div className="absolute top-[-3px] h-[12px] w-px bg-signal" style={{ left: '20%' }} title="override 0.8m" />
              </div>
              <div className="font-mono text-[9px] text-stone-400 mt-1">
                overrides {sim.overrideCount} · last: {sim.lastOverrideMsg}
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
