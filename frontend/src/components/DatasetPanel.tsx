import { motion } from 'framer-motion';
import { Brain, CheckCircle2, Eye, MapPin } from 'lucide-react';
import { useSimView } from '../sim/store';

/** Self-supervised dataset: novel classes the UGV discovered while deployed. */
export default function DatasetPanel() {
  const sim = useSimView();
  const configuring = sim.locked && sim.deployActive;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.2 }} className="glass p-4">
      <div className="flex items-center justify-between border-b border-hairline pb-2.5 mb-3">
        <h2 className="panel-title flex items-center gap-1.5"><Brain size={13} /> Self-supervised dataset</h2>
        <span className={`font-sans text-[11px] font-semibold ${configuring ? 'text-pine-700' : sim.landResult ? 'text-pine-700' : 'text-stone-400'}`}>
          {configuring ? `● ${sim.deployOdom.toFixed(0)}/${sim.deployTarget.toFixed(0)}m` : sim.landResult ? '● MAPPED' : '○ IDLE'}
        </span>
      </div>

      {sim.landResult ? (
        <div className="rounded-lg border border-pine-700/30 bg-pine-50 px-2.5 py-2 mb-2.5">
          <div className="font-sans text-[10px] font-semibold tracking-wide text-pine-700 flex items-center gap-1"><MapPin size={11} /> {sim.deployActive ? 'LAND READ (LIVE)' : 'LAND CLASSIFIED · SET'}</div>
          <div className="font-sans text-[15px] font-bold text-pine-900 leading-tight">
            LAND {sim.deployActive ? '≈' : '='} {sim.landResult.label} <span className="font-mono text-[12px]">{sim.landResult.conf.toFixed(0)}%</span>
          </div>
          <div className="font-mono text-[10px] text-stone-500">runner-up {sim.landResult.runner} {sim.landResult.runnerConf.toFixed(0)}%</div>
        </div>
      ) : (
        <p className="font-sans text-[11px] text-stone-500 leading-relaxed mb-2.5">
          {configuring
            ? 'UGV is configuring the place — random 50 m traverse, learning unseen waste as it meets it.'
            : 'Press DEPLOY to lock the console, wander 50 m randomly, and grow this queue with whatever is new.'}
        </p>
      )}

      {sim.dataset.length === 0 && (
        <p className="font-mono text-[10px] text-stone-400">queue empty — no novel classes yet</p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {sim.dataset.map((d) => (
          <div key={d.code} className={`rounded-lg border px-2.5 py-2 min-w-0 ${d.promoted ? 'border-pine-700/30 bg-pine-50/60' : 'border-stone-200 bg-stone-50/70'}`}>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold text-stone-500">{d.code}</span>
              <span className="font-sans text-[12px] font-bold text-stone-800">{d.label}</span>
              {d.promoted
                ? <span className="ml-auto inline-flex items-center gap-1 font-sans text-[10px] font-bold text-pine-700"><CheckCircle2 size={11} /> KNOWN</span>
                : <span className="ml-auto inline-flex items-center gap-1 font-sans text-[10px] font-bold text-clay-700"><Eye size={11} /> NEW</span>}
            </div>
            <div className="flex justify-between font-mono text-[10px] text-stone-600 mt-1.5 mb-1">
              <span>views {d.views} · samples {d.samples}</span>
              <span className="font-bold">{d.conf.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-stone-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-200 ${d.promoted ? 'bg-pine-600' : 'bg-clay-600'}`}
                style={{ width: `${Math.min(100, d.conf)}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {[`Ø${(d.size * 2).toFixed(2)}m`, `${d.temp.toFixed(1)}°C`, `Δ${d.novelty.toFixed(2)}`, `T+${d.firstT.toFixed(0)}s`, `${d.firstX.toFixed(0)},${d.firstY.toFixed(0)}`].map((chip) => (
                <span key={chip} className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-white border border-stone-200 text-stone-500">{chip}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
