import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { installTaskStream } from '../src/gateway/task-stream.js';
import type { NodeRegistry } from '../src/gateway/registry.js';
const taskId='rtsk_19999999999_0123456789abcdef';
const actor={kind:'other' as const,clientId:'fixture',clientName:'fixture'};
test('stream ingress limits request churn before authorization with bounded limiter identity', async()=>{
  const app=express();let authorized=0;
  installTaskStream(app,{} as NodeRegistry,(_req,_res,next)=>{authorized++;next();},()=>actor,async()=>{});
  const server=http.createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v2/tasks/invalid/events?node_id=node-a`;
  try{
    for(let i=0;i<300;i++){const response=await fetch(url);assert.equal(response.status,400);await response.text();}
    const refused=await fetch(url,{headers:{'X-Forwarded-For':'198.51.100.42'}});
    assert.equal(refused.status,429);assert.equal(authorized,300);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('stream normalizes malicious timestamps, isolates identity and bounds subscribers', async()=>{
  const app=express();let forged=false;let terminal=true;
  const registry={requestWithTrace:async()=>({result:{taskId,nodeId:forged?'other':'node-a',terminal,gap:false,
    events:terminal?[{eventId:'tev_'+'a'.repeat(24),taskId,kind:'transition',at:'Thu, 01 Jan 1970 00:00:00 GMT (PRIVATE_USER_TEXT)',state:'COMPLETED',summary:'PRIVATE_USER_TEXT'}]:[]}})} as unknown as NodeRegistry;
  installTaskStream(app,registry,(_req,_res,next)=>next(),()=>actor,async()=>{});
  const server=http.createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v2/tasks/${taskId}/events?node_id=node-a`;
  const controllers:AbortController[]=[];
  try{
    const first=await fetch(url);const text=await first.text();assert.equal(first.status,200);
    assert.match(text,/1970-01-01T00:00:00.000Z/);assert.doesNotMatch(text,/PRIVATE_USER_TEXT/);
    forged=true;assert.equal((await fetch(url)).status,403);forged=false;terminal=false;
    for(let i=0;i<32;i++){const c=new AbortController();controllers.push(c);const response=await fetch(url,{signal:c.signal});assert.equal(response.status,200);}
    assert.equal((await fetch(url)).status,429);
    controllers.forEach(c=>c.abort());await new Promise(resolve=>setTimeout(resolve,300));
    terminal=true;assert.equal((await fetch(url)).status,200);
  }finally{controllers.forEach(c=>c.abort());server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('stream waits for writable drain and rechecks revoked subscriber before another page', async()=>{
  const app=express();let calls=0;let writes=0;let revoked=false;let release:()=>void=()=>{};
  app.use((_req,res,next)=>{
    const original=res.write.bind(res);
    res.write=((...args: Parameters<typeof res.write>)=>{
      writes++;
      const result=original(...args);
      if(writes===1){release=()=>res.emit('drain');return false;}
      return result;
    }) as typeof res.write;
    next();
  });
  const events=Array.from({length:100},(_,i)=>({eventId:`tev_${i.toString(16).padStart(24,'0')}`,taskId,kind:'transition',at:new Date().toISOString(),state:'RUNNING',summary:'private'}));
  const registry={requestWithTrace:async()=>{calls++;return {result:{taskId,nodeId:'node-a',terminal:false,gap:false,events}};}} as unknown as NodeRegistry;
  installTaskStream(app,registry,(_req,_res,next)=>next(),()=>actor,async()=>{if(revoked)throw new Error('revoked');});
  const server=http.createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v2/tasks/${taskId}/events?node_id=node-a`);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(writes,1,'blocked writable must not accumulate replay frames');assert.equal(calls,1);
    revoked=true;release();
    const body=await response.text();assert.equal((body.match(/event: task/g)||[]).length,100);
    assert.equal(calls,1,'revoked subscriber must not fetch another page');assert.doesNotMatch(body,/private/);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
