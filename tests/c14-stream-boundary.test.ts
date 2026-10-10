import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { installTaskStream } from '../src/gateway/task-stream.js';
import type { NodeRegistry } from '../src/gateway/registry.js';
const taskId='rtsk_19999999999_0123456789abcdef';
const actor={kind:'other' as const,clientId:'fixture',clientName:'fixture'};
test('stream normalizes malicious timestamps, isolates identity and bounds subscribers', async()=>{
  const app=express();let forged=false;let terminal=true;
  const registry={requestWithTrace:async()=>({result:{taskId,nodeId:forged?'other':'node-a',terminal,gap:false,
    events:terminal?[{eventId:'tev_'+'a'.repeat(24),taskId,at:'Thu, 01 Jan 1970 00:00:00 GMT (PRIVATE_USER_TEXT)',state:'COMPLETED',summary:'PRIVATE_USER_TEXT'}]:[]}})} as unknown as NodeRegistry;
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
