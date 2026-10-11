import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nativeProcess } from '../src/node/native.js';
import { NO_SECRETS } from '../src/shared/secrets.js';
import { activityFile, activityLockFile, readProcessActivities, recordProcessIntent, bindProcessIntent } from '../src/shared/activity.js';
import { withFileLock } from '../src/shared/state-io.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { reconcileBootTasks } from '../src/node/boot-recovery.js';
import { decideExistingTask } from '../src/shared/durable-execution.js';
async function fixture(fn: (root: string, work: string) => Promise<void>) {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-launch-'))), work = path.join(root, 'work'); await fs.mkdir(work);
 const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = path.join(root, 'state');
 try { await fn(root, work); } finally { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; await fs.rm(root, { recursive: true, force: true }); }
}
async function runningTask() { const store = new NodeTaskStore(); const t = await store.create({ actorId: 'test', nodeId: 'macbook-air.local', operation: 'dex.process.run', idempotencyKey: 'launch-test', payloadSha256: 'a'.repeat(64), safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' }); await store.transition(t.taskId, 'PREPARING'); return { store, task: await store.transition(t.taskId, 'RUNNING') }; }
test('real fast child sees committed bound launch evidence before creating its effect and retains exit 3', async () => fixture(async (_root, work) => {
 const { task } = await runningTask();
 await fs.writeFile(path.join(work, 'effect.mjs'), `import fs from 'node:fs';import path from 'node:path';const rows=JSON.parse(fs.readFileSync(path.join(process.env.DEX_REACH_STATE_DIR,'activity/processes.json'),'utf8'));if(!rows.some(r=>r.taskId==='${task.taskId}'&&r.attempt===1&&r.state==='running'&&r.pid>0&&r.identity))process.exit(99);fs.writeFileSync('effect','once');console.log('progress');process.exit(3);`);
 const result = await nativeProcess(`${process.execPath} effect.mjs`, work, 'full-local', 5000, [work], NO_SECRETS, { taskId: task.taskId, attempt: 1 });
 assert.equal(result.exitCode, 3); assert.match(String(result.stdout), /progress/); assert.equal(await fs.readFile(path.join(work, 'effect'), 'utf8'), 'once');
 const [row] = await readProcessActivities({ includeFinished: true }); assert.equal(row!.exitCode, 3); assert.ok(row!.lastStdoutAt); assert.equal(row!.taskId, task.taskId);
}));
test('activity lock contention fences the side effect until its evidence can commit', async () => fixture(async (_root, work) => {
 let release!: () => void, ready!: () => void; const held = new Promise<void>(r => { release = r; }), fenced = new Promise<void>(r => { ready = r; });
 const holder = withFileLock(activityLockFile(), async () => { ready(); await held; }); await fenced;
 const run = nativeProcess('printf once > effect', work, 'full-local', 5000, [work]);
 await new Promise(r => setTimeout(r, 200)); await assert.rejects(fs.access(path.join(work, 'effect')));
 release(); await holder; assert.equal((await run).exitCode, 0); assert.equal(await fs.readFile(path.join(work, 'effect'), 'utf8'), 'once');
}));
test('intent persistence failure prevents spawn and does not complete execution', async () => fixture(async (_root, work) => {
 await fs.mkdir(path.dirname(activityFile()), { recursive: true }); await fs.writeFile(activityFile(), '{');
 await assert.rejects(nativeProcess('printf once > effect', work, 'full-local', 5000, [work]), /JSON|Unexpected|Expected/);
 await assert.rejects(fs.access(path.join(work, 'effect')));
}));
for (const phase of ['intent', 'binding']) test(`crash at ${phase} preserves uncertainty, task binding and no replay`, { timeout: 20000 }, async () => fixture(async (_root, work) => {
 const { store, task } = await runningTask();
 // Fault injection at the real atomic persistence boundary; no production hook or alternate executor.
 const script = `import fs from 'node:fs/promises';import {nativeProcess} from './src/node/native.ts';import {activityFile,processIntentFile} from './src/shared/activity.ts';const rename=fs.rename;fs.rename=async(a,b)=>{if(b===${phase === 'intent' ? 'processIntentFile()' : 'activityFile()'}){const doc=JSON.parse(await fs.readFile(a,'utf8'));const rows=Array.isArray(doc)?doc:doc.records;const state=rows.at(-1)?.state;if(state==='${phase === 'intent' ? 'starting' : 'running'}'){${phase === 'intent' ? 'await rename(a,b);' : ''}console.log('PAUSED');await new Promise(()=>{});}}return rename(a,b);};await nativeProcess('printf once > effect',process.env.WORK,'full-local',10000,[process.env.WORK],undefined,{taskId:'${task.taskId}',attempt:1});`;
 const child = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',script], { env: { ...process.env, WORK: work }, stdio: ['ignore','pipe','pipe'] });
 let err = ''; child.stderr.on('data', d => { err += d; });
 try {
  await new Promise<void>((resolve,reject) => { child.stdout.on('data', d => { if(String(d).includes('PAUSED')) resolve(); }); child.once('exit', () => reject(new Error(err || 'exited before fault boundary'))); });
  child.kill('SIGKILL'); await new Promise(r => child.once('exit', r));
  await assert.rejects(fs.access(path.join(work, 'effect')));
  const [row] = await readProcessActivities({ includeFinished: true }); assert.equal(row!.state,'starting'); assert.equal(row!.pid,0);
  const reports = await reconcileBootTasks(store,new ResultStore(),{activities:[row!],coordinator:null,transportConnected:false}); assert.equal(reports[0]!.decision.kind,'DEGRADED');
  const recovered = (await store.read(task.taskId))!; assert.equal(recovered.state,'AMBIGUOUS');
  assert.equal(decideExistingTask({existing:recovered,actorId:'test',nodeId:'macbook-air.local',operation:'dex.process.run',payloadSha256:'a'.repeat(64),policyHash:recovered.policyHash ?? 'unknown-policy'}).kind,'REFUSE_AMBIGUOUS');
 } finally { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); }
}));
test('PID identity cannot be rebound and a missing process identity refuses binding', async () => fixture(async () => {
 const row=await recordProcessIntent({kind:'native-process',operation:'dex.process.run',command:'private --token secret'});
 await assert.rejects(bindProcessIntent(row.id,2147483647),/UNVERIFIABLE/);
 await bindProcessIntent(row.id,process.pid); await assert.rejects(bindProcessIntent(row.id,process.pid),/NOT_BINDABLE/);
 assert.doesNotMatch(await fs.readFile(activityFile(),'utf8'),/--token|secret/);
}));
test('C13 activity reader accepts the legacy ledger while a new unbound intent stays separate', async () => fixture(async (root) => {
 const { execFileSync } = await import('node:child_process'); const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
 const source = execFileSync('git',['show','87a99494ebb3471d3ecc3a79acd630ec18858a92:src/shared/activity.ts'],{encoding:'utf8'});
 const compiled = transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/from '(\.\/[^']+)\.js'/g,(_all,relative:string)=>`from '${path.resolve('src/shared',relative+'.ts')}'`);
 const file=path.join(root,'retained-activity.mjs'); await fs.writeFile(file,compiled);
 await recordProcessIntent({kind:'native-process',operation:'dex.process.run',command:'test'});
 const retained = await import(file);
 assert.deepEqual(await retained.listProcessActivities({includeFinished:true}),[]);
 assert.equal((await readProcessActivities())[0]!.state,'starting');
}));
test('active launch intents cannot be evicted by a full ledger', async () => fixture(async () => {
 const {processIntentFile}=await import('../src/shared/activity.js');
 const intent=await recordProcessIntent({kind:'native-process',operation:'dex.process.run',command:'test'});
 const records=Array.from({length:200},(_,i)=>({...intent,id:`activity-full-${i}`}));
 await fs.writeFile(processIntentFile(),JSON.stringify({version:1,records}));const before=await fs.readFile(processIntentFile(),'utf8');
 await assert.rejects(recordProcessIntent({kind:'native-process',operation:'dex.process.run',command:'test'}),/CAPACITY/);
 assert.equal(await fs.readFile(processIntentFile(),'utf8'),before);
}));
test('terminal evidence failure cannot resolve as successful execution', async () => fixture(async (_root, work) => {
 const script=`import fs from 'node:fs/promises';import{nativeProcess}from'./src/node/native.ts';import{activityFile}from'./src/shared/activity.ts';const rename=fs.rename;fs.rename=async(a,b)=>{if(b===activityFile()){const rows=JSON.parse(await fs.readFile(a,'utf8'));if(rows.some(r=>r.state==='completed'))throw new Error('fault');}return rename(a,b);};try{await nativeProcess('printf once > effect',process.env.WORK,'full-local',5000,[process.env.WORK]);process.exitCode=99;}catch(e){console.log(e.name+' '+e.message);}`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...process.env,WORK:work},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>{output+=d;});let err='';child.stderr.on('data',d=>{err+=d;});
 assert.equal(await new Promise(r=>child.once('exit',r)),0,err);assert.match(output,/uncertain/);assert.equal(await fs.readFile(path.join(work,'effect'),'utf8'),'once');
}));
