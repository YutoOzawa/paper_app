import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Stop,listFiles,fingerprint,writeJsonAtomic} from './policy.mjs';
import {candidateHash} from './project.mjs';

export function protectedHash(root) {
  return fingerprint(root,listFiles(root,['harness','tests/harness','docs']).filter(p=>!p.startsWith('docs/app/')));
}
export function runtimeDir(root) {
  const dir=path.join(root,'.harness');
  if(fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Stop('path','Linked runtime directory.');
  fs.mkdirSync(dir,{recursive:true});return dir;
}
export function acquireLock(root) {
  const file=path.join(runtimeDir(root),'run.lock');
  if(fs.existsSync(file)) {
    if(fs.lstatSync(file).isSymbolicLink())throw new Stop('path','Linked lock file.');
    let old;try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Stop('lock','Broken lock; inspect manually.');}
    if(!Number.isInteger(old.pid)||old.pid<1)throw new Stop('lock','Invalid lock.');
    let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw new Stop('lock','A runner is already active (or the saved PID is in use).');
    fs.unlinkSync(file);
  }
  const token=crypto.randomUUID();fs.writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx'});
  return ()=>{if(fs.existsSync(file) && JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file);};
}
export function newState(root) {
  return {version:1,id:crypto.randomUUID(),status:'running',phase:'implement',cycle:1,turns:0,elapsedMs:0,cleanPasses:0,stalled:0,lastFindings:null,findings:[],checks:null,reviews:{},candidate:candidateHash(root),protected:protectedHash(root),quota:null,reason:null,active:null,engineeringComplete:false,corpusReady:false,updatedAt:new Date().toISOString()};
}
export function loadState(root) {
  const file=path.join(runtimeDir(root),'state.json');
  if(!fs.existsSync(file))throw new Stop('state','No saved run. Use run first.');
  if(fs.lstatSync(file).isSymbolicLink())throw new Stop('path','Linked state.');
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  if(s.version!==1||!['implement','checks','code_review','ux_review','evaluate','done'].includes(s.phase)||!['running','paused','needs_human','needs_data','engineering_complete'].includes(s.status)||![s.cycle,s.turns,s.elapsedMs,s.cleanPasses,s.stalled].every(n=>Number.isFinite(n)&&n>=0)||s.cycle>6||s.turns>36||s.cleanPasses>2||!Array.isArray(s.findings)||!s.reviews)throw new Stop('state','Invalid checkpoint; do not overwrite it.');
  return s;
}
export function verifyResume(root,s) {
  if(s.protected!==protectedHash(root))throw new Stop('changed','Controller/specification changed after checkpoint; human review required.');
  if(s.candidate!==candidateHash(root))throw new Stop('changed','Application changed outside the saved checkpoint; human review required.');
  if(['needs_human','needs_data','engineering_complete'].includes(s.status))throw new Stop('terminal',`Saved status ${s.status}: review HANDOFF.md before starting a new development scope.`);
}
export function saveState(root,s) {
  s.updatedAt=new Date().toISOString();
  const runtime=runtimeDir(root);writeJsonAtomic(path.join(runtime,'state.json'),s);
  const next=s.status==='paused'?'利用枠・停止理由を確認して node harness/cli.mjs resume':s.status==='running'?'実行中。別のrunは起動しない。':'この停止理由と成果物をCodexに伝え、必要な次の工程を依頼する。';
  const message=`# Paper App 引き継ぎ\n\n状態: ${s.status}\n\n理由: ${s.reason||'実行中'}\n\n段階: ${s.phase} / サイクル ${s.cycle}/6 / 起動済みAIターン ${s.turns}/36\n\n候補: ${s.candidate}\n\n合格連続回数: ${s.cleanPasses}/2\n\n機能実装確認: ${s.engineeringComplete} / 実論文コーパス確認: ${s.corpusReady}\n\n最後の利用枠: ${s.quota?`残り ${s.quota.remaining}% (${s.quota.checkedAt})`:'未確認'}\n\n次の手順: ${next}\n\n未解決事項:\n\n${s.findings.map(f=>'- '+f).join('\n')||'- state.json の checks / reviews と docs/ACCEPTANCE.md を確認。'}\n\n状態・レビューは .harness/state.json、画面証拠は .harness/check-work/visual/ に保存。これらはGit対象外。自動公開・回復枠使用・追加課金は行わない。\n`;
  fs.writeFileSync(path.join(runtime,'HANDOFF.md'),message,'utf8');
}
export function evaluate(s,c) {
  const a=s.reviews.code_review,b=s.reviews.ux_review;
  if(!a||!b||a.candidate!==s.candidate||b.candidate!==s.candidate||!s.checks?.pass)throw new Stop('evidence','Reviews/checks are incomplete or stale.');
  const failures=[...a.keys,...b.keys,...a.report.unmetRequirements,...b.report.unmetRequirements];
  if([...a.report.findings,...b.report.findings].some(f=>f.severity==='P0'))throw new Stop('critical','P0 finding; human review required.');
  if(a.clean && b.clean) {
    s.cleanPasses++;s.stalled=0;s.findings=[];
    if(s.cleanPasses>=c.cleanPassesRequired){s.engineeringComplete=true;s.corpusReady=false;s.status='needs_data';s.reason='機能の検査・独立レビューが通過。実論文の取得と本番文章レビューは別工程。';s.phase='done';return;}
    s.phase='code_review';s.reviews={};return;
  }
  s.cleanPasses=0;
  // Stable requirement/file keys avoid treating reworded copies of the same issue as progress.
  const key=JSON.stringify([...new Set([...a.report.findings,...b.report.findings].filter(f=>f.severity!=='P3').map(f=>`${f.severity}|${f.requirement}|${f.file}`).concat(a.report.unmetRequirements,b.report.unmetRequirements))].sort());
  s.stalled=key===s.lastFindings?s.stalled+1:1;s.lastFindings=key;
  s.findings=failures.length?failures:['Review did not pass; inspect saved review evidence/readability.'];
  if(s.stalled>=c.maxRepeatedFindings)throw new Stop('stalled','同じ未解決事項が2サイクル継続。自動修正を停止。');
  if(s.cycle>=c.maxCycles)throw new Stop('cycle_limit','最大6サイクルに到達。');
  s.cycle++;s.phase='implement';s.reviews={};
}
