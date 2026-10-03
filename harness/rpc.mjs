import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {Stop} from './policy.mjs';
import {terminateOwnedProcess} from './process.mjs';
export const DISABLED_FEATURES=['apps','plugins','hooks','shell_tool','unified_exec','computer_use','browser_use','browser_use_external','in_app_browser','image_generation','view_image','multi_agent','code_mode','skill_search','skill_mcp_dependency_install','workspace_dependencies','memories','goals','unbounded_connection_retries'];
const ALLOWED_METHODS=new Set(['initialize','account/read','account/rateLimits/read','config/read','thread/start','turn/start','turn/interrupt']);
export function childEnvironment() {
  const env={};
  for(const [key,value] of Object.entries(process.env)) if(/^(PATH|PATHEXT|SystemRoot|WINDIR|ComSpec|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|CODEX_HOME)$/i.test(key))env[key]=value;
  return env;
}
export function serverArgs() {
  return ['app-server','--stdio','--enable','code_mode_host',...DISABLED_FEATURES.flatMap(f=>['--disable',f]),
    '-c','forced_login_method="chatgpt"','-c','model_provider="openai"','-c','web_search="disabled"',
    '-c','approval_policy="never"','-c','sandbox_mode="read-only"','-c','mcp_servers={}',
    '-c','service_tier="default"','-c','notify=[]'];
}
export class Rpc extends EventEmitter {
  constructor(root,{executable=process.env.PAPER_APP_CODEX_BIN || 'codex',spawnFn=spawn}={}) {
    super(); this.seq=0; this.pending=new Map(); this.buffer=''; this.closed=false; this.failure=null;
    this.child=spawnFn(executable,serverArgs(),{cwd:root,env:childEnvironment(),stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      if(this.buffer.length>16*1024*1024) return this.fail(new Stop('protocol','Oversized server response.'));
      let n;
      while((n=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,n); this.buffer=this.buffer.slice(n+1);
        if(!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch(e) { this.fail(new Stop('protocol',`Invalid server message: ${e.message}`)); }
      }
    });
    // Never print account/config/token values or raw server stderr.
    this.child.stderr.on('data',()=>{});
    this.child.on('error',e=>this.fail(new Stop('server',`Cannot start Codex: ${e.message}`)));
    this.child.on('exit',()=>{ if(!this.closed) this.fail(new Stop('server','Codex server exited unexpectedly.')); });
  }
  receive(message) {
    if(message.id!==undefined && !message.method) {
      const p=this.pending.get(message.id); if(!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      if(message.error) p.reject(new Stop('rpc',`RPC failed: ${p.method} (${message.error.code}): ${message.error.message}`));
      else p.resolve(message.result);
    } else if(message.method && message.id!==undefined) this.emit('request',message);
    else if(message.method) this.emit('notification',message);
  }
  send(message) { if(this.closed || this.failure) throw this.failure || new Stop('server','Server is closed.'); this.child.stdin.write(JSON.stringify(message)+'\n'); }
  request(method,params={},timeout=30000) {
    if(!ALLOWED_METHODS.has(method)) return Promise.reject(new Stop('policy',`RPC is forbidden: ${method}`));
    if(this.closed || this.failure) return Promise.reject(this.failure || new Stop('server','Server is closed.'));
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Stop('timeout',`Timed out: ${method}`));},timeout);
      this.pending.set(id,{resolve,reject,timer,method});
      try { this.send({id,method,params}); } catch(e) { clearTimeout(timer);this.pending.delete(id);reject(e); }
    });
  }
  response(id,result) { this.send({id,result}); }
  async initialize() {
    await this.request('initialize',{clientInfo:{name:'paper_app_harness',title:'Paper App bounded automation',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});
  }
  fail(error) {
    if(this.failure || this.closed) return;
    this.failure=error;
    for(const p of this.pending.values()) {clearTimeout(p.timer);p.reject(error);} this.pending.clear();
    this.emit('fault',error);
  }
  close() {
    if(this.closed) return; this.closed=true;
    for(const p of this.pending.values()) {clearTimeout(p.timer);p.reject(new Stop('closed','Server closed.'));}this.pending.clear();
    this.child.stdin.end();
    setTimeout(()=>terminateOwnedProcess(this.child),1500);
  }
}
