import fs from 'node:fs';
import path from 'node:path';
import {Stop,checkQuota,quotaStatus} from './policy.mjs';
import {candidateHash} from './project.mjs';
import {protectedHash,saveState,evaluate,runtimeDir} from './state.mjs';

// Dependencies are injected here for deterministic offline tests, never via CLI.
export async function drive({root,state,config,rpc,overrides,agent,checks,log=console.log}) {
  const abort=new AbortController();let last=Date.now(),polling=false,stopping=null;
  const save=()=>{const now=Date.now();state.elapsedMs+=now-last;last=now;saveState(root,state);};
  const halt=e=>{if(stopping)return;stopping=e;abort.abort(e);};
  const onSignal=()=>halt(new Stop('manual','ユーザー操作で停止。'));
  const watch=async()=>{
    if(stopping)return;
    if(fs.existsSync(path.join(runtimeDir(root),'STOP')))return halt(new Stop('manual','停止ファイルを検知。'));
    if(state.elapsedMs+Date.now()-last>=config.maxRunMinutes*60000)return halt(new Stop('time_limit','累計実行時間上限に到達。'));
    if(polling)return;polling=true;
    try{const raw=await rpc.request('account/rateLimits/read',{},8000);state.quota=quotaStatus(raw);save();checkQuota(raw,config);}catch(e){halt(e);}finally{polling=false;}
  };
  const checked=async(agentSignal)=>{
    if(stopping)throw stopping;
    const before=candidateHash(root);
    const result=await checks(root,{signal:agentSignal?AbortSignal.any([abort.signal,agentSignal]):abort.signal});
    if(stopping)throw stopping;
    if(candidateHash(root)!==before||protectedHash(root)!==state.protected)throw new Stop('changed','Source changed during checks.');
    return {...result,candidate:before};
  };
  process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  const timer=setInterval(()=>void watch(),config.pollMilliseconds);
  state.status='running';state.reason=null;save();
  try {
    while(state.phase!=='done') {
      await watch();if(stopping)throw stopping;
      if(state.turns>=36||state.cycle>config.maxCycles)throw new Stop('cycle_limit','総試行回数上限に到達。');
      if(protectedHash(root)!==state.protected)throw new Stop('changed','Protected controller or specification was changed.');
      log(`サイクル ${state.cycle}/${config.maxCycles}: ${state.phase} / 残り ${state.quota?.remaining ?? '?'}%`);
      if(state.phase==='implement') {
        state.cleanPasses=0;state.reviews={};
        const out=await agent({rpc,root,role:'implement',state,config,overrides,runChecks:checked,save,signal:abort.signal});
        state.implementation=out.summary;state.candidate=candidateHash(root);state.phase='checks';
      } else if(state.phase==='checks') {
        state.checks=await checked();state.candidate=candidateHash(root);
        if(!state.checks.pass) {
          const key=JSON.stringify(state.checks.failures||[]);
          state.stalled=state.lastFindings===key?state.stalled+1:1;state.lastFindings=key;state.findings=state.checks.failures||['Checks failed.'];
          if(state.stalled>=config.maxRepeatedFindings)throw new Stop('stalled','同じ検査失敗が2サイクル継続。');
          if(state.cycle>=config.maxCycles)throw new Stop('cycle_limit','最大サイクル数に到達。');
          state.cycle++;state.phase='implement';
        }else state.phase='code_review';
      }else if(['code_review','ux_review'].includes(state.phase)) {
        if(state.checks?.candidate!==candidateHash(root))throw new Stop('evidence','Candidate differs from checked files.');
        const role=state.phase;
        state.reviews[role]=await agent({rpc,root,role,state,config,overrides,runChecks:checked,save,signal:abort.signal});
        state.phase=role==='code_review'?'ux_review':'evaluate';
      }else if(state.phase==='evaluate')evaluate(state,config);
      else throw new Stop('state','Invalid phase.');
      if(stopping)throw stopping;save();
    }
  }catch(e) {
    state.status=['quota','quota_unknown','reserve','manual','interrupted','auth','credits','server','rpc','turn','timeout'].includes(e.code)?'paused':'needs_human';
    state.reason=`${e.code||'error'}: ${e.message}`;
    // No inference is used to save a handoff at or after the quota boundary.
    state.candidate=candidateHash(root);state.active=null;save();
  }finally{clearInterval(timer);process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);save();}
  log(`停止状態: ${state.status}\n${state.reason||''}\n引き継ぎ: .harness/HANDOFF.md`);
  return state;
}
