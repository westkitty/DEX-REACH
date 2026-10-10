import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionBudgetMs, boundedAdmissionMs } from '../src/shared/request-deadlines.js';
import { acquireTaskAdmission } from '../src/node/task-admission.js';
import { persistTaskFailure } from '../src/node/task-failure.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('admission owns an absolute ceiling, a transport reserve, and rejects malformed deadlines',()=>{
 assert.equal(admissionBudgetMs(60000),30000); assert.equal(admissionBudgetMs(2000),1000);
 for(const input of [-1,0,NaN,Infinity,0.5,30001]) assert.throws(()=>boundedAdmissionMs(input));
 assert.equal(boundedAdmissionMs(undefined),30000);
});
test('a lease arriving after the admission deadline is released without entering execution',async()=>{
 let now=0,released=0;
 await assert.rejects(acquireTaskAdmission({executor:'other',access:'mutate',workload:'medium'}, async()=>{}, 10, {
 now:()=>now, acquire:async()=>{now=20;return {status:'acquired',lease:{id:'late'}} as never;},
 release:async()=>{released++;return {released:true};}, cancel:async()=>true,sleep:async()=>{}
 }),/COORDINATOR_WAIT_TIMEOUT/);
 assert.equal(released,1);
});
test('ACCEPTED and PREPARING failures terminate legally; result persistence failure preserves possible effects',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-task-failure-'));try{
 const store=new NodeTaskStore(dir);
 for(const state of ['ACCEPTED','PREPARING','RUNNING'] as const){
 const t=await store.create({actorId:'fixture',nodeId:'fixture',operation:'dex.process.run',idempotencyKey:state,payloadSha256:'a'.repeat(64),safetyClass:'PROCESS_UNKNOWN_EFFECT'});
 if(state!=='ACCEPTED')await store.transition(t.taskId,'PREPARING');
 if(state==='RUNNING')await store.transition(t.taskId,'RUNNING');
 await persistTaskFailure(store,t.taskId,'PROCESS_UNKNOWN_EFFECT',new Error('COORDINATOR_WAIT_TIMEOUT'),state==='RUNNING');
 assert.equal((await store.read(t.taskId))?.state,state==='ACCEPTED'?'CANCELLED':state==='PREPARING'?'FAILED':'AMBIGUOUS');
 }
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
