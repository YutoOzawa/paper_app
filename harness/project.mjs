import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {safeFile,listFiles,fingerprint,Stop,REPOSITORY} from './policy.mjs';
export function verifyRepository(root) {
  if(fs.lstatSync(root).isSymbolicLink() || !fs.existsSync(path.join(root,'.git')) || !fs.lstatSync(path.join(root,'.git')).isDirectory() || fs.lstatSync(path.join(root,'.git')).isSymbolicLink()) throw new Stop('repository','A standalone project checkout is required.');
  const r=spawnSync('git',['remote','get-url','--all','origin'],{cwd:root,encoding:'utf8',windowsHide:true,shell:false});
  if(r.status!==0 || r.stdout.trim()!==REPOSITORY) throw new Stop('repository','Origin must be exactly https://github.com/YutoOzawa/paper_app.git');
  const p=spawnSync('git',['remote','get-url','--push','--all','origin'],{cwd:root,encoding:'utf8',windowsHide:true,shell:false});
  if(p.status!==0 || p.stdout.trim()!==REPOSITORY) throw new Stop('repository','Unexpected push URL.');
  const top=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',windowsHide:true,shell:false});
  if(top.status!==0 || path.resolve(top.stdout.trim()).toLowerCase()!==path.resolve(root).toLowerCase()) throw new Stop('repository','Repository root mismatch.');
}
export const objectSchema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string={type:'string'};
export const PROJECT_TOOLS=[
  {type:'function',name:'project_list',description:'List project text files. The only files you can modify are app/, tests/app/, scripts/app/, docs/app/. No shell, network, package install, Git mutation or spending tools exist.',inputSchema:objectSchema({})},
  {type:'function',name:'project_read',description:'Read one UTF-8 project file. Repository-relative forward slash path only. Secrets and hidden files cannot be read.',inputSchema:objectSchema({path:string})},
  {type:'function',name:'project_write',description:'Implementation role only: replace a UTF-8 application text file under the writable app directories. No instructions, controller, root package or Git changes. Write small checkpoints frequently.',inputSchema:objectSchema({path:string,content:string})},
  {type:'function',name:'project_checks',description:'Run the fixed offline validation and visual evidence command in a Codex sandbox. No arbitrary command argument. Results include screenshots for review.',inputSchema:objectSchema({})},
  {type:'function',name:'view_evidence',description:'View a screenshot from the latest check result. Use the exact evidence ID returned by project_checks or the turn prompt.',inputSchema:objectSchema({id:string})}
];
export function createProjectTools(root,role,{runChecks,onWrite=()=>{},screenshots=[]}={}) {
  let calls=0; const viewed=new Set(); let latestScreenshots=screenshots;
  return { viewed, async call(name,args) {
    if(++calls>100) throw new Stop('tool_limit','Turn tool-call limit reached.');
    if(!args || typeof args!=='object' || Array.isArray(args)) throw new Stop('tool','Invalid tool arguments.');
    if(name==='project_list') return {files:listFiles(root)};
    if(name==='project_read') {
      const p=safeFile(root,args.path); const stat=fs.statSync(p);
      if(stat.size>1024*1024) throw new Stop('capacity','File exceeds 1 MiB. Split data by conference/year.');
      return {path:args.path,content:fs.readFileSync(p,'utf8')};
    }
    if(name==='project_write') {
      if(role!=='implement') throw new Stop('review_write','Review roles cannot write files.');
      if(typeof args.content!=='string' || Buffer.byteLength(args.content)>1024*1024) throw new Stop('capacity','Invalid or oversized text content.');
      const p=safeFile(root,args.path,{write:true});
      fs.mkdirSync(path.dirname(p),{recursive:true});
      // Recheck after mkdir before the atomic replace.
      safeFile(root,args.path,{write:true});
      const tmp=p+'.'+crypto.randomUUID()+'.harness-tmp'; fs.writeFileSync(tmp,args.content,{encoding:'utf8',flag:'wx'});fs.renameSync(tmp,p);
      onWrite(args.path); return {saved:args.path};
    }
    if(name==='project_checks') { const result=await runChecks();latestScreenshots=result.screenshots||[];return result; }
    if(name==='view_evidence') {
      const found=latestScreenshots.find(x=>x.id===args.id);
      if(!found) throw new Stop('evidence','No such screenshot from the current candidate.');
      const full=path.resolve(root,'.harness',found.path);
      const base=path.resolve(root,'.harness','check-work','visual')+path.sep;
      if(!full.startsWith(base) || !fs.existsSync(full) || fs.lstatSync(full).isSymbolicLink()) throw new Stop('evidence','Invalid screenshot.');
      const bytes=fs.readFileSync(full);
      if(bytes.length>8*1024*1024 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Stop('evidence','Invalid PNG.');
      viewed.add(found.id);
      return {imageUrl:'data:image/png;base64,'+bytes.toString('base64')};
    }
    throw new Stop('tool',`Unsupported tool: ${name}`);
  }};
}
export function candidateHash(root) { return fingerprint(root,listFiles(root,['app','tests/app','scripts/app','docs/app']).filter(p=>p!=='AGENTS.md'&&p!=='README.md'&&p!=='package.json')); }
