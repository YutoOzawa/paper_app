import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {childEnvironment} from './rpc.mjs';
import {Stop} from './policy.mjs';
import {terminateOwnedProcess} from './process.mjs';
export function runChecks(root,{signal,timeout=180000}={}) {
  if(signal?.aborted)return Promise.reject(new Stop('interrupted','Checks cancelled before launch.'));
  const runtime=path.join(root,'.harness','check-work'); fs.mkdirSync(runtime,{recursive:true});
  const resultFile=path.join(runtime,'checks.json');
  if(fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  const executable=process.env.PAPER_APP_CODEX_BIN || 'codex';
  // Windows Codex requires root read; untrusted Node tests get an additional
  // Node permission boundary. Edge keeps its default file-origin protections.
  const entries={':root':'read',[runtime.replaceAll('\\','/')]: 'write'};
  const profile=`{ filesystem = { ${Object.entries(entries).map(([k,v])=>`${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }, network = { enabled = false } }`;
  const args=['sandbox','--permission-profile','paper_app_checks','--cd',runtime,'-c',`permissions.paper_app_checks=${profile}`,
    '--',process.execPath,path.join(root,'harness','check-worker.mjs'),root];
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,env:{...childEnvironment(),TEMP:runtime,TMP:runtime},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output=''; let settled=false;
    const collect=d=>{if(output.length<12000) output+=d.toString().slice(0,12000-output.length);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const stop=()=>terminateOwnedProcess(child); signal?.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(stop,timeout);
    child.on('error',e=>{ if(!settled){settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(new Stop('checks',e.message));} });
    child.on('exit',code=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);
      if(signal?.aborted)return reject(new Stop('interrupted','Checks interrupted.'));
      if(code!==0 || !fs.existsSync(resultFile)) return resolve({pass:false,failures:['Offline check sandbox failed or timed out.'],diagnostic:output.slice(-5000),screenshots:[]});
      try {resolve(JSON.parse(fs.readFileSync(resultFile,'utf8')));} catch {resolve({pass:false,failures:['Invalid check report.'],screenshots:[]});}
    });
  });
}
