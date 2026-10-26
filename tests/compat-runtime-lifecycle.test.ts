import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

test('compat search bounds simultaneous starts/results and closes real owned ripgrep children', async()=>{
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-compat-resource-')));
 try {
  const root=path.join(home,'root');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'large.txt'),Array.from({length:2500},(_,i)=>'needle '+i).join('\n'));
  await fs.mkdir(path.join(home,'.claude-server-commander'));
  await fs.writeFile(path.join(home,'.claude-server-commander/config.json'),JSON.stringify({allowedDirectories:[root],telemetryEnabled:false}));
  const source=`
import assert from 'node:assert/strict';
const {SearchManager}=await import('./src/node/compat-runtime/runtime/search-manager.js');
const {terminalManager}=await import('./src/node/compat-runtime/runtime/terminal-manager.js');
const manager=new SearchManager();
const attempts=await Promise.allSettled(Array.from({length:17},()=>manager.startSearch({
 rootPath:process.env.TEST_ROOT,pattern:'needle',searchType:'content',timeout:1000,maxResults:100000
})));
assert.equal(attempts.filter(a=>a.status==='rejected').length,1);
assert.match(String(attempts.find(a=>a.status==='rejected').reason),/limit/);
await new Promise(resolve=>setTimeout(resolve,100));
assert.equal(manager.sessions.size,16);
for(const session of manager.sessions.values()) {
 assert.ok(session.results.length<=1000);
 assert.ok(session.resultBytes<=4*1024*1024);
}
const session=[...manager.sessions.values()][0];
const before=session.results.length;
assert.equal(manager.appendResult(session,{file:'oversize',match:'x'.repeat(4*1024*1024)}),false);
assert.equal(session.results.length,before);
assert.equal(session.wasIncomplete,true);
const children=[...manager.sessions.values()].map(s=>s.process);
await manager.shutdown(1000);
assert.equal(manager.sessions.size,0);
await new Promise(resolve=>setTimeout(resolve,50));
for(const child of children)assert.ok(child.exitCode!==null||child.signalCode!==null,'owned search child must exit');
await assert.rejects(manager.startSearch({rootPath:process.env.TEST_ROOT,pattern:'x'}),/closing/);
const processAttempts=await Promise.allSettled(Array.from({length:17},()=>terminalManager.executeCommand('sleep 10',5)));
const started=processAttempts.filter(a=>a.status==='fulfilled'&&a.value.pid>0);
assert.equal(started.length,16);
assert.equal(terminalManager.sessions.size,16);
const processChildren=[...terminalManager.sessions.values()].map(s=>s.process);
await terminalManager.terminateAllSessions(1000);
for(const child of processChildren)assert.ok(child.exitCode!==null||child.signalCode!==null,'owned shell must exit');
await assert.rejects(terminalManager.executeCommand('sleep 10',5),/closing/);
console.log('PASS: concurrent search and process caps, byte budget, shutdown, post-shutdown refusal');
`;
  const result=await exec(process.execPath,['--input-type=module','-e',source],{
   cwd:process.cwd(),env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:home,TEST_ROOT:root},
   timeout:15000,maxBuffer:1024*1024});
  assert.match(result.stdout,/PASS:/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('compatibility runtime contains no telemetry transport or raw argument recorder',async()=>{
 const capture=await fs.readFile('src/node/compat-runtime/runtime/utils/capture.js','utf8');
 const tracker=await fs.readFile('src/node/compat-runtime/runtime/utils/trackTools.js','utf8');
 assert.doesNotMatch(capture,/https|fetch\(|request\(|setInterval/);
 assert.doesNotMatch(tracker,/JSON.stringify|appendFile|writeFile/);
 const server=await fs.readFile('src/node/compat-runtime/runtime/server.js','utf8');
 assert.match(server,/Object.hasOwn\(operations,name\)/);
});
