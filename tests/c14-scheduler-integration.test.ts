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
import { TaskEventLog } from '../src/shared/task-events.js';
const actor={kind:'other' as const,clientId:'scheduler-fixture',clientName:'fixture'};
const repo=path.resolve(import.meta.dirname,'..');
async function until(fn:()=>Promise<boolean>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('fixture condition timed out');}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;const done=new Promise<void>(r=>child.once('exit',()=>r()));try{process.kill(-child.pid!,'SIGTERM');}catch{}await done;}
test('real registry, node and coordinator: capacity/refusal, durable queue, authority, disconnect and restart', {timeout:90000},async()=>{
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
 const call=(operation:string,args:Record<string,unknown>,ms=2000)=>registry.requestWithTrace('scheduler-fixture',operation,args,actor,undefined,ms);
 const control=(action:'get'|'result'|'cancel',taskId:string,who=actor)=>registry.requestWithTrace('scheduler-fixture','dex.task',{},who,undefined,2000,{action,taskId});
 const start=(key:string,command:string)=>registry.requestWithTrace('scheduler-fixture','dex.task',{},actor,undefined,2000,{action:'start',operation:'dex.process.run',args:{command,cwd:roots,idempotencyKey:key}});
 try{
 await until(ready);
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
 stallMs=2500;await assert.rejects(call('dex.process.run',{command:'touch late.txt',cwd:roots,idempotencyKey:'late'}),/node request timed out/);
 await until(async()=>(await store.list()).filter(t=>t.state==='FAILED').length>=2);
 assert.equal(await fs.access(path.join(roots,'late.txt')).then(()=>true,()=>false),false);
 await until(async()=>(await readCoordinatorState()).leases.length===0);
 // Genuine competing workload uses the sole slot. Definitive refusal beats its enclosing transport.
 table+='101 1 80 3 00:01:00 /opt/homebrew/bin/claude\n';
 const before=performance.now();await assert.rejects(call('dex.process.run',{command:'touch refused.txt',cwd:roots,idempotencyKey:'refused'}),/COORDINATOR_WAIT_TIMEOUT/);
 assert.ok(performance.now()-before<2000);
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
 await until(ready);
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
 await until(ready);
 await call('dex.process.run',lostArgs);assert.equal(await fs.readFile(path.join(roots,'sync-oracle.txt'),'utf8'),'sync-effect');
 // Lose the durable acknowledgement itself, then recover its original key without another effect.
 const ackArgs={command:'printf ack-effect >> ack-oracle.txt',cwd:roots,idempotencyKey:'lost-ack'};
 const oldTasks=new Set((await store.list()).map(t=>t.taskId));
 await assert.rejects(registry.requestWithTrace('scheduler-fixture','dex.task',{},actor,undefined,2,{action:'start',operation:'dex.process.run',args:ackArgs}),/node request timed out/);
 await until(async()=>(await store.list()).some(t=>!oldTasks.has(t.taskId)&&t.state==='COMPLETED'));
 await registry.requestWithTrace('scheduler-fixture','dex.task',{},actor,undefined,2000,{action:'start',operation:'dex.process.run',args:ackArgs});
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
 // Queue identity survives restart. Boot never reconstructs payloads or automatically replays the operation.
 table+='101 1 80 3 00:01:00 /opt/homebrew/bin/claude\n';
 const interrupted=(await start('queued-restart','printf forbidden >> restart-oracle.txt')).result as {taskId:string};
 await until(async()=>(await readCoordinatorState()).tickets.some(t=>t.taskId===interrupted.taskId));
 await stop(child);await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready);
 assert.equal((await store.read(interrupted.taskId))?.state,'PREPARING');
 await start('queued-restart','printf forbidden >> restart-oracle.txt');
 assert.equal(await fs.access(path.join(roots,'restart-oracle.txt')).then(()=>true,()=>false),false);
 await control('cancel',interrupted.taskId);table=table.split('\n')[0]+'\n';
 // Restart retains completed identity and task-bound result without a second effect.
 await stop(child);await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready);
 await control('result',running.taskId);assert.equal(await fs.readFile(path.join(roots,'disconnected.txt'),'utf8'),'effect');
 assert.equal((await store.list()).filter(t=>t.taskId===running.taskId).length,1);
 // Interrupt RUNNING execution. Restart retains uncertainty and refuses identical-key replay.
 const activeCommand='printf started >> active-restart.txt; while ! test -f never-release.txt; do sleep 0.1; done; printf effect >> active-effect.txt';
 const active=(await start('active-restart',activeCommand)).result as {taskId:string};
 await until(async()=>fs.access(path.join(roots,'active-restart.txt')).then(()=>true,()=>false));
 await stop(child);await until(async()=>registry.listNodes().length===0);child=launch();
 await until(ready);
 assert.equal((await store.read(active.taskId))?.state,'AMBIGUOUS');
 await assert.rejects(start('active-restart',activeCommand),/AMBIGUOUS/);
 assert.equal(await fs.readFile(path.join(roots,'active-restart.txt'),'utf8'),'started');
 assert.equal(await fs.access(path.join(roots,'active-effect.txt')).then(()=>true,()=>false),false);

 }finally{
 await stop(child);registry.shutdown();await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>coordinator.close(()=>r()));await fs.rm(socketPath,{force:true});
 if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;
 await fs.rm(dir,{recursive:true,force:true});
 }
});
