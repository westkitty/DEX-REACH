import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeTaskControl, createGrant, defaultAccessState } from '../src/shared/access.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { TaskEventLog, taskEventFile } from '../src/shared/task-events.js';
import { taskStreamPage } from '../src/shared/task-stream.js';

test('task control retains original paths and capabilities under changed and expired grants', () => {
  const actor = {kind:'other' as const,clientId:'a',clientName:'fixture'};
  let state: ReturnType<typeof defaultAccessState> = {...defaultAccessState(),mode:'on' as const};
  state = createGrant(state,'other',['file.read'],['/public'],10000,null);
  assert.throws(()=>authorizeTaskControl(state,actor,'dex.file.read','development',{capabilities:['file.read'],paths:['/private/content']},'a'.repeat(64)),/original authority/);
  authorizeTaskControl(state,actor,'dex.file.read','development',{capabilities:['file.read'],paths:['/public/content']},undefined);
  assert.throws(()=>authorizeTaskControl(state,actor,'dex.file.read','development',{capabilities:['file.read'],paths:['/public/content']},undefined,Date.now()+20000),/original authority/);
  assert.throws(()=>authorizeTaskControl(state,actor,'dex.repoInfo','development',{capabilities:['inspect','file.read'],paths:['/public']},undefined),/original authority/);
  assert.throws(()=>authorizeTaskControl(state,actor,'dex.file.read','development',undefined,'a'.repeat(64)),/legacy task authority/);
});
test('atomic cancellation cannot cancel a task that advanced to running, and event replay exposes gaps', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-task-guard-'));
  try {
    const store=new NodeTaskStore(dir);
    const task=await store.create({actorId:'actor-a',nodeId:'node-a',operation:'dex.file.read',idempotencyKey:'fixture',payloadSha256:'a'.repeat(64)});
    await store.transition(task.taskId,'PREPARING');
    await store.transition(task.taskId,'RUNNING');
    await assert.rejects(store.transition(task.taskId,'CANCELLED','cancel',['ACCEPTED','PREPARING']),/CANCELLATION_UNPROVEN/);
    assert.equal((await store.read(task.taskId))?.state,'RUNNING');
    const log=new TaskEventLog(dir); const events=await log.list(task.taskId);
    const page=await taskStreamPage(log,task.taskId,'node-a','RUNNING',events[0]!.eventId);
    assert.equal(page.events.length,2); assert.equal(page.gap,false);
    await assert.rejects(taskStreamPage(log,task.taskId,'node-a','RUNNING','bad'),/invalid event cursor/);
    await fs.writeFile(taskEventFile(dir),events.slice(1).map(e=>JSON.stringify(e)).join('\n')+'\n');
    assert.equal((await taskStreamPage(log,task.taskId,'node-a','RUNNING',events[0]!.eventId)).gap,true);
    assert.equal((await taskStreamPage(log,task.taskId,'node-a','RUNNING')).gap,true);
    await assert.rejects(store.create({actorId:'actor-a',nodeId:'node-a',operation:'dex.file.read',idempotencyKey:'fixture',payloadSha256:'a'.repeat(64)}),/reattach/);
    await store.create({actorId:'actor-b',nodeId:'node-a',operation:'dex.file.read',idempotencyKey:'fixture',payloadSha256:'a'.repeat(64)});
    await fs.appendFile(taskEventFile(dir),'{corrupt\n');
    await assert.rejects(taskStreamPage(log,task.taskId,'node-a','RUNNING'),/event history is corrupt/);
    const corruptHistory=await fs.readFile(taskEventFile(dir),'utf8');
    await assert.rejects(log.append({taskId:task.taskId,kind:'updated',summary:'must not erase corruption'}),/event history is corrupt/);
    assert.equal(await fs.readFile(taskEventFile(dir),'utf8'),corruptHistory);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
