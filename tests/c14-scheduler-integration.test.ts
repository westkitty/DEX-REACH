import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { NodeRegistry } from '../src/gateway/registry.js';
import { createCoordinatorHandler, handleCoordinatorSocket } from '../src/coordinator/main.js';
import { acquireWork, releaseWork, coordinatorSocketPath, readCoordinatorState, type CapacitySnapshot } from '../src/shared/work-coordinator.js';
import { classifyObservedWorkloads, parseProcessTable } from '../src/shared/machine-capacity.js';
import { createGrant, loadAccessState, updateAccessState } from '../src/shared/access.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { listProcessActivities } from '../src/shared/activity.js';
import { TaskEventLog } from '../src/shared/task-events.js';
const actor={kind:'other' as const,clientId:'scheduler-fixture',clientName:'fixture'};
const repo=path.resolve(import.meta.dirname,'..');
async function until(fn:()=>Promise<boolean>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('fixture condition timed out');}
// The gateway reserves half of a request's transport budget for node refusal, persistence and the return trip
// (src/shared/request-deadlines.ts). At 2000 ms that reserve is 1000 ms, which a loaded or shared CI runner can
// exceed, so steps whose property is "a definitive refusal or success arrives before its enclosing transport"
// use a budget with a realistic reserve. Steps that need a short transport on purpose keep it explicitly.
const TRANSPORT_MS=6000;
const SHORT_TRANSPORT_MS=2000;
// Node start-up (tsx load, boot recovery, registration) is process boot, not a contract. The poll returns as soon as it is ready.
const READY_MS=60_000;
type Exit={code:number|null;signal:NodeJS.Signals|null};
// Resolves immediately when the child already ended, by exit code or by signal. Waiting only for 'exit' after a signal death would hang.
function exited(child:ChildProcess):Promise<Exit>{if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve({code:child.exitCode,signal:child.signalCode as NodeJS.Signals|null});return new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));}
// Graceful stop: SIGTERM to the whole process group, as a service manager stops a service. The node runs its shutdown path and the in-flight shell child receives the same signal.
async function stopGraceful(child:ChildProcess):Promise<Exit>{const done=exited(child);try{process.kill(-child.pid!,'SIGTERM');}catch{}return done;}
// Crash: SIGKILL to the node process only. No shutdown path runs and the in-flight shell child is not signalled.
async function crashNodeOnly(child:ChildProcess):Promise<Exit>{const done=exited(child);child.kill('SIGKILL');return done;}
test('real registry, node and coordinator: capacity/refusal, durable queue, authority, disconnect and restart', {timeout:180000},async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-scheduler-e2e-')));
 const stateDir=path.join(dir,'state');await fs.mkdir(stateDir);
 const previous=process.env.DEX_REACH_STATE_DIR;process.env.DEX_REACH_STATE_DIR=stateDir;
 const roots=path.join(dir,'roots');await fs.mkdir(roots);
 const auth=new NodeAuthStore(stateDir);await auth.initialize();const token=await auth.enroll('scheduler-fixture');
 const registry=new NodeRegistry(auth,stateDir);await registry.initialize();const server=http.createServer();registry.attach(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;
 let table='100 1 0.1 5 00:10:00 /Applications/Claude.app/Contents/MacOS/Claude\n';
 let memory:CapacitySnapshot['memory']='healthy';let samples=0;let stallMs=0;
 const sample=async():Promise<CapacitySnapshot>=>{samples++;return {physicalMemoryBytes:8*1024**3,logicalCpuCount:8,loadAverage1m:0.5,memory,thermal:'healthy',observed:classifyObservedWorkloads(parseProcessTable('PID PPID %CPU %MEM ELAPSED COMMAND\n'+table),{selfPid:9999})};};
 const handler=createCoordinatorHandler(sample);
 const admissionHandler:typeof handler=async request=>{
  if(request.command==='acquire' && stallMs){const wait=stallMs;stallMs=0;await new Promise(r=>setTimeout(r,wait));}
  return handler(request);
 };
 const coordinator=net.createServer(socket=>handleCoordinatorSocket(socket,admissionHandler));
 const socketPath=coordinatorSocketPath();await new Promise<void>(r=>coordinator.listen(socketPath,r));await fs.chmod(socketPath,0o600);
 await updateAccessState('scheduler-fixture',s=>({...s,mode:'on'}),stateDir);
 let lastNodeLog='';
 const launch=()=>{lastNodeLog='';const spawned=spawn(process.execPath,['--import','tsx','src/node/main.ts'],{cwd:repo,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DEX_REACH_STATE_DIR:stateDir,DEX_REACH_ENV_FILE:path.join(dir,'absent.env'),DEX_WORKSPACE_WORKER_DIR:path.join(dir,'worker'),DEX_REACH_NODE_ID:'scheduler-fixture',DEX_REACH_NODE_TOKEN:token,DEX_REACH_GATEWAY_WS:`ws://127.0.0.1:${port}/node`,DEX_REACH_ALLOWED_ROOTS:roots,DEX_REACH_PROFILE:'development'}});
 const capture=(data:Buffer)=>{lastNodeLog=(lastNodeLog+data.toString()).slice(-20000);};
 spawned.stdout!.on('data',capture);spawned.stderr!.on('data',capture);return spawned;};
 let child=launch();const store=new NodeTaskStore(stateDir);
 const ready=async()=>{if(child.exitCode!==null || child.signalCode!==null)throw new Error(`node fixture stopped: ${lastNodeLog}`);return registry.listNodes().length===1 && registry.supportsDurableTasks('scheduler-fixture');};
 const call=(operation:string,args:Record<string,unknown>,ms=TRANSPORT_MS)=>registry.requestWithTrace('scheduler-fixture',operation,args,actor,undefined,ms);
 const control=(action:'get'|'result'|'cancel',taskId:string,who=actor)=>registry.requestWithTrace('scheduler-fixture','dex.task',{},who,undefined,TRANSPORT_MS,{action,taskId});
 const start=(key:string,command:string)=>registry.requestWithTrace('scheduler-fixture','dex.task',{},actor,undefined,TRANSPORT_MS,{action:'start',operation:'dex.process.run',args:{command,cwd:roots,idempotencyKey:key}});
 try{
 await until(ready,READY_MS);
 // Idle resident desktop is not an independent workload. Actual native operation runs.
 await call('dex.process.run',{command:'printf healthy > healthy.txt',cwd:roots,idempotencyKey:'healthy'});
 assert.equal(await fs.readFile(path.join(roots,'healthy.txt'),'utf8'),'healthy');
 assert.equal(samples>0,true);
 // One-use capability grant is consumed at execution, never twice while queued.
 await updateAccessState('scheduler-fixture',s=>createGrant(s,'other',['process.shell'],[roots],60000,1),stateDir);
 await call('dex.process.run',{command:'printf grant > grant.txt',cwd:roots,idempotencyKey:'one-use-grant'});
 assert.equal(await fs.readFile(path.join(roots,'grant.txt'),'utf8'),'grant');
 assert.equal((await loadAccessState('scheduler-fixture',stateDir)).grants[0]?.uses,1);
 await assert.rejects(call('dex.process.run',{command:'touch exhausted.txt',cwd:roots,idempotencyKey:'exhausted-grant'}),/grant|authority|denied/i);
 await assert.rejects(fs.stat(path.join(roots,'exhausted.txt')),/ENOENT/);
 await updateAccessState('scheduler-fixture',s=>({...s,grants:[],grantRequired:{}}),stateDir);
 // A real held coordinated lease blocks conflicting work, independently of process fixtures.
 const held=await acquireWork({executor:'other',access:'mutate',workload:'medium',repositoryRoot:roots,snapshot:await sample()});assert.equal(held.status,'acquired');
 await assert.rejects(call('dex.process.run',{command:'touch slot.txt',cwd:roots,idempotencyKey:'full-slot'}),/COORDINATOR_WAIT_TIMEOUT/);
 if(held.status==='acquired')assert.equal((await releaseWork(held.lease.id)).released,true);
 // A stalled coordinator acquisition loses the short transport response; late admission is released and never executed.
 stallMs=2500;await assert.rejects(call('dex.process.run',{command:'touch late.txt',cwd:roots,idempotencyKey:'late'},SHORT_TRANSPORT_MS),/node request timed out/);
 await until(async()=>(await store.list()).filter(t=>t.state==='FAILED').length>=2);
 assert.equal(await fs.access(path.join(roots,'late.txt')).then(()=>true,()=>false),false);
 await until(async()=>(await readCoordinatorState()).leases.length===0);
 // Genuine competing workload uses the sole slot. Definitive refusal beats its enclosing transport.
 table+='101 1 80 3 00:01:00 /opt/homebrew/bin/claude\n';
 const before=performance.now();await assert.rejects(call('dex.process.run',{command:'touch refused.txt',cwd:roots,idempotencyKey:'refused'}),/COORDINATOR_WAIT_TIMEOUT/);
 assert.ok(performance.now()-before<TRANSPORT_MS,'a definitive refusal must arrive before its enclosing transport');
 const refused=(await store.list()).find(t=>t.idempotencyKey && t.state==='FAILED')!;assert.ok(refused);assert.equal(refused.failureClass,'TRANSIENT_RESOURCE');
 assert.equal(await fs.access(path.join(roots,'refused.txt')).then(()=>true,()=>false),false);
 assert.ok((await new TaskEventLog(stateDir).list(refused.taskId)).some(e=>e.state==='FAILED'));
 assert.equal((await readCoordinatorState()).tickets.length,0);
 // Durable queue acceptance delivers identity before capacity. Identical reattachment never spawns twice.
 const pending=await start('queued','printf once >> oracle.txt');const task=(pending.result as {taskId:string,state:string});assert.equal(task.state,'PREPARING');
 const reattached=await start('queued','printf once >> oracle.txt');assert.equal((reattached.result as {taskId:string}).taskId,task.taskId);
 await assert.rejects(control('get',task.taskId,{...actor,clientId:'wrong-actor'}),/unauthorized/);
 await assert.rejects(registry.requestWithTrace('wrong-node','dex.task',{},actor,undefined,2000,{action:'get',taskId:task.taskId}),/node is not enrolled or not online/);
 table=table.split('\n')[0]+'\n';
 await until(async()=>(await store.read(task.taskId))?.state==='COMPLETED');
 assert.equal(await fs.readFile(path.join(roots,'oracle.txt'),'utf8'),'once');await control('result',task.taskId);
 // Critical pressure refuses new mutation while light read-only remains available.
 memory='critical';await assert.rejects(call('dex.process.run',{command:'touch pressure.txt',cwd:roots,idempotencyKey:'pressure'}),/COORDINATOR_WAIT_TIMEOUT/);
 assert.equal(await fs.access(path.join(roots,'pressure.txt')).then(()=>true,()=>false),false);
 await call('dex.file.read',{path:path.join(roots,'healthy.txt')});memory='healthy';
 // Actual effect begins, transport is lost, and original task completes without replay.
 const running=(await start('disconnect','printf started >> started.txt; while ! test -f release.txt; do sleep 0.1; done; printf effect >> disconnected.txt')).result as {taskId:string};
 await until(async()=>fs.access(path.join(roots,'started.txt')).then(()=>true,()=>false));
 (registry as unknown as {nodes:Map<string,{socket:import('ws').default}>}).nodes.get('scheduler-fixture')!.socket.close();
 await fs.writeFile(path.join(roots,'release.txt'),'release');
 await until(async()=>(await store.read(running.taskId))?.state==='COMPLETED');
 await until(ready,READY_MS);
 await start('disconnect','printf started >> started.txt; while ! test -f release.txt; do sleep 0.1; done; printf effect >> disconnected.txt');
 assert.equal(await fs.readFile(path.join(roots,'disconnected.txt'),'utf8'),'effect');
 // A synchronous response is lost after execution starts. The task survives; same-key retrieval never replays.
 const lostArgs={command:'printf begun >> sync-started.txt; while ! test -f sync-release.txt; do sleep 0.1; done; printf sync-effect >> sync-oracle.txt',cwd:roots,idempotencyKey:'lost-sync'};
 const lost=call('dex.process.run',lostArgs,10000).then(()=>null,error=>error as Error);
 await until(async()=>fs.access(path.join(roots,'sync-started.txt')).then(()=>true,()=>false));
 (registry as unknown as {nodes:Map<string,{socket:import('ws').default}>}).nodes.get('scheduler-fixture')!.socket.close();
 assert.match((await lost)!.message,/uncertain|disconnect|connection/i);
 await fs.writeFile(path.join(roots,'sync-release.txt'),'release');
 await until(async()=>(await store.list()).filter(t=>t.state==='COMPLETED').length>=4);
 await until(ready,READY_MS);
 await call('dex.process.run',lostArgs);assert.equal(await fs.readFile(path.join(roots,'sync-oracle.txt'),'utf8'),'sync-effect');
 // Lose the durable acknowledgement itself, then recover its original key without another effect.
 const ackArgs={command:'printf ack-effect >> ack-oracle.txt',cwd:roots,idempotencyKey:'lost-ack'};
 const oldTasks=new Set((await store.list()).map(t=>t.taskId));
 await assert.rejects(registry.requestWithTrace('scheduler-fixture','dex.task',{},actor,undefined,2,{action:'start',operation:'dex.process.run',args:ackArgs}),/node request timed out/);
 await until(async()=>(await store.list()).some(t=>!oldTasks.has(t.taskId)&&t.state==='COMPLETED'));
 await registry.requestWithTrace('scheduler-fixture','dex.task',{},actor,undefined,TRANSPORT_MS,{action:'start',operation:'dex.process.run',args:ackArgs});
 assert.equal(await fs.readFile(path.join(roots,'ack-oracle.txt'),'utf8'),'ack-effect');
 assert.equal((await store.list()).filter(t=>!oldTasks.has(t.taskId)).length,1);
 // Result persistence fails after an actual effect. Canonical AMBIGUOUS prevents blind replay.
 await until(async()=>(await readCoordinatorState()).leases.length===0);
 const resultDir=path.join(stateDir,'results');await fs.rename(resultDir,resultDir+'.saved');await fs.writeFile(resultDir,'blocked');
 const uncertainArgs={command:'printf uncertain >> uncertain-oracle.txt',cwd:roots,idempotencyKey:'persistence'};
 await assert.rejects(call('dex.process.run',uncertainArgs,10000),/ENOTDIR|EEXIST/);
 const uncertain=(await store.list()).find(t=>t.state==='AMBIGUOUS')!;assert.ok(uncertain);assert.equal(uncertain.failureClass,'AMBIGUOUS_EFFECT');
 await fs.rm(resultDir);await fs.rename(resultDir+'.saved',resultDir);
 await assert.rejects(call('dex.process.run',uncertainArgs),/AMBIGUOUS/);
 assert.equal(await fs.readFile(path.join(roots,'uncertain-oracle.txt'),'utf8'),'uncertain');
 // Missing receipt after completion cannot erase task-bound result evidence or authorize replay.
 const receiptLog=path.join(stateDir,'receipts','scheduler-fixture.jsonl');await fs.rename(receiptLog,receiptLog+'.saved');await fs.mkdir(receiptLog);
 const receiptArgs={command:'printf receipt-effect >> receipt-oracle.txt',cwd:roots,idempotencyKey:'receipt-loss'};
 await assert.rejects(call('dex.process.run',receiptArgs,10000),/EISDIR/);
 await fs.rm(receiptLog,{recursive:true});await fs.rename(receiptLog+'.saved',receiptLog);
 await call('dex.process.run',receiptArgs);assert.equal(await fs.readFile(path.join(roots,'receipt-oracle.txt'),'utf8'),'receipt-effect');
// A numeric nonzero exit is FAILED with its real status, never COMPLETED. An identical-key retry is refused by the
// durable record and the effect oracle shows exactly one execution.
const exitArgs={command:'printf exit-effect >> exit-oracle.txt; exit 3',cwd:roots,idempotencyKey:'nonzero-exit'};
const beforeExit=new Set((await store.list()).map(t=>t.taskId));
await assert.rejects(call('dex.process.run',exitArgs,10000),/process exited with status 3/);
const exitTasks=(await store.list()).filter(t=>!beforeExit.has(t.taskId));
assert.equal(exitTasks.length,1);assert.equal(exitTasks[0]!.state,'FAILED');assert.equal(exitTasks[0]!.failureClass,'EXECUTION_FAILED');
assert.match(JSON.stringify(exitTasks[0]),/process exited with status 3/);
await assert.rejects(call('dex.process.run',exitArgs,10000),/already ended as FAILED/);
assert.equal(await fs.readFile(path.join(roots,'exit-oracle.txt'),'utf8'),'exit-effect');
 // Queue identity survives restart. Boot never reconstructs payloads or automatically replays the operation.
 table+='101 1 80 3 00:01:00 /opt/homebrew/bin/claude\n';
 const interrupted=(await start('queued-restart','printf forbidden >> restart-oracle.txt')).result as {taskId:string};
 await until(async()=>(await readCoordinatorState()).tickets.some(t=>t.taskId===interrupted.taskId));
 await stopGraceful(child);await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready,READY_MS);
 assert.equal((await store.read(interrupted.taskId))?.state,'PREPARING');
 await start('queued-restart','printf forbidden >> restart-oracle.txt');
 assert.equal(await fs.access(path.join(roots,'restart-oracle.txt')).then(()=>true,()=>false),false);
 await control('cancel',interrupted.taskId);table=table.split('\n')[0]+'\n';
 // Restart retains completed identity and task-bound result without a second effect.
 await stopGraceful(child);await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready,READY_MS);
 await control('result',running.taskId);assert.equal(await fs.readFile(path.join(roots,'disconnected.txt'),'utf8'),'effect');
 assert.equal((await store.list()).filter(t=>t.taskId===running.taskId).length,1);
 // Interrupt an in-flight execution (recorded RUNNING before the stop). Restart keeps it AMBIGUOUS and refuses identical-key replay.
 const activeCommand='printf started >> active-restart.txt; while ! test -f never-release.txt; do sleep 0.1; done; printf effect >> active-effect.txt';
 const active=(await start('active-restart',activeCommand)).result as {taskId:string};
 // The shell's `>>` creates the file before printf writes: wait for the marker itself, not the empty file.
 await until(async()=>(await fs.readFile(path.join(roots,'active-restart.txt'),'utf8').catch(()=>''))==='started');
 assert.deepEqual(await stopGraceful(child),{code:0,signal:null});await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready,READY_MS);
 assert.equal((await store.read(active.taskId))?.state,'AMBIGUOUS');
 await assert.rejects(start('active-restart',activeCommand),/AMBIGUOUS/);
 assert.equal(await fs.readFile(path.join(roots,'active-restart.txt'),'utf8'),'started');
 assert.equal(await fs.access(path.join(roots,'active-effect.txt')).then(()=>true,()=>false),false);
 // Crash the node alone. The shell is orphaned, still held by its release marker; the task must still be AMBIGUOUS, never replayed.
 const crashCommand='printf started >> crash-restart.txt; while ! test -f crash-release.txt; do sleep 0.1; done; printf effect >> crash-effect.txt';
 // The graceful step's lease must be gone before the crash task is admitted, or it queues behind a dead holder.
 // It is released at boot when the orphan is already gone, or by the node's 30 s orphan supervisor once it has ended.
 // The wait returns as soon as the lease is absent; the bound covers one supervisor period plus margin, never a fixed sleep.
 await until(async()=>(await readCoordinatorState()).leases.length===0, 60_000);
 const crashed=(await start('crash-restart',crashCommand)).result as {taskId:string};
 await until(async()=>(await fs.readFile(path.join(roots,'crash-restart.txt'),'utf8').catch(()=>''))==='started');
 assert.deepEqual(await crashNodeOnly(child),{code:null,signal:'SIGKILL'});
 await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready,READY_MS);
 // Boot found the orphan alive through its identity-verified activity row and lease. Contract (repair C): the task is
 // recorded AMBIGUOUS and the orphan is monitored. It is never left RUNNING and never completed or replayed.
 const crashedRecord=await store.read(crashed.taskId);
 const crashDetail=()=>JSON.stringify({state:crashedRecord?.state,failureClass:crashedRecord?.failureClass,summary:(crashedRecord as unknown as {summary?:string})?.summary,nodeLog:lastNodeLog.slice(-1500)});
 assert.equal(crashedRecord?.state,'AMBIGUOUS',crashDetail());assert.equal(crashedRecord?.failureClass,'AMBIGUOUS_EFFECT',crashDetail());
 // Identity is captured at spawn on Linux, so the orphan is a strong, identity-bound record; elsewhere it stays legacy-weak.
 const orphan=(await listProcessActivities({includeFinished:true})).find(a=>a.taskId===crashed.taskId);
 assert.ok(orphan,'the orphan has a durable activity row');
 if(process.platform==='linux')assert.equal(orphan.identity?.platform,'linux');
 // Identical-key retrieval is refused as ambiguous and never spawns again (a second spawn would append a second 'started').
 await assert.rejects(start('crash-restart',crashCommand),/AMBIGUOUS/);
 assert.equal(await fs.readFile(path.join(roots,'crash-restart.txt'),'utf8'),'started');
 assert.equal(await fs.access(path.join(roots,'crash-effect.txt')).then(()=>true,()=>false),false);
 // Release the orphaned shell. The file it writes is the observable completion; the node does not observe its exit status.
 await fs.writeFile(path.join(roots,'crash-release.txt'),'release');
 await until(async()=>fs.access(path.join(roots,'crash-effect.txt')).then(()=>true,()=>false));
 assert.equal(await fs.readFile(path.join(roots,'crash-effect.txt'),'utf8'),'effect');
 // After the orphan is gone, a restarted node still never completes or replays the task.
 await until(async()=>(await listProcessActivities({includeFinished:true})).find(a=>a.taskId===crashed.taskId)?.state!=='running');
 await stopGraceful(child);await until(async()=>registry.listNodes().length===0);child=launch();await until(ready,READY_MS);
 assert.equal((await store.read(crashed.taskId))?.state,'AMBIGUOUS');
 await assert.rejects(start('crash-restart',crashCommand),/AMBIGUOUS/);
 assert.equal(await fs.readFile(path.join(roots,'crash-restart.txt'),'utf8'),'started');
 assert.equal(await fs.readFile(path.join(roots,'crash-effect.txt'),'utf8'),'effect');

 }finally{
 await stopGraceful(child);registry.shutdown();await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>coordinator.close(()=>r()));await fs.rm(socketPath,{force:true});
 if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;
 await fs.rm(dir,{recursive:true,force:true});
 }
});
