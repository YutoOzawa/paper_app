// Fixed controller-owned verifier. Run only inside the offline Codex sandbox.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {listFiles,safeFile} from './policy.mjs';
import {renderEvidence} from './visual.mjs';
const root=path.resolve(process.argv[2]);
const runtime=path.join(root,'.harness','check-work');
const result={pass:false,failures:[],checks:[],screenshots:[],corpusReady:false};
function check(name,ok,detail='') {result.checks.push({name,pass:!!ok,detail});if(!ok)result.failures.push(name+(detail?': '+detail:''));}
function command(name,args,timeout=30000,env=process.env) {return spawnSync(name,args,{cwd:runtime,env,encoding:'utf8',timeout,windowsHide:true,shell:false,maxBuffer:2*1024*1024});}
function walkAll(dir) {
  if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Symlink/junction in app');return e.isDirectory()?walkAll(p):[p];});
}
try {
  // Refuse to execute application test code if the sandbox can mutate its own controller.
  const probe=path.join(root,'harness','sandbox-write-probe.tmp');
  let outsideWritable=false;
  try {fs.writeFileSync(probe,'probe',{flag:'wx'});outsideWritable=true;fs.unlinkSync(probe);} catch(e) {if(!['EPERM','EACCES'].includes(e.code))throw e;}
  check('sandbox protects controller',!outsideWritable);
  if(outsideWritable) throw Error('Sandbox boundary failed; application tests were not executed.');
  const entry=path.join(root,'app','index.html');
  check('app entry exists',fs.existsSync(entry));
  const appFiles=walkAll(path.join(root,'app'));
  check('no PDF/raw media/credentials in app',!appFiles.some(p=>/\.(pdf|png|jpe?g|webp|mp4|zip|sqlite|db)$/i.test(p)||/[\\/](\.env|auth\.json|credentials\.json)/i.test(p)));
  const bytes=appFiles.reduce((n,p)=>n+fs.statSync(p).size,0);
  check('site stays below 700 MB safety budget',bytes<700*1000*1000,`${bytes} bytes`);
  for(const rel of listFiles(root,['app','tests/app','scripts/app']).filter(f=>/\.(mjs|js)$/.test(f))) {
    const r=command(process.execPath,['--check',safeFile(root,rel)]);
    check(`syntax ${rel}`,r.status===0,(r.stderr||'').slice(0,1500));
  }
  const testFiles=walkAll(path.join(root,'tests','app')).filter(p=>/\.test\.(mjs|js)$/.test(p));
  check('behavioral tests exist',testFiles.length>0);
  if(testFiles.length) {
    const temp=path.join(runtime,'test-temp');fs.mkdirSync(temp,{recursive:true});
    const readPaths=['app','tests/app','scripts/app','package.json'].map(p=>path.join(root,p)).filter(p=>fs.existsSync(p)).concat(temp);
    // Importing node:test suites directly avoids the CLI globber scanning parent
    // directories outside the read allowlist. node:test still sets failure exit codes.
    const imports=`for(const url of ${JSON.stringify(testFiles.map(p=>pathToFileURL(p).href))}) await import(url);`;
    const r=command(process.execPath,['--permission',...readPaths.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+temp,'--test-timeout=20000','--input-type=module','-e',imports],60000);
    check('behavioral tests',r.status===0,((r.stdout||'')+(r.stderr||'')).slice(-7000));
  }
  const manifestPath=path.join(root,'app','manifest.json');
  check('data manifest exists',fs.existsSync(manifestPath));
  if(fs.existsSync(manifestPath)) {
    const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const targetIds=['SIGCOMM','INFOCOM','MobiCom','CVPR','NeurIPS'];
    const rows=Array.isArray(m.conferences)?m.conferences:[];
    const validRows=rows.length>=5 && targetIds.every(id=>rows.some(c=>c.id===id && Number.isInteger(c.year) && c.formallyPublished===true && /^https:\/\//.test(c.officialIndexUrl||'') && c.expectedPapers>0 && c.expectedPapers===c.listedPapers && c.listedPapers===c.analyzedPapers+c.unavailablePapers));
    const dataFiles=Array.isArray(m.dataFiles)?m.dataFiles:[];
    let actualRecords=0;let dataValid=dataFiles.length>0;
    for(const rel of dataFiles) {
      const p=safeFile(root,'app/'+rel);const data=JSON.parse(fs.readFileSync(p,'utf8'));
      if(!Array.isArray(data)) {dataValid=false;continue;}
      actualRecords+=data.length;
      for(const paper of data) {
        if(!paper.id || !paper.title || !paper.landingUrl || paper.analysisStatus!=='complete' || paper.fixture===true) dataValid=false;
        if(paper.analysisStatus==='complete' && (!paper.summaryJa || !Array.isArray(paper.evidence)||!paper.evidence.length))dataValid=false;
      }
    }
    result.corpusAccountingReady=m.status==='complete' && validRows && rows.every(c=>c.unavailablePapers===0 && c.analyzedPapers===c.expectedPapers) && dataValid && actualRecords===rows.reduce((n,c)=>n+c.listedPapers,0);
    check('manifest completion is not falsely claimed',m.status==='sample'||(m.status==='complete'&&result.corpusAccountingReady));
    result.corpusNote='Real provenance and full-paper analysis need separate verification; basic accounting never establishes corpus completion.';
  }
  if(fs.existsSync(entry)) {
    const edgeCandidates=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
    const edge=edgeCandidates.find(p=>fs.existsSync(p));
    check('preinstalled Chrome or Edge available',!!edge);
    if(edge) {
      const visual=path.join(runtime,'visual');fs.mkdirSync(visual,{recursive:true});
      const browserHome=path.join(runtime,'browser-home');fs.mkdirSync(browserHome,{recursive:true});
      const browserEnv={...process.env,USERPROFILE:browserHome,HOME:browserHome,APPDATA:browserHome,LOCALAPPDATA:browserHome};
      result.screenshots=await renderEvidence({edge,entry,runtime,browserEnv});
      for(const shot of result.screenshots)check(`screenshot ${shot.id}`,true,`${shot.width}x${shot.height} verified viewport`);
    }
  }
  result.pass=result.failures.length===0;
} catch(e) {result.failures.push(e.message);}
fs.writeFileSync(path.join(runtime,'checks.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({pass:result.pass,failures:result.failures,screenshots:result.screenshots.length}));
