import { withFileLock } from '../src/shared/state-io.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLivePair } from '../scripts/lib/live-reach.js';
import { NodeTaskStore } from '../src/node/task-store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('real OAuth MCP durable task reaches SSE client and resumes persisted cursor after node restart', {timeout: 90000}, async () => {
  const pair = await startLivePair({capacityObservation:'synthetic',repoRoot, nodeIds:['stream-node'], profile:'development'});
  try {
    await pair.dexCli(['enable','--node','stream-node']);
    const source = path.join(pair.roots, 'input.txt'); await fs.writeFile(source, 'fixture');
    const started = await pair.call('reach_task', {node_id:'stream-node',action:'start',operation:'dex.file.read',arguments:{path:source},mode:'durable'});
    assert.equal(started.ok,true,started.text);
    const taskId = started.text.match(/rtsk_[0-9a-f]+_[0-9a-f]+/)?.[0]; assert.ok(taskId,started.text);
    const route = `/api/v2/tasks/${taskId}/events?node_id=stream-node`;
    const response = await pair.authorizedFetch(route); assert.equal(response.status,200);
    const data = await response.text();
    assert.match(data,/ACCEPTED/); assert.match(data,/COMPLETED/);
    assert.doesNotMatch(data,/input\.txt|fixture|actor_|payloadSha256|resultRef/);
    const ids = [...data.matchAll(/^id: (tev_[0-9a-f]{24})$/gm)].map(m=>m[1]!); assert.ok(ids.length>=3);
    await pair.stopNode('stream-node'); await pair.waitForNodeCount(0);
    await pair.startNode('stream-node'); await pair.waitForNodeCount(1);
    const resumed = await pair.authorizedFetch(route,{headers:{'Last-Event-ID':ids[0]!}});
    const replay = await resumed.text(); assert.equal(resumed.status,200);
    assert.doesNotMatch(replay,new RegExp(`id: ${ids[0]}`)); assert.match(replay,/COMPLETED/);
    const missing = await pair.authorizedFetch(route,{headers:{'Last-Event-ID':'tev_'+'f'.repeat(24)}});
    assert.match(await missing.text(),/event: gap/);
    assert.equal((await pair.otherActorFetch(route)).status,403);
    const invalid = await pair.authorizedFetch(route,{headers:{'Last-Event-ID':'../invalid'}}); assert.equal(invalid.status,400);
    const unauth = await fetch(new URL(route,pair.baseUrl)); assert.equal(unauth.status,401);
    await withFileLock(path.join(pair.stateDir,'tasks','admission.lock'),async()=>{
      const blocked=pair.call('reach_task',{node_id:'stream-node',action:'start',operation:'dex.file.read',arguments:{path:source},mode:'durable'});
      await new Promise(resolve=>setTimeout(resolve,5500));
      const refusal=await blocked;assert.equal(refusal.ok,false);assert.match(refusal.text,/DURABLE_ADMISSION_UNAVAILABLE/);
    });
    assert.equal((await pair.call('reach_file_read',{node_id:'stream-node',path:source})).ok,true);
    await pair.dexCli(['disable' ,'--node','stream-node']);
    const denied = await pair.authorizedFetch(route); assert.equal(denied.status,403);
    const records = await new NodeTaskStore(pair.stateDir).list();
    assert.equal(records.filter(t=>t.taskId===taskId).length,1);
    assert.equal(records.find(t=>t.taskId===taskId)?.state,'COMPLETED');
  } finally { await pair.stop(); await fs.rm(pair.workspace,{recursive:true,force:true}); }
});

test('gateway loss and subscriber disconnect preserve one running external effect and cursor replay', {timeout:90000}, async()=>{
  const pair=await startLivePair({capacityObservation:'synthetic',repoRoot,nodeIds:['chaos-node'],profile:'development'});
  try{
    await pair.dexCli(['enable','--node','chaos-node']);
    const args={node_id:'chaos-node',action:'start',operation:'dex.process.run',mode:'durable',arguments:{command:'touch running.txt; for i in $(seq 1 600); do if test -f release.txt; then printf effect >> oracle.txt; exit 0; fi; sleep 0.1; done; exit 1',cwd:pair.roots,idempotencyKey:'once-only'}};
    // Admission is bounded: under full-suite contention a caller may receive uncertainty.
    // Reconcile by retrying the identical key, never by creating a replacement task.
    const admit=async()=>{
      for(let attempt=0;attempt<6;attempt++){
        const result=await pair.call('reach_task',args);
        if(result.ok)return result;
        assert.match(result.text,/DURABLE_ADMISSION_UNAVAILABLE/);
      }
      throw new Error('same-key admission did not recover within six bounded attempts');
    };
    const results=await Promise.all([admit(),admit()]);
    results.forEach(r=>assert.equal(r.ok,true,r.text));
    const ids=results.map(r=>r.text.match(/rtsk_[0-9a-f]+_[0-9a-f]+/)?.[0]);assert.ok(ids[0]);assert.equal(ids[0],ids[1]);
    const route=`/api/v2/tasks/${ids[0]}/events?node_id=chaos-node`;
    const abort=new AbortController();
    const response=await pair.authorizedFetch(route,{signal:abort.signal});assert.equal(response.status,200);
    const reader=response.body!.getReader(); const first=await reader.read();
    const firstText=new TextDecoder().decode(first.value);assert.match(firstText,/ACCEPTED/);
    const cursor=firstText.match(/id: (tev_[0-9a-f]{24})/)?.[1];assert.ok(cursor);
    abort.abort();await reader.cancel().catch(()=>{});
    for(let attempt=0;attempt<150;attempt++){
      if(await fs.access(path.join(pair.roots,'running.txt')).then(()=>true,()=>false))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await fs.access(path.join(pair.roots,'running.txt')).catch(async error=>{throw new Error(`${String(error)}; isolated task states: ${JSON.stringify((await new NodeTaskStore(pair.stateDir).list()).map(t=>({state:t.state,status:t.summary.status,failure:t.failureClass})))}`);});
    const cancelled=await pair.call('reach_task',{node_id:'chaos-node',action:'cancel',task_id:ids[0]});
    assert.equal(cancelled.ok,false,cancelled.text);assert.match(cancelled.text,/CANCELLATION_UNPROVEN/);
    await pair.restartGateway();
    const resumed=await pair.authorizedFetch(route,{headers:{'Last-Event-ID':cursor}});assert.equal(resumed.status,200);
    await fs.writeFile(path.join(pair.roots,'release.txt'),'release');
    assert.match(await resumed.text(),/COMPLETED/);
    assert.equal(await fs.readFile(path.join(pair.roots,'oracle.txt'),'utf8'),'effect');
    const records=await new NodeTaskStore(pair.stateDir).list();
    assert.equal(records.filter(t=>t.operation==='dex.process.run').length,1);
  }finally{await pair.stop();await fs.rm(pair.workspace,{recursive:true,force:true});}
});
