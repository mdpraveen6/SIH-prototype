import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  CloudFog, Crosshair, Droplets, Flame, Grid3X3, Map, Mountain, Orbit,
  Sprout, Sun, TreePine, Waves, Zap
} from 'lucide-react';
import { PRESETS } from '../sim/terrain';
import { ObstacleKind, useSimView } from '../sim/store';

const TOOLS: { id: ObstacleKind; label: string; icon: React.ReactNode }[] = [
  { id: 'boulder', label: 'Boulder', icon: <Mountain size={15} /> },
  { id: 'tree', label: 'Tree', icon: <TreePine size={15} /> },
  { id: 'mud', label: 'Mud', icon: <Waves size={15} /> },
  { id: 'water', label: 'Water', icon: <Droplets size={15} /> },
  { id: 'sand', label: 'Sand', icon: <Sun size={15} /> },
  { id: 'bush', label: 'Bush', icon: <Sprout size={15} /> },
  { id: 'smoke', label: 'Smoke', icon: <CloudFog size={15} /> }
];

function Slider({ label, value, min, max, step, unit, onChange, hint, warn }: {
  label: string; value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void; hint?: string; warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between items-baseline gap-2">
        <span className="font-sans text-[11px] font-semibold text-stone-700 truncate">{label}</span>
        <span className={`font-mono text-[11px] font-semibold shrink-0 ${warn ? 'text-clay-700' : 'text-pine-700'}`}>
          {value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}{unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      {hint && <p className={`font-sans text-[10px] leading-tight truncate ${warn ? 'text-clay-700 font-medium' : 'text-stone-400'}`} title={hint}>{hint}</p>}
    </div>
  );
}

function Zone({ icon, title, children, className = '' }: { icon: React.ReactNode; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-stone-200/90 bg-stone-50/70 p-3 min-w-0 ${className}`}>
      <p className="section-label mb-2 flex items-center gap-1.5">{icon}{title}</p>
      {children}
    </section>
  );
}

export default function ControlConsole() {
  const sim = useSimView();
  const p = sim.params;
  const L = sim.latest;
  const [gx, setGx] = useState('');
  const [gy, setGy] = useState('');
  const sendGoal = () => {
    const x = parseFloat(gx);
    const y = parseFloat(gy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    sim.setGoal(Math.max(-119, Math.min(119, x)), Math.max(-74, Math.min(74, y)));
    setGx('');
    setGy('');
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="glass p-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline pb-2.5 mb-3">
        <h2 className="panel-title">Mission control</h2>
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          <span className="badge border-stone-300 bg-stone-100 text-stone-600">
            <Crosshair size={11} /> {L.soilLabel} · μ{L.soilMu.toFixed(2)}
          </span>
          <span className={`badge ${sim.latest.snrDegraded ? 'border-clay-700/30 bg-orange-50 text-clay-700' : 'border-pine-700/25 bg-pine-50 text-pine-800'}`}>
            {sim.latest.snrDegraded ? 'Nav · Layer-0 only' : 'Nav · Layer-0 + Layer-1'}
          </span>
          {sim.goal ? (
            <span className="badge border-pine-700/25 bg-pine-50 text-pine-800">
              Goal {sim.goal.x.toFixed(0)},{sim.goal.y.toFixed(0)} · {sim.latest.goalDist >= 0 ? `${sim.latest.goalDist.toFixed(0)}m` : ''}
              <button onClick={() => sim.clearGoal()} className="ml-1 underline underline-offset-2 hover:text-pine-900" title="Clear goal">clear</button>
            </span>
          ) : (
            <span className="badge border-stone-300 bg-stone-100 text-stone-500">No goal — right-click map</span>
          )}
          <button onClick={() => sim.toggleGrid()} className={`tactical-btn !text-[11px] !py-1 ${sim.showGrid ? '!border-pine-700 !text-pine-700 !bg-pine-50' : ''}`} title="Toggle grid">
            <Grid3X3 size={12} /> Grid
          </button>
          <button onClick={() => sim.toggleOrbit()} className={`tactical-btn !text-[11px] !py-1 ${sim.orbit ? '!border-pine-700 !text-pine-700 !bg-pine-50' : ''}`} title="Camera orbit">
            <Orbit size={12} /> Orbit
          </button>
          <button onClick={() => sim.toggleNight()} className={`tactical-btn !text-[11px] !py-1 ${sim.night ? '!border-pine-700 !text-pine-700 !bg-pine-50' : ''}`} title="Night ops — headlights + thermal primary">
            {sim.night ? 'Night' : 'Day'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-[1fr_1.35fr_1fr_0.9fr] gap-3">
        <Zone icon={<Map size={12} />} title="Terrain">
          <div className="grid grid-cols-2 gap-1.5">
            {PRESETS.map((pr) => (
              <button
                key={pr.id}
                onClick={() => sim.applyPreset(pr.id)}
                title={pr.desc}
                className={`rounded-lg border px-2 py-1.5 text-left transition active:scale-[0.98] ${
                  sim.preset.id === pr.id
                    ? 'border-pine-700 bg-pine-700 text-white shadow-sm'
                    : 'border-stone-300 bg-white text-stone-700 hover:border-stone-400'
                }`}
              >
                <div className="font-sans text-[11px] font-bold leading-tight">{pr.label}</div>
                <div className={`font-sans text-[9px] leading-tight truncate ${sim.preset.id === pr.id ? 'text-pine-100' : 'text-stone-400'}`}>{pr.desc}</div>
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              value={gx} onChange={(e) => setGx(e.target.value)} placeholder="X m"
              className="w-full min-w-0 rounded-md border border-stone-300 bg-white px-2 py-1.5 font-mono text-[11px] text-stone-800 placeholder:text-stone-400 focus:outline-none focus:border-pine-700"
              inputMode="decimal" title="Goal X, map meters"
            />
            <input
              value={gy} onChange={(e) => setGy(e.target.value)} placeholder="Y m"
              className="w-full min-w-0 rounded-md border border-stone-300 bg-white px-2 py-1.5 font-mono text-[11px] text-stone-800 placeholder:text-stone-400 focus:outline-none focus:border-pine-700"
              inputMode="decimal" title="Goal Y, map meters"
            />
            <button onClick={sendGoal} className="tactical-btn !text-[11px] !py-1.5 shrink-0 !border-pine-700 !bg-pine-700 !text-white" title="Send goal to coordinates">
              Go
            </button>
            {sim.goal && (
              <button onClick={() => sim.clearGoal()} className="tactical-btn !text-[11px] !py-1.5 shrink-0" title="Clear goal">
                ✕
              </button>
            )}
          </div>
        </Zone>

        <Zone icon={<Zap size={12} />} title="Drive & environment" className="md:col-span-1 2xl:col-span-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-2 gap-x-4 gap-y-2.5">
            <Slider label="Target velocity" value={p.velocity} min={0} max={4} step={0.1} unit=" m/s" onChange={(v) => sim.setParams({ velocity: v })} />
            <Slider
              label="Moisture ×μ" value={p.friction} min={0.1} max={0.95} step={0.05} unit=""
              onChange={(v) => sim.setParams({ friction: v })}
              hint={p.friction < 0.35 ? 'Monsoon-wet' : p.friction > 0.7 ? 'Dry season' : 'Normal'}
            />
            <Slider
              label="Smoke / dust" value={p.smoke} min={0} max={100} step={1} unit="%"
              onChange={(v) => sim.setParams({ smoke: v })}
              warn={p.smoke > 80}
              hint={p.smoke > 80 ? 'SNR degradation — Layer-0 only' : p.smoke > 55 ? 'Layer-0 fallback armed' : 'Layer-1 nominal'}
            />
            <Slider
              label="GPU thermal" value={p.thermal} min={45} max={90} step={1} unit="°C"
              onChange={(v) => sim.setParams({ thermal: v })}
              warn={L.throttled}
              hint={L.throttled ? 'Throttle — backprop 2 Hz' : 'Nominal — 10 Hz'}
            />
            <Slider
              label="Safety bubble" value={p.bubble} min={1} max={4} step={0.25} unit=" m"
              onChange={(v) => {
                sim.setParams({ bubble: v });
                if (sim.goal && !sim.arrived) sim.replan('bubble resized');
              }}
              hint="Guaranteed-clear ring — planner + shield enforce it"
            />
          </div>
        </Zone>

        <Zone icon={<Mountain size={12} />} title="Hazard tool — click map">
          <div className="grid grid-cols-4 2xl:grid-cols-4 gap-1.5">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                onClick={() => sim.setTool(t.id)}
                title={t.label}
                className={`rounded-lg border px-1 py-2 font-sans text-[10px] font-semibold flex flex-col items-center gap-1 transition active:scale-[0.97] ${
                  sim.tool === t.id
                    ? 'border-pine-700 bg-pine-700 text-white shadow-sm'
                    : 'border-stone-300 bg-white text-stone-600 hover:border-stone-400'
                }`}
              >
                {t.icon} {t.label}
              </button>
            ))}
            <div className="col-span-4 font-sans text-[10px] text-stone-400 leading-tight">
              Selected: <span className="font-semibold text-pine-700">{TOOLS.find((t) => t.id === sim.tool)?.label}</span> — drops where you click the 3D view
            </div>
          </div>
        </Zone>

        <Zone icon={<Flame size={12} />} title="Fault injection">
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => sim.dropBoulderAhead()} className="tactical-btn !text-[11px]" title="Drop a boulder 5m ahead">
              <Mountain size={12} /> +5m
            </button>
            <button onClick={() => sim.injectSlipBurst()} className="tactical-btn !text-[11px]" title="4s wheel-slip burst">
              <Zap size={12} /> Slip
            </button>
            <button onClick={() => sim.smokeBurst()} className="tactical-btn !text-[11px]" title="6s smoke burst">
              <CloudFog size={12} /> Smoke
            </button>
            <button onClick={() => sim.thermalSoak()} className="tactical-btn !text-[11px]" title="+8°C soak for 12s">
              <Flame size={12} /> Heat
            </button>
          </div>
        </Zone>
      </div>

      <div className="rounded-lg bg-stone-900 text-stone-100 px-3 py-2 font-mono text-[10px] leading-relaxed flex flex-wrap gap-x-4 gap-y-0.5">
        <span><span className="text-stone-400">ROUTE</span> {sim.goal ? `${sim.routeLen.toFixed(0)} m · ${sim.route.length} wpts` : '—'}</span>
        <span><span className="text-stone-400">REPLANS</span> {sim.replanCount}</span>
        <span className="text-emerald-300 truncate min-w-0 flex-1">▸ {sim.replanMsg}</span>
      </div>
    </motion.div>
  );
}
