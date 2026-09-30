import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { Activity, Battery, Gauge, Navigation, Shield, Thermometer, Zap } from 'lucide-react';
import { useSimView } from '../sim/store';

function Spark({ data, color, min, max, height = 56 }: { data: number[]; color: string; min: number; max: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth * dpr;
    const h = height * dpr;
    c.width = w;
    c.height = h;
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) return;
    const yOf = (v: number) => h - 4 * dpr - ((v - min) / (max - min)) * (h - 10 * dpr);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8 * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      if (i === 0) ctx.moveTo(x, yOf(v));
      else ctx.lineTo(x, yOf(v));
    });
    ctx.stroke();
  });
  return <canvas ref={ref} style={{ height }} className="w-full" />;
}

function Meter({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-1.5 rounded-full bg-stone-200 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-150" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: '#ffffff',
  border: '1px solid #E7E5E0',
  borderRadius: 8,
  fontSize: 11,
  fontFamily: '"IBM Plex Mono", monospace',
  color: '#1C1917',
  boxShadow: '0 4px 16px rgba(28,25,23,0.10)'
} as const;

const axisTick = { fill: '#A8A29E', fontSize: 10, fontFamily: '"IBM Plex Mono", monospace' };

export default function TelemetryPanel() {
  const sim = useSimView();
  const L = sim.latest;
  const tempColor = L.temp > 82 ? '#DC2626' : L.temp > 70 ? '#B45309' : '#1B5E43';

  const vioData = sim.hist.vio.map((v, i) => ({ i, drift: +v.toFixed(3) }));
  const slipData = [
    { name: 'Left', slip: +(L.slipL * 100).toFixed(1) },
    { name: 'Right', slip: +(L.slipR * 100).toFixed(1) }
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="glass p-4 space-y-4">
      <div className="flex items-center justify-between border-b border-hairline pb-2.5">
        <h2 className="panel-title">Proprioceptive telemetry</h2>
        <span className="inline-flex items-center gap-1.5 font-sans text-[11px] font-semibold text-pine-700">
          <span className="h-1.5 w-1.5 rounded-full bg-pine-600" /> Live
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className={`rounded-lg border p-2 ${sim.override ? 'border-signal/40 bg-red-50' : 'border-pine-700/25 bg-pine-50'}`}>
          <div className="flex items-center gap-1 font-sans text-[10px] font-semibold tracking-wide text-stone-500"><Shield size={11} /> LAYER-0</div>
          <div className={`font-sans text-[13px] font-bold ${sim.override ? 'text-signal' : 'text-pine-800'}`}>
            {sim.override ? 'Override' : 'Armed'}
          </div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-2">
          <div className="font-sans text-[10px] font-semibold tracking-wide text-stone-500">LAYER-1</div>
          <div className="font-sans text-[13px] font-bold text-stone-800">{L.throttled ? 'Throttled' : L.snrDegraded ? 'SNR blind' : 'Tracking'}</div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-2">
          <div className="font-sans text-[10px] font-semibold tracking-wide text-stone-500">MPPI</div>
          <div className="font-sans text-[13px] font-bold text-stone-800">{sim.estop ? 'Hold' : '2048 S/s'}</div>
        </div>
      </div>

      <div className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 font-sans text-[11px] flex justify-between items-center">
        <span className="font-semibold tracking-wide text-stone-500 text-[10px]">TERRAIN</span>
        <span className="font-semibold text-stone-800">{L.soilLabel} · <span className="font-mono">μ{L.soilMu.toFixed(2)}</span></span>
      </div>

      <div>
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="section-label flex items-center gap-1.5"><Gauge size={12} /> Wheel slip S(t)</span>
          <span className="font-mono text-[11px] text-stone-700">L {(L.slipL * 100).toFixed(0)}% · R {(L.slipR * 100).toFixed(0)}%</span>
        </div>
        <div className="h-[110px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={slipData} layout="vertical" margin={{ top: 2, right: 8, bottom: 2, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E7E5E0" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} hide />
              <YAxis type="category" dataKey="name" tick={{ fill: '#57534E', fontSize: 11, fontFamily: 'Inter, sans-serif', fontWeight: 600 }} width={52} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}%`, 'slip']} />
              <Bar dataKey="slip" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {slipData.map((d, i) => (
                  <Cell key={i} fill={d.slip > 50 ? '#DC2626' : '#1B5E43'} />
                ))}
              </Bar>
              <ReferenceLine x={50} stroke="#B45309" strokeDasharray="4 3" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="section-label flex items-center gap-1.5"><Zap size={12} /> Motor shunt ACS758</span>
          <span className="font-mono text-[11px] text-stone-700">{L.curL.toFixed(1)}A · {L.curR.toFixed(1)}A</span>
        </div>
        <Spark data={sim.hist.curL} color="#B45309" min={0} max={25} />
      </div>

      <div>
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="section-label flex items-center gap-1.5"><Activity size={12} /> 9-DOF IMU vibration</span>
          <span className="font-mono text-[11px] text-stone-700">{L.vib.toFixed(2)}g · ax {L.ax.toFixed(2)}</span>
        </div>
        <Spark data={sim.hist.vib} color="#4D7C0F" min={0} max={5} />
      </div>

      <div>
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="section-label flex items-center gap-1.5"><Navigation size={12} /> VIO drift {L.zupt ? '· ZUPT' : ''}</span>
          <span className={`font-mono text-[11px] ${L.vio > 0.4 ? 'text-signal' : 'text-pine-700'}`}>{L.vio.toFixed(3)}m / 0.45m</span>
        </div>
        <div className="h-[120px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={vioData} margin={{ top: 4, right: 8, bottom: 2, left: -14 }}>
              <defs>
                <linearGradient id="vioFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#1B5E43" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#1B5E43" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E7E5E0" />
              <XAxis dataKey="i" hide />
              <YAxis domain={[0, 0.5]} tick={axisTick} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v} m`, 'drift']} labelFormatter={() => ''} />
              <ReferenceLine y={0.45} stroke="#DC2626" strokeDasharray="5 4" label={{ value: '0.45', fill: '#DC2626', fontSize: 9, position: 'insideTopRight' }} />
              <Area type="monotone" dataKey="drift" stroke="#1B5E43" strokeWidth={2} fill="url(#vioFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5">
          <div className="flex items-center gap-1 font-sans text-[10px] font-semibold tracking-wide text-stone-500"><Thermometer size={11} /> JETSON GPU</div>
          <div className="font-sans text-lg font-bold leading-tight" style={{ color: tempColor }}>{L.temp.toFixed(0)}°C</div>
          <Meter value={L.temp} max={100} color={tempColor} />
          <div className="font-sans text-[10px] text-stone-500 mt-1 flex items-center gap-1"><Battery size={10} /> {L.vram.toFixed(2)} / 8 GB</div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5">
          <div className="font-sans text-[10px] font-semibold tracking-wide text-stone-500">TF2 SYNC</div>
          <div className="font-sans text-lg font-bold leading-tight text-stone-800">{L.lag.toFixed(0)}<span className="text-xs font-semibold text-stone-500"> ms</span></div>
          <div className="font-sans text-[10px] text-stone-500">obs → contact compensated</div>
          <div className="font-mono text-[10px] text-stone-500">a<sub>z</sub> {L.az.toFixed(2)} m/s²</div>
        </div>
      </div>
    </motion.div>
  );
}
