import {spawnSync} from 'node:child_process';
export function terminateOwnedProcess(child) {
  if(!child?.pid || child.exitCode!==null)return;
  if(process.platform==='win32') {
    // Only the exact process created by this runner and its descendants.
    spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false,timeout:5000});
  }else child.kill('SIGKILL');
}
