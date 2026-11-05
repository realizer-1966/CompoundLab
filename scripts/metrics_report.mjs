import { expandRecorded } from '../web/pipeline.js';
import { evaluate, auroc, bestCutoff, percentile, coverageTable } from '../web/metrics.js';
import fs from 'node:fs';

const c = JSON.parse(fs.readFileSync('web/corpus.json', 'utf8'));
const rec = JSON.parse(fs.readFileSync('web/recorded.json', 'utf8'));
const ex = expandRecorded(rec, c);

for (const [k, run] of Object.entries(ex.runs)) {
  const rs = run.records;
  const m0 = evaluate(rs, { cutoff: 0.5, threshold: 0 });
  const ev = rs.filter(r => r.evidenceHit !== null).length;
  const hit = rs.filter(r => r.evidenceHit).length;
  const kept0 = rs.filter(r => r.confidence >= 0.1);
  const keptAcc = kept0.length ? evaluate(kept0, { cutoff: 0.5, threshold: 0 }).accuracy : null;
  const ms = rs.map(r => r.layaMs);
  const kindAcc = {};
  for (const kind of new Set(rs.map(r => r.kind))) {
    const sub = rs.filter(r => r.kind === kind);
    kindAcc[kind] = evaluate(sub, { cutoff: 0.5, threshold: 0 }).accuracy;
  }
  console.log(`== ${k}`);
  console.log(' acc', m0.accuracy.toFixed(3), 'bal', m0.balancedAccuracy.toFixed(3), 'fvr', m0.falseVerificationRate.toFixed(3),
    'auroc', auroc(rs).toFixed(3), 'recall@3', (hit / ev).toFixed(3));
  console.log(' thr>=0.1: cov', (kept0.length / rs.length).toFixed(2), 'keptAcc', keptAcc && keptAcc.toFixed(3));
  console.log(' ms median', percentile(ms, 0.5).toFixed(0), 'p95', percentile(ms, 0.95).toFixed(0));
  console.log(' bestCutoff bal', bestCutoff(rs).balancedAccuracy?.toFixed?.(3));
  console.log(' kinds', JSON.stringify(Object.fromEntries(Object.entries(kindAcc).map(([k2, v]) => [k2, +v.toFixed(2)]))));
  console.log(' covTable(0.5):', coverageTable(rs, 0.5, [0, 0.05, 0.1, 0.2, 0.3]).map(x => `conf${x.min}: cov=${x.coverage} acc=${x.accuracy}`).join(' | '));
}
