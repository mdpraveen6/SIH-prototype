import { motion } from 'framer-motion';
import { Camera, CheckCircle2, ScanLine, XCircle } from 'lucide-react';
import { useSimView } from '../sim/store';
import { CLEARANCE, STRADDLE_MAX, SURVEY_HOLD, TYRE_R } from '../sim/hazards';

const PHASES = ['project', 'measure', 'verdict'] as const;

export default function SurveyPanel() {
  const sim = useSimView();
  const sv = sim.survey;
  const fl = sim.surveyFlash && sim.simTime < sim.surveyFlash.until ? sim.surveyFlash : null;
  const approaching = !sv && sim.pitTargetId >= 0;

  const e = sv ? sim.simTime - sv.t0 : 0;
  const phaseIdx = !sv ? -1 : sv.phase === 'project' ? 0 : sv.phase === 'measure' ? 1 : 2;
  const progress = !sv ? 0 : Math.min(1, e / 3.0);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.15 }} className="glass p-4">
      <div className="flex items-center justify-between border-b border-hairline pb-2.5 mb-3">
        <h2 className="panel-title flex items-center gap-1.5"><ScanLine size={13} /> Pit survey · RGB-D</h2>
        <span className={`font-sans text-[11px] font-semibold ${sv ? 'text-pine-700' : fl ? (fl.pass ? 'text-pine-700' : 'text-signal') : 'text-stone-400'}`}>
          {sv ? `● ${sv.phase.toUpperCase()}` : fl ? (fl.pass ? '● PASS' : '● FAIL') : approaching ? '● APPROACH' : '○ IDLE'}
        </span>
      </div>

      {!sv && !fl && !approaching && (
        <p className="font-sans text-[11px] text-stone-500 leading-relaxed">
          No pit in the camera cone. Drop a <span className="font-semibold text-stone-700">Pit-S / Pit-L / Pothole</span> ahead —
          the UGV holds <span className="font-mono">{SURVEY_HOLD.toFixed(1)} m</span> out, projects a measuring grid, and decides straddle vs reroute.
          <span className="block mt-1 font-mono text-[10px] text-stone-400">tyre R {TYRE_R.toFixed(2)} m · belly {CLEARANCE.toFixed(2)} m · straddle &lt; {STRADDLE_MAX.toFixed(2)} m Ø</span>
        </p>
      )}

      {approaching && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 font-sans text-[11px] flex justify-between items-center">
          <span className="font-semibold text-stone-600 inline-flex items-center gap-1.5"><Camera size={12} /> Closing on pit</span>
          <span className="font-mono text-stone-800">{sim.pitApproachDist.toFixed(2)} m → hold {SURVEY_HOLD.toFixed(2)} m</span>
        </div>
      )}

      {sv && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            {PHASES.map((p, i) => (
              <div key={p} className="flex-1">
                <div className={`h-1.5 rounded-full ${i <= phaseIdx ? 'bg-cyan-500' : 'bg-stone-200'}`} />
                <div className={`font-sans text-[9px] font-semibold tracking-wide mt-1 ${i <= phaseIdx ? 'text-cyan-700' : 'text-stone-400'}`}>{p.toUpperCase()}</div>
              </div>
            ))}
          </div>
          <div className="h-1.5 rounded-full bg-stone-200 overflow-hidden">
            <div className="h-full rounded-full bg-cyan-500 transition-all duration-150" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="grid grid-cols-2 gap-1.5 font-sans text-[11px]">
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold tracking-wide text-stone-400">MEASURED Ø</div>
              <div className="font-mono font-bold text-stone-800">{sv.diaM.toFixed(2)} m</div>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold tracking-wide text-stone-400">MEASURED DEPTH</div>
              <div className="font-mono font-bold text-stone-800">{sv.depM.toFixed(2)} m</div>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold tracking-wide text-stone-400">BELLY MARGIN</div>
              <div className={`font-mono font-bold ${(CLEARANCE - sv.depM) >= 0 ? 'text-pine-700' : 'text-signal'}`}>{(CLEARANCE - sv.depM) >= 0 ? '+' : ''}{(CLEARANCE - sv.depM).toFixed(2)} m</div>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5">
              <div className="text-[9px] font-semibold tracking-wide text-stone-400">STRADDLE FIT</div>
              <div className={`font-mono font-bold ${sv.diaM < STRADDLE_MAX ? 'text-pine-700' : 'text-signal'}`}>{sv.diaM < STRADDLE_MAX ? 'FITS' : 'TOO WIDE'}</div>
            </div>
          </div>
        </div>
      )}

      {fl && (
        <div className={`mt-2.5 rounded-lg border px-2.5 py-2 flex items-center gap-2 ${fl.pass ? 'border-pine-700/30 bg-pine-50' : 'border-signal/40 bg-red-50'}`}>
          {fl.pass ? <CheckCircle2 size={15} className="text-pine-700 shrink-0" /> : <XCircle size={15} className="text-signal shrink-0" />}
          <div className={`font-sans text-[11px] font-bold leading-tight ${fl.pass ? 'text-pine-800' : 'text-signal'}`}>
            {fl.pass ? `PASSABLE · Ø${(fl.r * 2).toFixed(2)} m — straddle, crawling` : `IMPASSABLE · Ø${(fl.r * 2).toFixed(2)} m — rerouting wide`}
          </div>
        </div>
      )}
    </motion.div>
  );
}
