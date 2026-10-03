// Explicit integration probe; not run automatically by the unit test glob.
// Creates only a temporary fictional fixture, never the actual application.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runChecks} from '../../harness/checks.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=path.join(repo,'.harness','runtime-probes');fs.mkdirSync(base,{recursive:true});
const root=fs.mkdtempSync(path.join(base,'case-'));
for(const dir of ['app','tests/app','harness'])fs.mkdirSync(path.join(root,dir),{recursive:true});
for(const file of ['check-worker.mjs','policy.mjs','visual.mjs'])fs.copyFileSync(path.join(repo,'harness',file),path.join(root,'harness',file));
fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
fs.writeFileSync(path.join(root,'app','manifest.json'),JSON.stringify({status:'sample',conferences:[],dataFiles:[]}));
fs.writeFileSync(path.join(root,'app','index.html'),'<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness QA only</title><style>body{font:22px sans-serif;padding:32px;background:#f4f7fb;color:#162032}</style><h1>Harness visual probe</h1><p>これは検査専用の架空画面です。アプリ本体ではありません。</p><script>const p=document.createElement("p");p.textContent="Viewport: "+innerWidth+" x "+innerHeight;document.body.append(p);</script></html>');
fs.writeFileSync(path.join(root,'tests/app','guard.test.mjs'),`
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('untrusted tests cannot read controller, mutate report, or spawn children',()=>{
  const runtime=process.cwd();
  assert.throws(()=>fs.readFileSync(path.join(runtime,'../../harness/policy.mjs')), {code:'ERR_ACCESS_DENIED'});
  assert.throws(()=>fs.writeFileSync(path.join(runtime,'checks.json'),'fake'), {code:'ERR_ACCESS_DENIED'});
  assert.throws(()=>spawnSync(process.execPath,['-e','process.exit(0)']), {code:'ERR_ACCESS_DENIED'});
  const p=path.join(runtime,'test-temp','roundtrip.json');fs.writeFileSync(p,'{"ok":true}');assert.equal(JSON.parse(fs.readFileSync(p)).ok,true);
});`);
const result=await runChecks(root);
console.log(JSON.stringify({fixture:root,...result},null,2));
assert.equal(result.pass,true);
assert.equal(result.screenshots.length,4);
