import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
export const REPOSITORY = 'https://github.com/YutoOzawa/paper_app.git';
export const MUTABLE_PREFIXES = ['app/', 'tests/app/', 'scripts/app/', 'docs/app/'];
export class Stop extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function validateConfig(c) {
  if (c.repository !== REPOSITORY) throw new Stop('policy', 'Repository must be YutoOzawa/paper_app.');
  for (const k of ['additionalSpendingAllowed','automaticResetRedemption','automaticPush','automaticDeployment','googleDriveEnabled']) {
    if (c[k] !== false) throw new Stop('policy', `${k} must remain false.`);
  }
  if (c.stopRemainingPercent !== 5 || c.startRemainingPercent < 10 || c.startRemainingPercent > 100)
    throw new Stop('policy', 'Stop at remaining 5%; start turns only above the 10% reserve.');
  for (const [k,min,max] of [['pollMilliseconds',1000,10000],['maxCycles',1,6],['maxRunMinutes',1,120],['maxTurnMinutes',1,20],['maxToolCallsPerTurn',1,100],['maxRepeatedFindings',1,2],['cleanPassesRequired',2,2]]) {
    if (!Number.isInteger(c[k]) || c[k] < min || c[k] > max) throw new Stop('policy', `Invalid bounded setting: ${k}`);
  }
  if (c.profile !== 'app-v1') throw new Stop('policy', 'Unknown acceptance profile.');
  return c;
}
export function checkAccount(r) {
  if (!r?.account || r.account.type !== 'chatgpt')
    throw new Stop('auth', 'ChatGPT login is required. API-key/provider billing is forbidden.');
  if (!r.account.planType || ['enterprise','business','team'].includes(r.account.planType))
    throw new Stop('auth', 'Only an identified personal included-usage plan is supported.');
}
export function quotaStatus(r) {
  if (r?.ordinaryUsageAllowed !== true) throw new Stop('quota_unknown', 'Included usage is not explicitly allowed.');
  const buckets = r.rateLimitsByLimitId && Object.keys(r.rateLimitsByLimitId).length ? Object.values(r.rateLimitsByLimitId) : [r.rateLimits];
  const windows = [];
  for (const b of buckets) {
    if (!b || b.rateLimitReachedType || b.spendControlReached === true) throw new Stop('quota', 'A quota or spending boundary is reached.');
    const credits = b.credits;
    if (!credits || credits.hasCredits !== false || credits.unlimited !== false || !['0',0].includes(credits.balance))
      throw new Stop('credits', 'Zero paid-credit balance must be confirmed; no credit fallback is permitted.');
    if (!b.primary) throw new Stop('quota_unknown', 'A primary usage window is unavailable.');
    for (const w of [b.primary,b.secondary].filter(Boolean)) {
      if (!Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)
        throw new Stop('quota_unknown', 'Invalid usage percentage.');
      windows.push({ bucket:b.limitId ?? 'codex', remaining:100-w.usedPercent, resetsAt:w.resetsAt ?? null });
    }
  }
  if (!windows.length) throw new Stop('quota_unknown', 'No usage windows.');
  return { remaining:Math.min(...windows.map(w=>w.remaining)), windows, checkedAt:new Date().toISOString() };
}
export function checkQuota(r, config, beforeTurn=false) {
  const q=quotaStatus(r);
  if (q.remaining <= config.stopRemainingPercent) throw new Stop('quota', `Remaining ${q.remaining}%. Saved; please restore usage manually.`);
  if (beforeTurn && q.remaining <= config.startRemainingPercent) throw new Stop('reserve', `Remaining ${q.remaining}%. A new turn is not started below the reserve.`);
  return q;
}
export function safeFile(root, relative, {write=false}={}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.isAbsolute(relative)) throw new Stop('path', 'Use a repository-relative forward-slash path.');
  const parts=relative.split('/');
  if (parts.some(p=>!p || p==='.' || p==='..' || p.startsWith('.') || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(p))) throw new Stop('path', 'Hidden, traversal, or device paths are forbidden.');
  if (write && !MUTABLE_PREFIXES.some(p=>relative.startsWith(p))) throw new Stop('path', 'The controller, instructions, configuration and Git metadata are protected.');
  if (!/\.(mjs|js|html|css|json|md|txt|svg)$/i.test(relative)) throw new Stop('path', 'Only application text files are permitted.');
  const full=path.resolve(root,...parts);
  if (!full.startsWith(path.resolve(root)+path.sep)) throw new Stop('path','Outside repository.');
  let current=path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new Stop('path','Linked root is forbidden.');
  for(const part of parts) {
    current=path.join(current,part);
    if(fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Stop('path','Links/junctions are forbidden.');
  }
  return full;
}
export function listFiles(root, prefixes=['app','tests/app','scripts/app','docs/app','docs','harness']) {
  const found=new Set();
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    if(fs.lstatSync(dir).isSymbolicLink()) throw new Stop('path','Links/junctions are forbidden.');
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(entry.name.startsWith('.') || entry.name==='node_modules') continue;
      const full=path.join(dir,entry.name);
      if(entry.isSymbolicLink()) throw new Stop('path','Links/junctions are forbidden.');
      if(entry.isDirectory()) walk(full);
      else { const rel=path.relative(root,full).split(path.sep).join('/'); if(/\.(mjs|js|html|css|json|md|txt|svg)$/i.test(rel)) found.add(rel); }
      if(found.size>50000) throw new Stop('capacity','Too many files.');
    }
  }
  for(const p of prefixes) walk(path.join(root,p));
  for(const p of ['AGENTS.md','README.md','package.json']) if(fs.existsSync(path.join(root,p))) found.add(p);
  return [...found].sort();
}
export function fingerprint(root, files) {
  const hash=crypto.createHash('sha256');
  for(const rel of [...files].sort()) { hash.update(rel+'\0'); hash.update(fs.readFileSync(safeFile(root,rel))); }
  return hash.digest('hex');
}
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(temp,file);
}
export function reviewKeys(review) { return review.findings.filter(f=>f.severity!=='P3').map(f=>`${f.severity}|${f.requirement}|${f.file}|${f.issue}`).sort(); }
export function validateReview(r) {
  if(!r || !['pass','changes_required'].includes(r.verdict) || !Array.isArray(r.findings) || !Array.isArray(r.evidence) || !r.readability || !Array.isArray(r.unmetRequirements)) throw new Stop('invalid_review','Incomplete review.');
  if(typeof r.summary!=='string'||!r.summary.trim()||![...r.evidence,...r.unmetRequirements].every(x=>typeof x==='string'&&x.trim()))throw new Stop('invalid_review','Review statements must be nonempty strings.');
  for(const key of ['clearJapanese','causalExplanation','englishMetadata','navigable','notMisleading']) if(typeof r.readability[key]!=='boolean') throw new Stop('invalid_review','Missing readability judgement.');
  for(const f of r.findings) if(!['P0','P1','P2','P3'].includes(f.severity) || ![f.requirement,f.file,f.issue,f.fix].every(x=>typeof x==='string'&&x.trim())) throw new Stop('invalid_review','Malformed finding.');
  const clean=r.verdict==='pass' && !r.unmetRequirements.length && !reviewKeys(r).length && Object.values(r.readability).every(v=>v===true) && r.evidence.length>0;
  return {clean, keys:reviewKeys(r)};
}
