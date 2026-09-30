import { motion } from 'framer-motion';
import { Camera, Crosshair, Gauge, Navigation, Radar, Thermometer, Zap } from 'lucide-react';
import { obstacleTemp, useSimView } from '../sim/store';
import { airTemp } from './PerceptionStreams';

function Row({ icon, name, reading, ok, warn }: {
  icon: React.ReactNode; name: string; reading: string; ok: boolean; warn?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-stone-200 bg-stone-50/70 px-2.5 py-2">
      <span className="text-stone-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[11px] font-bold text-stone-800 leading-tight">{name}</div>
        <div className="font-mono text-[10px] text-stone-500 leading-tight truncate">{reading}</div>
      </div>
      <span className={`h-2 w-2 rounded-full shrink-0 ${ok ? 'bg-pine-600' : warn ? 'bg-clay-600' : 'bg-signal'}`} />
    </div>
  );
}

export default function SensorPanel() {
  const sim = useSimView();
  const L = sim.latest;
  const thermEff = sim.effectiveThermal();
  let hottest = -99;
  let hottestKind = '—';
  for (const o of sim.obstacles) {
    const t = obstacleTemp(o, thermEff, sim.night);
    if (t > hottest) {
      hottest = t;
      hottestKind = o.kind;
    }
  }
  if (!sim.obstacles.length) hottest = thermEff - 30;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.1 }} className="glass p-4">
      <div className="flex items-center justify-between border-b border-hairline pb-2.5 mb-3">
        <h2 className="panel-title">Sensor manifest</h2>
        <span className="font-sans text-[11px] font-semibold text-stone-500">7 devices · fused</span>
      </div>
      <div className="space-y-1.5">
        <Row
          icon={<Radar size={14} />} name="Ouster OS1-32 LiDAR"
          reading={`32 rays · ${L.lidarReturns} returns · 12 m · 10 Hz${sim.night ? ' · primary' : ''}`}
          ok={!sim.override} warn={sim.override}
        />
        <Row
          icon={<Thermometer size={14} />} name="FLIR Boson LWIR"
          reading={`air ${airTemp(thermEff).toFixed(1)}°C · hot ${hottestKind} ${hottest.toFixed(1)}°C · ${L.fps.toFixed(0)} FPS${sim.night ? ' · primary' : ''}`}
          ok={!L.snrDegraded} warn={L.snrDegraded}
        />
        <Row
          icon={<Camera size={14} />} name="RealSense RGB-D"
          reading={`${L.lat.toFixed(1)} ms · 0.3–10 m · ${L.snrDegraded ? 'SNR blind' : sim.night ? 'low-light' : 'nominal'}`}
          ok={!L.snrDegraded} warn={L.snrDegraded}
        />
        <Row
          icon={<Gauge size={14} />} name="9-DOF IMU"
          reading={`ax ${L.ax.toFixed(2)} · az ${L.az.toFixed(2)} · vib ${L.vib.toFixed(2)}g`}
          ok
        />
        <Row
          icon={<Navigation size={14} />} name="VIO + ZUPT"
          reading={`drift ${L.vio.toFixed(3)} m · ${L.zupt ? 'ZUPT locked' : 'tracking'} · GPS denied`}
          ok={L.vio < 0.4} warn={L.vio >= 0.4}
        />
        <Row
          icon={<Zap size={14} />} name="ACS758 current shunts"
          reading={`L ${L.curL.toFixed(1)} A · R ${L.curR.toFixed(1)} A`}
          ok={L.curL < 20 && L.curR < 20} warn={L.curL >= 20 || L.curR >= 20}
        />
        <Row
          icon={<Crosshair size={14} />} name="Wheel encoders + TF2"
          reading={`slip L ${(L.slipL * 100).toFixed(0)}% R ${(L.slipR * 100).toFixed(0)}% · lag ${L.lag.toFixed(0)} ms comp.`}
          ok={L.slipL < 0.5 && L.slipR < 0.5} warn={L.slipL >= 0.5 || L.slipR >= 0.5}
        />
      </div>
    </motion.div>
  );
}
