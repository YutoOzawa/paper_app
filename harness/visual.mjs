import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export async function renderEvidence({edge,entry,runtime,browserEnv}) {
  const visual=path.join(runtime,'visual');fs.mkdirSync(visual,{recursive:true});
  const results=[];
  const cases=[['conferences-desktop',1440,1000,'#/conferences'],['papers-desktop',1440,1000,'#/conference/SIGCOMM/2025'],['detail-desktop',1440,1400,'#/paper/qa-paper'],['detail-mobile',390,1200,'#/paper/qa-paper']];
  for(const [id,width,height,route] of cases) {
    const url=pathToFileURL(entry);url.search='fixture=qa';url.hash=route.slice(1);
    // Fix the application viewport independently of the Windows minimum outer
    // window size. The screenshot clips only blank space outside this frame.
    const frame=path.join(runtime,id+'-frame.html');
    const src=url.href.replaceAll('&','&amp;').replaceAll('"','&quot;');
    fs.writeFileSync(frame,`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden}iframe{display:block;border:0;width:${width}px;height:${height}px}</style><iframe title="QA viewport ${width}x${height}" src="${src}"></iframe>`);
    const dest=path.join(visual,id+'.png');if(fs.existsSync(dest))fs.unlinkSync(dest);
    const run=spawnSync(edge,['--headless','--no-sandbox','--force-device-scale-factor=1','--hide-scrollbars','--disable-gpu','--no-first-run','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--disable-crash-reporter',`--user-data-dir=${path.join(runtime,'edge-profile',id)}`,`--crash-dumps-dir=${runtime}`,`--screenshot=${dest}`,`--window-size=${width},${height}`,'--virtual-time-budget=3000',pathToFileURL(frame).href],{cwd:runtime,env:browserEnv,encoding:'utf8',windowsHide:true,shell:false,timeout:20000,maxBuffer:1024*1024});
    if(!fs.existsSync(dest)||fs.statSync(dest).size<100)throw Error(`Screenshot ${id} failed: exit ${run.status}; ${(run.stderr||'').slice(0,1200)}`);
    results.push({id,path:'check-work/visual/'+id+'.png',width,height,viewport:'fixed-size isolated iframe'});
  }
  return results;
}
