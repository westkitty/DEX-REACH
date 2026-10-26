import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NodeAuthStore} from '../src/gateway/node-auth.js';
import {NodeRegistry} from '../src/gateway/registry.js';
import {createCoordinatorHandler,handleCoordinatorSocket} from '../src/coordinator/main.js';
import {coordinatorSocketPath,type CapacitySnapshot} from '../src/shared/work-coordinator.js';
import {createGrant,updateAccessState} from '../src/shared/access.js';
import {NodeTaskStore} from '../src/node/task-store.js';

test('native package through real node executor enforces modes, grants, roots, revocation and exact selected surface',{timeout:90000},async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-node-')));
 const state=path.join(dir,'state'),roots=path.join(dir,'roots');await fs.mkdir(state);await fs.mkdir(roots);
 let packageRoot=process.env.DEX_NATIVE_TEST_PACKAGE;
 if(!packageRoot){
  packageRoot=path.join(dir,'package');
  const exec=promisify(execFile);
  await exec(process.execPath,['scripts/package-native-backend.mjs','--destination',packageRoot],{cwd:process.cwd()});
  await exec('npm',['ci','--ignore-scripts','--no-fund','--no-audit'],{cwd:packageRoot,env:{...process.env,PUPPETEER_SKIP_DOWNLOAD:'true'},timeout:60000});
 }
 const previous=process.env.DEX_REACH_STATE_DIR;process.env.DEX_REACH_STATE_DIR=state;
 const nodeId='native-fixture',actor={kind:'other' as const,clientId:'native-client',clientName:'fixture'};
 const auth=new NodeAuthStore(state);await auth.initialize();const token=await auth.enroll(nodeId);
 const registry=new NodeRegistry(auth,state);await registry.initialize();
 const server=http.createServer();registry.attach(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as net.AddressInfo).port;
 const sample=async():Promise<CapacitySnapshot>=>({physicalMemoryBytes:8*1024**3,logicalCpuCount:8,loadAverage1m:0.1,memory:'healthy',thermal:'healthy',observed:{uncoordinatedHeavy:0,dexServices:0}});
 const handler=createCoordinatorHandler(sample),coordinator=net.createServer(socket=>handleCoordinatorSocket(socket,handler));
 await new Promise<void>(r=>coordinator.listen(coordinatorSocketPath(),r));
 await updateAccessState(nodeId,s=>({...s,mode:'on'}),state);
 assert.ok(packageRoot,'native package must be available');
 const code="import {runNode} from './src/node/main.ts'; import {NativeCompatibilityAdapter} from './src/node/adapters/native-compatibility.ts'; await runNode(registry=>new NativeCompatibilityAdapter(registry,process.env.DEX_NATIVE_TEST_PACKAGE));";
 const launchArgs=process.env.DEX_NATIVE_TEST_DEFAULT==='1'?['dist/src/node/main.js']:['--import','tsx','--input-type=module','-e',code];
 const child=spawn(process.execPath,launchArgs,{cwd:process.env.DEX_NATIVE_NODE_CWD??process.cwd(),detached:true,stdio:['ignore','pipe','pipe'],env:{
  ...process.env,HOME:dir,DEX_REACH_STATE_DIR:state,DEX_REACH_ENV_FILE:path.join(dir,'absent.env'),DEX_WORKSPACE_WORKER_DIR:path.join(dir,'worker'),
  DEX_REACH_NODE_ID:nodeId,DEX_REACH_NODE_TOKEN:token,DEX_REACH_GATEWAY_WS:`ws://127.0.0.1:${port}/node`,DEX_REACH_ALLOWED_ROOTS:roots,
  DEX_REACH_PROFILE:'full-local',DEX_NATIVE_TEST_PACKAGE:packageRoot
 }});
 let diagnostics='';child.stdout.on('data',d=>{diagnostics=(diagnostics+d).slice(-6000);});child.stderr.on('data',d=>{diagnostics=(diagnostics+d).slice(-6000);});
 let sequence=0;
 const call=(tool:string,args:Record<string,unknown>={})=>registry.requestWithTrace(nodeId,'dc.call',{tool,arguments:args,idempotencyKey:'native-'+(++sequence)},actor,undefined,10000).catch((error:Error)=>{throw new Error(tool+': '+error.message);});
 const store=new NodeTaskStore(state);
 try{
  const deadline=Date.now()+30000;
  while(registry.listNodes().length===0 || !registry.supportsDurableTasks(nodeId)){
   if(child.exitCode!==null||child.signalCode!==null)throw new Error('fixture node exited: '+diagnostics);
   if(Date.now()>deadline)throw new Error('fixture node readiness timeout: '+diagnostics);
   await new Promise(r=>setTimeout(r,50));
  }
  const fixture=JSON.parse(await fs.readFile('tests/fixtures/desktop-commander-0.2.52-remote-contract.json','utf8')) as {tools:Array<{name:string}>};
  assert.deepEqual((registry.listTools(nodeId) as Array<{name:string}>).map(t=>t.name).sort(),fixture.tools.map(t=>t.name).sort());
  const file=path.join(roots,'input.txt');await fs.writeFile(file,'authorized sentinel');
  const outside=path.join(dir,'outside.txt');await fs.writeFile(outside,'outside sentinel');
  await call('read_file',{path:file});
  await updateAccessState(nodeId,s=>({...s,mode:'off'}),state);
  for(const tool of fixture.tools)await assert.rejects(call(tool.name,tool.name==='read_file'?{path:file}:{}),/disabled remote AI execution/i);
  await updateAccessState(nodeId,s=>({...s,mode:'read-only'}),state);
  await call('read_file',{path:file});
  const effect=path.join(roots,'effect.txt');
  await assert.rejects(call('write_file',{path:effect,content:'forbidden'}),/read.only|denied|write/i);
  await assert.rejects(fs.access(effect));
  await updateAccessState(nodeId,s=>({...s,mode:'on',grantRequired:{other:true},grants:[]}),state);
  for(const tool of fixture.tools)await assert.rejects(call(tool.name,tool.name==='read_file'?{path:file}:{}),/requires an active capability grant/i);
  await updateAccessState(nodeId,s=>createGrant(s,'other',['compat','file.read'],[roots],60000,3),state);
  await call('read_file',{path:file});
  await assert.rejects(call('read_file',{path:outside}),/root|path|scope|grant/i);
  await updateAccessState(nodeId,s=>({...s,grants:[]}),state);
  await assert.rejects(call('read_file',{path:file}),/grant|denied|authority/i);
  await updateAccessState(nodeId,s=>({...s,grantRequired:{},grants:[]}),state);
  for(const name of ['set_config_value','get_recent_tool_calls','give_feedback_to_desktop_commander','get_prompts']){
   await assert.rejects(call(name,{key:'allowedDirectories',value:[]}),/no installed adapter provides|not provided|unknown|blocked|remotely|unsupported/i);
  }
  await assert.rejects(registry.requestWithTrace('absent-node','dc.call',{tool:'read_file',arguments:{path:file}},actor),/not enrolled|not online/i);
  await updateAccessState(nodeId,s=>({...s,clients:{other:'off'}}),state);
  await assert.rejects(call('get_config'),/disabled remote AI execution/i);
  await updateAccessState(nodeId,s=>({...s,clients:{other:'read-only'}}),state);
  await assert.rejects(call('write_file',{path:effect,content:'ceiling forbidden'}),/read.only/i);
  await updateAccessState(nodeId,s=>({...s,clients:{},mode:'on',until:new Date(Date.now()-1000).toISOString(),revertTo:'off'}),state);
  await assert.rejects(call('read_file',{path:file}),/disabled remote AI execution/i);
  await updateAccessState(nodeId,s=>({...s,until:null,revertTo:null}),state);
  await call('write_file',{path:effect,content:'authorized write'});
  assert.equal(await fs.readFile(effect,'utf8'),'authorized write');
  assert.ok((await store.list()).some(t=>t.operation==='dc.call'&&t.state==='COMPLETED'),'real durable executor persisted completion');
  await auth.revoke(nodeId);
  await assert.rejects(registry.requestWithTrace(nodeId,'dc.call',{tool:'read_file',arguments:{path:file}},actor),/revok|not enrolled|not online/i);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){
   const ended=new Promise<void>(r=>child.once('exit',()=>r()));
   child.kill('SIGTERM');await Promise.race([ended,new Promise<void>(r=>setTimeout(r,4000))]);
   if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid!,'SIGKILL');}catch{}}
  }
  registry.shutdown();await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>coordinator.close(()=>r()));
  if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;
  await fs.rm(dir,{recursive:true,force:true});
 }
});
