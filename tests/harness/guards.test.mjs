import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {checkQuota,validateConfig,quotaStatus,safeFile,validateReview} from '../../harness/policy.mjs';
import {createProjectTools,candidateHash} from '../../harness/project.mjs';
import {newState,evaluate,saveState,loadState,verifyResume,acquireLock} from '../../harness/state.mjs';
import {drive} from '../../harness/controller.mjs';
import {runAgent,preflight} from '../../harness/agent.mjs';
import {Rpc} from '../../harness/rpc.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const config=JSON.parse(fs.readFileSync(path.join(repo,'harness/config.json'),'utf8'));
const quota=(used=20)=>({ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:used},secondary:null,credits:{hasCredits:false,unlimited:false,balance:'0'}}}});
function fixture(){const base=path.join(repo,'.harness','unit-tests');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'case-'));fs.mkdirSync(path.join(dir,'app'));fs.mkdirSync(path.join(dir,'harness'));fs.writeFileSync(path.join(dir,'harness','config.json'),'{}');fs.writeFileSync(path.join(dir,'app','a.js'),'// initial');return dir;}
const report=()=>({verdict:'pass',summary:'Verified',findings:[],unmetRequirements:[],evidence:['Actual files/screens inspected'],readability:{clearJapanese:true,causalExplanation:true,englishMetadata:true,navigable:true,notMisleading:true}});
function reviewed(s,r=report()){return {...validateReview(r),report:r,candidate:s.candidate,threadId:'fresh-'+Math.random()};}
test('quota: exact 5%, any window/bucket, unknown and credit fallback fail closed',()=>{
  assert.equal(checkQuota(quota(94),config).remaining,6);
  assert.throws(()=>checkQuota(quota(95),config),/Remaining 5/);
  assert.throws(()=>checkQuota(quota(90),config,true),/reserve/);
  const q=quota();q.rateLimitsByLimitId.codex.secondary={usedPercent:96};assert.throws(()=>checkQuota(q,config));
  q.rateLimitsByLimitId.codex.secondary=null;q.rateLimitsByLimitId.other={...q.rateLimitsByLimitId.codex,primary:{usedPercent:100}};assert.throws(()=>checkQuota(q,config));
  for(const balance of ['',null,undefined,'1',1]){const r=quota();r.rateLimitsByLimitId.codex.credits.balance=balance;assert.throws(()=>quotaStatus(r));}
  assert.throws(()=>quotaStatus({}));assert.throws(()=>quotaStatus({...quota(),ordinaryUsageAllowed:false}));
});
test('configuration cannot enable spending or unbounded runs',()=>{
  assert.equal(validateConfig(config),config);
  for(const patch of [{additionalSpendingAllowed:true},{automaticResetRedemption:true},{maxCycles:7},{stopRemainingPercent:4},{cleanPassesRequired:1}])assert.throws(()=>validateConfig({...config,...patch}));
});
test('path traversal, hidden files, protected writes and links are denied',()=>{
  const root=fixture();
  for(const p of ['../secret.json','app/../../secret.json','C:/secret.json','app/.env','app/CON.js','app/foo.js:bar','app/x.pdf','harness/config.json'])assert.throws(()=>safeFile(root,p,{write:true}));
  assert.equal(safeFile(root,'app/good.js',{write:true}),path.join(root,'app','good.js'));
  const target=path.join(root,'app','linked');fs.symlinkSync(path.join(root,'harness'),target,'junction');assert.throws(()=>safeFile(root,'app/linked/config.json',{write:true}));
});
test('review role cannot write even if it requests a write tool',async()=>{
  const root=fixture(),api=createProjectTools(root,'code_review');
  await assert.rejects(api.call('project_write',{path:'app/a.js',content:'evil'}));
  assert.equal(fs.readFileSync(path.join(root,'app','a.js'),'utf8'),'// initial');
});
test('state survives disk round trip and external modification prevents resume',()=>{
  const root=fixture(),s=newState(root);s.status='paused';s.reason='quota';saveState(root,s);
  const loaded=loadState(root);verifyResume(root,loaded);assert.equal(loaded.reason,'quota');
  fs.writeFileSync(path.join(root,'app','a.js'),'// changed');assert.throws(()=>verifyResume(root,loaded),/changed outside/);
});
test('second concurrent runner is rejected',()=>{const root=fixture(),release=acquireLock(root);assert.throws(()=>acquireLock(root),/already active/);release();acquireLock(root)();});
test('success needs two independent paired reviews of same checked candidate',()=>{
  const root=fixture(),s=newState(root);s.checks={pass:true,candidate:s.candidate};s.reviews={code_review:reviewed(s),ux_review:reviewed(s)};
  evaluate(s,config);assert.equal(s.cleanPasses,1);assert.equal(s.engineeringComplete,false);
  s.reviews={code_review:reviewed(s),ux_review:reviewed(s)};evaluate(s,config);assert.equal(s.engineeringComplete,true);assert.equal(s.status,'needs_data');assert.equal(s.corpusReady,false);
});
test('repeated unresolved feedback is a stall, not convergence',()=>{
  const root=fixture(),s=newState(root);s.checks={pass:true};const r=report();r.verdict='changes_required';r.findings=[{severity:'P2',requirement:'C1',file:'app/a.js',issue:'broken',fix:'repair'}];
  s.reviews={code_review:reviewed(s,r),ux_review:reviewed(s)};evaluate(s,config);assert.equal(s.phase,'implement');
  r.findings[0].issue='same bug reworded';s.reviews={code_review:reviewed(s,r),ux_review:reviewed(s)};assert.throws(()=>evaluate(s,config),/2サイクル/);
});
test('stale or malformed positive reviews cannot pass',()=>{
  const root=fixture(),s=newState(root);s.checks={pass:true};s.reviews={code_review:reviewed(s),ux_review:reviewed(s)};s.reviews.code_review.candidate='other';assert.throws(()=>evaluate(s,config));
  assert.throws(()=>validateReview({verdict:'pass'}));const r=report();r.readability.notMisleading=false;assert.equal(validateReview(r).clean,false);
});
test('controller runs implement, checks, two fresh paired reviews and stops needs_data',async()=>{
  const root=fixture(),state=newState(root),roles=[];
  const agent=async({role,state})=>{roles.push(role);state.turns++;return role==='implement'?{summary:'done'}:reviewed(state);};
  await drive({root,state,config,rpc:{request:async()=>quota()},overrides:{},agent,checks:async()=>({pass:true,screenshots:[],corpusReady:true}),log:()=>{}});
  assert.deepEqual(roles,['implement','code_review','ux_review','code_review','ux_review']);assert.equal(state.status,'needs_data');assert.equal(loadState(root).cleanPasses,2);
});
test('quota or time exhausted before any work records a checkpoint',async()=>{
  for(const time of [false,true]){const root=fixture(),state=newState(root);if(time)state.elapsedMs=120*60000;
    await drive({root,state,config,rpc:{request:async()=>quota(95)},overrides:{},agent:async()=>{throw Error('must not run');},checks:async()=>{},log:()=>{}});
    assert.equal(state.turns,0);assert.equal(state.status,time?'needs_human':'paused');assert.ok(fs.existsSync(path.join(root,'.harness','HANDOFF.md')));
  }
});
test('failed checks stop at repeated failure without an infinite loop',async()=>{
  const root=fixture(),state=newState(root);let turns=0;
  await drive({root,state,config,rpc:{request:async()=>quota()},overrides:{},agent:async()=>{turns++;return {summary:'incomplete'};},checks:async()=>({pass:false,failures:['entry missing']}),log:()=>{}});
  assert.equal(turns,2);assert.equal(state.status,'needs_human');assert.match(state.reason,/stalled/);
});
test('reset/billing RPC methods are never sent',async()=>{
  let sent=false;const fake={closed:false,failure:null,send:()=>{sent=true;},pending:new Map()};
  await assert.rejects(Rpc.prototype.request.call(fake,'account/rateLimitResetCredit/consume',{}));assert.equal(sent,false);
});
test('active AI turn is interrupted when a fresh quota report reaches 5%',async()=>{
  const root=fixture(),state=newState(root);let reads=0,interrupted=false;
  class Fake extends EventEmitter {async request(method){if(method==='account/rateLimits/read')return quota(++reads>=2?95:20);if(method==='thread/start')return {thread:{id:'thread'}};if(method==='turn/start'){setTimeout(()=>this.emit('notification',{method:'account/rateLimits/updated',params:{}}),20);return {turn:{id:'turn'}};}if(method==='turn/interrupt'){interrupted=true;return {};}}}
  await assert.rejects(runAgent({rpc:new Fake(),root,role:'code_review',state,config,overrides:{},runChecks:async()=>{},save:()=>{},signal:new AbortController().signal,smoke:true}),/Remaining 5/);
  assert.equal(interrupted,true);
});
test('preflight saves the exact low quota before rejecting a new run',async()=>{
  let saved=null;
  const rpc={initialize:async()=>{},request:async method=>method==='account/read'?{account:{type:'chatgpt',planType:'plus'}}:quota(95)};
  await assert.rejects(preflight(rpc,config,{onQuota:q=>{saved=q;}}),/Remaining 5/);
  assert.equal(saved.remaining,5);
});
test('quota crossing observed only at turn completion is saved',async()=>{
  const root=fixture(),state=newState(root);let reads=0;
  class Fake extends EventEmitter {async request(method){
    if(method==='account/rateLimits/read')return quota(++reads===1?20:95);
    if(method==='thread/start')return {thread:{id:'thread'}};
    if(method==='turn/start'){setTimeout(()=>{this.emit('notification',{method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',text:'HARNESS_OK'}}});this.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});},20);return {turn:{id:'turn'}};}
  }}
  await assert.rejects(runAgent({rpc:new Fake(),root,role:'code_review',state,config,overrides:{},runChecks:async()=>{},save:()=>{},signal:new AbortController().signal,smoke:true}),/Remaining 5/);
  assert.equal(state.quota.remaining,5);
});
