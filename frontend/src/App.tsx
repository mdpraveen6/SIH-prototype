import React, { Suspense } from 'react';
import Header from './components/Header';
import PerceptionStreams from './components/PerceptionStreams';
import ControlConsole from './components/ControlConsole';
import SensorPanel from './components/SensorPanel';
import { SimProvider } from './sim/store';

// Three.js is heavy — load the 3D viewport on demand for a fast first paint.
const SimulationCanvas = React.lazy(() => import('./components/SimulationCanvas'));
// Recharts is heavy — split it off the initial bundle.
const TelemetryPanel = React.lazy(() => import('./components/TelemetryPanel'));

const LEGEND: [string, string][] = [
  ['#1B5E43', 'Optimal MPPI path'],
  ['#227356', 'Sampled rollouts'],
  ['#DC2626', 'Layer-0 shield 0.8 m'],
  ['#B45309', 'Proximity alert 3.5 m']
];

export default function App() {
  return (
    <SimProvider>
      <div className="min-h-screen bg-paper text-stone-900 font-sans">
        <Header />
        <main className="p-4 grid gap-4 xl:grid-cols-[310px_minmax(0,1fr)_360px] lg:grid-cols-[290px_minmax(0,1fr)] grid-cols-1 max-w-[1720px] mx-auto">
          <div className="space-y-4 order-2 lg:order-1">
            <Suspense fallback={<div className="glass p-4 font-sans text-xs text-stone-500">Loading telemetry…</div>}>
              <TelemetryPanel />
            </Suspense>
          </div>
          <div className="space-y-4 order-1 lg:order-2 min-w-0">
            <Suspense fallback={<div className="glass p-8 font-sans text-xs text-stone-500 text-center">Loading 3D viewport…</div>}>
              <SimulationCanvas />
            </Suspense>
            <div className="glass px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
              {LEGEND.map(([c, label]) => (
                <span key={label} className="font-sans text-[11px] font-medium text-stone-600 inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded-sm" style={{ background: c }} />
                  {label}
                </span>
              ))}
              <span className="ml-auto hidden md:inline font-mono text-[10px] tracking-wider text-stone-400">
                CAN 0x201 ARMED · TF2 300ms COMPENSATED
              </span>
            </div>
            <ControlConsole />
          </div>
          <div className="space-y-4 order-3 lg:col-span-2 xl:col-span-1">
            <PerceptionStreams />
            <SensorPanel />
          </div>
        </main>
        <footer className="px-4 pb-5 font-sans text-[11px] text-stone-400 max-w-[1720px] mx-auto">
          SPARSH · Self-Supervised Perception and Autonomous Robust Safety Framework · Standalone simulation — no ROS 2 dependencies
        </footer>
      </div>
    </SimProvider>
  );
}
