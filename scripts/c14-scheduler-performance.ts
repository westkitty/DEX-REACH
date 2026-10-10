/** Matched isolated benchmark. Baseline is an exported source revision with the same dependencies.
 * No installed process, state, coordinator socket or gateway is used. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import {pathToFileURL} from 'node:url';
const baseline=process.argv[2];
if(!baseline)throw new Error('usage: tsx scripts/c14-scheduler-performance.ts <exported-baseline-root>');
const candidate=path.resolve(import.meta.dirname,'..');
const collect=()=>{(globalThis as typeof globalThis & {gc?:()=>void}).gc?.();};
const median=(v:number[])=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)]!;
async function timed(fn:()=>unknown|Promise<unknown>,n=30){const samples=[];for(let i=0;i<n;i++){const t=performance.now();await fn();samples.push(performance.now()-t);}return median(samples);}
async function run(root:string){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-scheduler-bench-'));const prev=process.env.DEX_REACH_STATE_DIR;process.env.DEX_REACH_STATE_DIR=dir;
 const load=async(file:string)=>import(pathToFileURL(path.join(root,file)).href);
 const machine=await load('src/shared/machine-capacity.ts') as typeof import('../src/shared/machine-capacity.js');
 const work=await load('src/shared/work-coordinator.ts') as typeof import('../src/shared/work-coordinator.js');
 const daemon=await load('src/coordinator/main.ts') as typeof import('../src/coordinator/main.js');
 const events=await load('src/shared/task-events.ts') as typeof import('../src/shared/task-events.js');
 try{
 const rows=machine.parseProcessTable('PID PPID %CPU %MEM ELAPSED COMMAND\n'+Array.from({length:2000},(_,i)=>`${3000+i} 1 ${i%7===0?30:0.1} 0.5 00:01:00 ${i%3===0?'node --test fixture.ts':'/usr/bin/top'}`).join('\n'));
 const classifyMs=await timed(()=>{machine.classifyObservedWorkloads(rows,{selfPid:99999});},100);
 const snapshot={physicalMemoryBytes:8*1024**3,logicalCpuCount:8,loadAverage1m:0.5,memory:'healthy' as const,thermal:'healthy' as const,observed:{uncoordinatedHeavy:0,dexServices:0}};
 const state={leases:[],tickets:[],degraded:false,degradedReasons:[]};
 const admissionUs=1000*(await timed(()=>{for(let i=0;i<1000;i++)work.decideAdmission(state,snapshot,{access:'mutate',workload:'medium'});},30))/1000;
 const handler=daemon.createCoordinatorHandler(async()=>snapshot);
 const statusMs=await timed(()=>handler({version:1,command:'status'}));
 // Actual fresh host observation remains in isolated state (health persistence), never acquisition.
 const hostSampleMs=await timed(()=>work.snapshotCapacity(),8);
 const ticketMs=await timed(async()=>{const result=await work.acquireWork({executor:'other',access:'mutate',workload:'medium',repositoryRoot:candidate,snapshot:{...snapshot,observed:{uncoordinatedHeavy:1,dexServices:0}}});if(result.status!=='queued')throw new Error('expected queue');await work.cancelTicket(result.ticket.id);});
 const file=events.taskEventFile(dir);await fs.mkdir(path.dirname(file),{recursive:true});
 const seed=Array.from({length:2000},(_,i)=>({eventId:`tev_${i.toString(16).padStart(24,'0')}`,at:'2026-10-10T12:00:00Z',taskId:'fixture',kind:'updated',state:'PREPARING',summary:'waiting'}));
 await fs.writeFile(file,seed.map(e=>JSON.stringify(e)).join('\n')+'\n');const log=new events.TaskEventLog(dir);
 const persistMs=await timed(()=>log.append({taskId:'fixture',kind:'updated',state:'PREPARING',summary:'waiting'}));
 const diskBytes=(await fs.stat(file)).size;
 const long=Array.from({length:10000},(_,i)=>({...seed[i%seed.length]!,eventId:`tev_${i.toString(16).padStart(24,'0')}`,kind:i%100===0?'transition':'updated'}));
 collect();const heapBefore=process.memoryUsage().heapUsed;
 const retained=events.retainTaskEvents ? events.retainTaskEvents(long as never) : long.slice(-2000);
 collect();const retentionHeapDelta=process.memoryUsage().heapUsed-heapBefore;
 return {classify2000RowsMs:classifyMs,admissionDecisionUs:admissionUs,statusCachedMs:statusMs,hostSampleMs,ticketEnqueueCancelMs:ticketMs,eventAppend2000Ms:persistMs,eventDiskBytes:diskBytes,longSession:{inputEvents:long.length,retainedEvents:retained.length,retainedBytes:Buffer.byteLength(JSON.stringify(retained)),heapDeltaBytes:retentionHeapDelta},gateway:await gateway(root,dir,load)};
 }finally{if(prev===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=prev;await fs.rm(dir,{recursive:true,force:true});}
}
async function gateway(root:string,dir:string,load:(s:string)=>Promise<any>){
 const {NodeAuthStore}=await load('src/gateway/node-auth.ts');const {NodeRegistry}=await load('src/gateway/registry.ts');const {DEX_REACH_VERSION}=await load('src/shared/version.ts');
 const auth=new NodeAuthStore(dir);await auth.initialize();const token=await auth.enroll('fixture');const registry=new NodeRegistry(auth,dir);await registry.initialize();const server=http.createServer();registry.attach(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const peer=new WebSocket(`ws://127.0.0.1:${port}/node?nodeId=fixture`,{headers:{Authorization:`Bearer ${token}`}});
 const ids:string[]=[];peer.on('message',data=>{const request=JSON.parse(data.toString());if(request.type==='request')ids.push(request.id);});
 try{
 await new Promise<void>((r,j)=>{peer.once('open',r);peer.once('error',j);});
 peer.send(JSON.stringify({type:'hello',protocolVersion:1,nodeId:'fixture',profile:'development',fingerprint:{nodeId:'fixture',hostname:'fixture',platform:'fixture',arch:'fixture',user:'fixture',home:'/',cwd:'/',repositoryRoot:null,branch:null,remote:null,nodeVersion:'fixture',pythonVersion:null},tools:[],allowedRoots:['/fixture'],agentVersion:DEX_REACH_VERSION}));
 while(registry.listNodes().length!==1)await new Promise(r=>setTimeout(r,5));
 collect();const before=process.memoryUsage();const start=performance.now();const promises=Array.from({length:256},()=>registry.request('fixture','dex.fingerprint',{},undefined,10000));
 while(ids.length<256)await new Promise(r=>setTimeout(r,5));collect();const waiting=process.memoryUsage();const pendingMs=performance.now()-start;
 const cleanup=performance.now();for(const id of ids)peer.send(JSON.stringify({type:'response',id,ok:true,result:{fixture:true}}));await Promise.all(promises);
 return {pendingRequests:256,dispatchMs:pendingMs,pendingHeapDeltaBytes:waiting.heapUsed-before.heapUsed,pendingRssDeltaBytes:waiting.rss-before.rss,settleMs:performance.now()-cleanup,remainingPending:registry.pending.size};
 }finally{peer.close();registry.shutdown();await new Promise<void>(r=>server.close(()=>r()));}
}
const before=await run(path.resolve(baseline));const after=await run(candidate);
console.log(JSON.stringify({scope:'ISOLATED_MATCHED_SOURCE',baselineRoot:path.basename(baseline),node:process.version,before,after},null,2));
