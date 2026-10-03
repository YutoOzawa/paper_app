import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Stop,validateConfig} from './policy.mjs';
import {Rpc} from './rpc.mjs';
import {verifyRepository} from './project.mjs';
import {acquireLock,newState,loadState,verifyResume,saveState,runtimeDir} from './state.mjs';
import {preflight,runAgent} from './agent.mjs';
import {drive} from './controller.mjs';
import {runChecks} from './checks.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const action=process.argv[2]||'status';let rpc=null,release=null,state=null;
try {
  if(!['doctor','run','resume','status','stop','smoke'].includes(action)||process.argv.length>3)throw new Stop('command','Commands: doctor | run | resume | status | stop | smoke');
  verifyRepository(root);
  const config=validateConfig(JSON.parse(fs.readFileSync(path.join(root,'harness','config.json'),'utf8')));
  const runtime=runtimeDir(root);
  if(action==='status') {
    if(!fs.existsSync(path.join(runtime,'state.json')))console.log('未実行。doctor で確認後、run で開始できます。');
    else {const s=loadState(root);console.log(JSON.stringify({status:s.status,phase:s.phase,cycle:s.cycle,cleanPasses:s.cleanPasses,reason:s.reason,quota:s.quota,engineeringComplete:s.engineeringComplete,corpusReady:s.corpusReady},null,2));}
  }else if(action==='stop') {
    fs.writeFileSync(path.join(runtime,'STOP'),'User requested stop\n',{flag:'w'});console.log('停止を要求しました。実行中なら次の監視時に中断・保存します。');
  }else {
    release=acquireLock(root);
    if(action==='run') {
      if(fs.existsSync(path.join(runtime,'state.json')))throw new Stop('state','Saved run exists. Use resume; never overwrite progress.');
      state=newState(root);saveState(root,state);
    }
    if(action==='resume'){state=loadState(root);verifyResume(root,state);state.active=null;}
    if(['run','resume'].includes(action)&&fs.existsSync(path.join(runtime,'STOP')))fs.unlinkSync(path.join(runtime,'STOP'));
    rpc=new Rpc(root);const {quota,overrides}=await preflight(rpc,config,{onQuota:q=>{if(state){state.quota=q;saveState(root,state);}}});
    console.log(`ChatGPT認証・追加クレジット0を確認。残り ${quota.remaining}%。回復操作は行いません。`);
    if(action==='doctor') {
      const report=await runChecks(root);
      const guard=report.checks?.find(c=>c.name==='sandbox protects controller');
      if(!guard?.pass)throw new Stop('sandbox',report.diagnostic||report.failures.join('\n'));
      console.log('制限環境の起動確認: OK。アプリ未作成時の検査失敗は正常です。');
      console.log('追加の実AI疎通確認は smoke。開発開始は run。');
    }else if(action==='smoke') {
      const s=newState(root);s.quota=quota;
      const result=await runAgent({rpc,root,role:'code_review',state:s,config,overrides,runChecks:()=>runChecks(root),save:()=>{},signal:new AbortController().signal,smoke:true});
      console.log(JSON.stringify({liveToolSmoke:result.ok,toolCalls:result.calls}));
    }else {
      state.quota=quota;
      await drive({root,state,config,rpc,overrides,agent:runAgent,checks:runChecks});
      if(state.status!=='engineering_complete')process.exitCode=state.status==='needs_data'?0:2;
    }
  }
}catch(e){
  if(state && !['needs_human','needs_data','engineering_complete'].includes(state.status)){state.status='paused';state.reason=`${e.code||'error'}: ${e.message}`;saveState(root,state);}
  console.error(`停止: ${e.code||'error'}: ${e.message}`);process.exitCode=2;
}
finally{rpc?.close();release?.();}
