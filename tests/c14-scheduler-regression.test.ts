import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservedWorkloads, isDexServiceCommand, parseProcessTable } from '../src/shared/machine-capacity.js';
import { TaskEventLog } from '../src/shared/task-events.js';
import { taskStreamPage } from '../src/shared/task-stream.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const observe = (body: string) => classifyObservedWorkloads(parseProcessTable('PID PPID %CPU %MEM ELAPSED COMMAND\n'+body), {selfPid:9999});
test('misleading service/helper arguments never exempt an active compiler', () => {
 assert.equal(isDexServiceCommand('npm run build -- src/worker/main.ts'),false);
 assert.equal(observe('100 1 90 4 00:01:00 tsc --type=renderer\n').uncoordinatedHeavy,1);
});
test('a demanding desktop and its helpers consume one slot; unknown hot executables compete', () => {
 assert.equal(observe('100 1 1 5 00:01:00 /Applications/Claude.app/Contents/MacOS/Claude\n101 100 110 3 00:01:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer\n102 100 90 3 00:01:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process\n').uncoordinatedHeavy,1);
 assert.equal(observe('100 1 95 5 00:01:00 /usr/bin/python3 /tmp/unknown.py --name claude\n').uncoordinatedHeavy,1);
});
test('bounded retention preserves decisive transitions through noisy updates and explicitly reports missing detail', async () => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-retention-'));
 try { const log=new TaskEventLog(dir); const taskId='rtsk_123456789ab_1234567890abcdef';
 const accepted=await log.append({taskId,kind:'accepted',state:'ACCEPTED'});
 await log.append({taskId,kind:'transition',state:'PREPARING',toState:'PREPARING'});
 for(let i=0;i<2050;i++) await log.append({taskId,kind:'updated',state:'PREPARING',summary:'waiting'});
 await log.append({taskId,kind:'transition',state:'FAILED',toState:'FAILED'});
 const events=await log.list(taskId,2000,true);
 assert.equal(events[0]?.eventId,accepted.eventId); assert.equal(events.at(-1)?.state,'FAILED');
 assert.ok(events.length<=2000);
 assert.equal((await taskStreamPage(log,taskId,'fixture','FAILED')).gap,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('stale observations and a released exclusion lease cannot authorize a substantive job', async()=>{
 const {decideAdmission}=await import('../src/shared/work-coordinator.js');
 const snapshot={physicalMemoryBytes:8*1024**3,logicalCpuCount:8,loadAverage1m:0.5,memory:'healthy' as const,thermal:'healthy' as const,observed:{uncoordinatedHeavy:0,dexServices:0},sampledAtMs:Date.now()-3000};
 const state={leases:[],tickets:[],degraded:false,degradedReasons:[]};
 assert.equal(decideAdmission(state,snapshot,{access:'mutate',workload:'medium'}).admit,false);
 assert.equal(decideAdmission(state,{...snapshot,sampledAtMs:Date.now(),excludedLeaseIds:['released']},{access:'mutate',workload:'medium'}).admit,false);
 assert.equal(decideAdmission(state,snapshot,{access:'read',workload:'light'}).admit,true);
});
test('reused process at the lease creation boundary is never excluded with positive tolerance', async()=>{
 const {verifiedLeasePids}=await import('../src/shared/machine-capacity.js');
 const observedAt=Date.parse('2026-10-10T13:00:00Z');
 assert.deepEqual(verifiedLeasePids([{pid:100,ppid:1,cpu:90,mem:4,command:'npm build',elapsedSeconds:9}],[{pid:100,createdAt:'2026-10-10T12:59:50Z'}],observedAt),[]);
});

test('substantive mutation cannot use unknown memory, CPU saturation or thermal limiting as a fallback for unknown identities',async()=>{
 const {evaluateCapacity}=await import('../src/shared/machine-capacity.js');
 const host={physicalMemoryBytes:8*1024**3,logicalCpuCount:8,loadAverage1m:0.5,memory:'healthy' as const,thermal:'healthy' as const};
 const counts={activeSubstantive:0,activeHeavy:0,observedUncoordinatedHeavy:0};
 for(const unsafe of [{memory:'unknown'},{loadAverage1m:8},{thermal:'limited'},{loadAverage1m:null}] as const)
 assert.equal(evaluateCapacity({...host,...unsafe},counts,{workload:'medium',access:'mutate'}).canAdmit,false);
});


test('retention enforces the byte ceiling on historical oversized events and keeps corruption visible',async()=>{
 const {retainTaskEvents,TASK_EVENT_BYTE_LIMIT}=await import('../src/shared/task-events.js');
 const huge=Array.from({length:2001},(_,i)=>({eventId:`tev_${i.toString(16).padStart(24,'0')}`,taskId:`fixture-${i}`,kind:'transition' as const,state:'RUNNING' as const,at:'2026-10-10T12:00:00Z',summary:'x'.repeat(4096)}));
 const retained=retainTaskEvents(huge);
 assert.ok(Buffer.byteLength(retained.map(e=>JSON.stringify(e)).join('\n')+'\n')<=TASK_EVENT_BYTE_LIMIT);
 assert.ok(retained.length<=2000);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-event-corrupt-'));try{
 const log=new TaskEventLog(dir);await log.append({taskId:'fixture',kind:'accepted',state:'ACCEPTED'});
 await fs.appendFile(path.join(dir,'tasks','events.jsonl'),'{corrupt\n');
 await assert.rejects(log.append({taskId:'fixture',kind:'updated',state:'ACCEPTED'}));
 assert.match(await fs.readFile(path.join(dir,'tasks','events.jsonl'),'utf8'),/corrupt/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('duplicate historical event IDs fail closed rather than bypass the count ceiling or create ambiguous cursors',async()=>{
 const {retainTaskEvents,taskEventFile}=await import('../src/shared/task-events.js');
 const event={eventId:'duplicate',at:new Date().toISOString(),taskId:'fixture',kind:'accepted' as const};
 assert.throws(()=>retainTaskEvents(Array.from({length:2001},()=>event)),/duplicate event ID/);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-duplicate-history-'));
 try{
  await fs.mkdir(path.dirname(taskEventFile(dir)),{recursive:true});
  const raw=JSON.stringify(event)+'\n'+JSON.stringify(event)+'\n';
  await fs.writeFile(taskEventFile(dir),raw);
  const log=new TaskEventLog(dir);
  await assert.rejects(log.list('fixture',2000,true),/event history is corrupt/);
  await assert.rejects(log.append({taskId:'fixture',kind:'updated'}),/duplicate event ID/);
  assert.equal(await fs.readFile(taskEventFile(dir),'utf8'),raw);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('real tsx loader and launcher service entrypoints are recognized without trusting unrelated arguments',()=>{
 const services=[
  'node --require /fixture/node_modules/tsx/dist/preflight.cjs --import file:///fixture/node_modules/tsx/dist/loader.mjs src/gateway/main.ts',
  'node /fixture/node_modules/tsx/dist/cli.mjs src/gateway/main.ts'
 ];
 for(const command of services){assert.equal(isDexServiceCommand(command),true);assert.equal(observe(`100 1 50 4 00:01:00 ${command}\n`).uncoordinatedHeavy,0);}
 for(const command of [
  'node --require src/gateway/main.ts /fixture/build.js',
  'node --import src/gateway/main.ts /fixture/build.js',
  'node -e console.log(1) src/gateway/main.ts',
  'node /fixture/node_modules/tsx/dist/cli.mjs /fixture/build.ts --name src/gateway/main.ts'
 ])assert.equal(isDexServiceCommand(command),false);
});
