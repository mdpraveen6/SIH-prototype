import { AnimatePresence, motion } from 'framer-motion';
import { Cpu, Grid3X3, Moon, OctagonX, Orbit, Palette, Power, RotateCcw, Satellite, Shield, Sun } from 'lucide-react';
import { OpMode, useSimView } from '../sim/store';

const MODES: { id: OpMode; label: string }[] = [
  { id: 'sim', label: 'Gazebo Sim Feed' },
  { id: 'live', label: 'Live Field Telemetry' },
  { id: 'replay', label: 'Replay Log' }
];

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {pulse && <span className={`absolute inline-flex h-full w-full rounded-full opacity-50 animate-ping ${color}`} />}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
    </span>
  );
}

export default function Header() {
  const sim = useSimView();
  const L = sim.latest;

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-hairline">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-pine-700 text-white text-sm" style={{ fontWeight: 800 }}>
            S
          </div>
          <div>
            <h1 className="font-sans text-[15px] font-bold tracking-tight text-stone-900 leading-tight">
              SPARSH <span className="font-medium text-stone-400">/ Self-Supervised UGV Autonomy &amp; Safety Stack</span>
            </h1>
            <p className="font-mono text-[10px] tracking-[0.18em] text-stone-500">
              {sim.mode === 'sim' ? 'GAZEBO SIM' : sim.mode === 'live' ? 'LIVE FIELD' : 'REPLAY LOG'} · {sim.preset.label.toUpperCase()} · T+{sim.simTime.toFixed(1)}s{sim.night ? ' · NIGHT OPS' : ''}
              {L.snrDegraded && <span className="text-clay-700 font-semibold"> · SNR DEGRADED → L0 EXCLUSIVE</span>}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 ml-auto">
          <span className={`badge ${sim.estop ? 'border-signal/40 bg-red-50 text-signal' : 'border-pine-700/25 bg-pine-50 text-pine-800'}`}>
            <Dot color={sim.estop ? 'bg-signal' : 'bg-pine-600'} pulse={sim.estop || sim.override} />
            {sim.estop ? 'E-STOP' : sim.override ? 'AVOIDANCE' : sim.arrived ? 'ARRIVED' : sim.goalBlocked ? 'GOAL BLOCKED' : sim.driveState === 'reversing' ? 'RECOVERY' : sim.goal ? 'ENROUTE · MPPI' : 'MPPI TRAJECTORY SAMPLING'}
          </span>
          <span className={`badge ${sim.override ? 'border-signal/40 bg-red-50 text-signal' : 'border-stone-300 bg-stone-100 text-stone-600'}`}>
            <Shield size={12} /> {sim.override ? 'LAYER-0 OVERRIDE' : 'LAYER-0 ARMED'}
          </span>
          <span className="badge border-stone-300 bg-stone-100 text-stone-600 hidden md:inline-flex">
            <Satellite size={12} /> GPS DENIED · VIO + IMU + ZUPT
          </span>
          <span className="badge border-stone-300 bg-stone-100 text-stone-600 hidden lg:inline-flex">
            <Cpu size={12} /> ORIN NANO · {L.vram.toFixed(2)}/8GB · {L.temp.toFixed(0)}°C · {L.lat.toFixed(1)}ms
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-stone-300 bg-stone-100 p-0.5 gap-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => sim.setMode(m.id)}
                className={`font-sans text-[11px] font-semibold px-2.5 py-1 rounded-md transition ${
                  sim.mode === m.id ? 'bg-white text-pine-800 shadow-sm' : 'text-stone-500 hover:text-stone-800'
                }`}
                title={m.label}
              >
                {m.id.toUpperCase()}
              </button>
            ))}
          </div>
          <button onClick={() => sim.toggleGrid()} className={`tactical-btn !px-2.5 ${sim.showGrid ? '!border-pine-700 !text-pine-700 !bg-pine-50' : ''}`} title="Toggle tactical grid">
            <Grid3X3 size={14} />
          </button>
          <button onClick={() => sim.toggleOrbit()} className={`tactical-btn !px-2.5 ${sim.orbit ? '!border-pine-700 !text-pine-700 !bg-pine-50' : ''}`} title="Camera orbit">
            <Orbit size={14} />
          </button>
          <button onClick={() => sim.toggleTheme()} className="tactical-btn !px-2.5" title="Scene light">
            <Palette size={14} />
          </button>
          <div className="flex rounded-lg overflow-hidden border border-stone-300 bg-stone-100 p-0.5 gap-0.5" title="Scene lighting — thermal + LiDAR carry detection at night">
            <button
              onClick={() => sim.night && sim.toggleNight()}
              className={`font-sans text-[11px] font-semibold px-3 py-1.5 rounded-md transition flex items-center gap-1.5 ${
                !sim.night ? 'bg-white text-amber-600 shadow-sm' : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              <Sun size={13} /> DAY
            </button>
            <button
              onClick={() => sim.night || sim.toggleNight()}
              className={`font-sans text-[11px] font-semibold px-3 py-1.5 rounded-md transition flex items-center gap-1.5 ${
                sim.night ? 'bg-slate-900 text-amber-200 shadow-sm' : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              <Moon size={13} /> NIGHT
            </button>
          </div>
          <button
            onClick={() => sim.toggleEstop()}
            className={`font-sans text-xs font-bold px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition active:scale-95 shadow-sm ${
              sim.estop ? 'bg-signal text-white' : 'bg-white border border-signal/50 text-signal hover:bg-red-50'
            }`}
            title="Emergency Brake Interrupt — CAN 0x201"
          >
            {sim.estop ? <Power size={14} /> : <OctagonX size={14} />} E-STOP
          </button>
          <button onClick={() => sim.reset()} disabled={sim.locked} className={`tactical-btn !px-2.5 ${sim.locked ? 'opacity-40' : ''}`} title="Simulation Reset">
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {sim.estop && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden bg-signal text-white font-sans text-[11px] font-semibold text-center tracking-[0.22em]"
          >
            <p className="py-1.5">EMERGENCY BRAKE INTERRUPT — CAN 0x201 ENGAGED</p>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
