import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { startLivePair } from './lib/live-reach.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pair=await startLivePair({capacityObservation:'synthetic',repoRoot:root,nodeIds:['performance-node']});
const samples:number[]=[];let bytes=0;
const before=process.memoryUsage();
try{
  await pair.dexCli(['enable','--node','performance-node']);
  const file=path.join(pair.roots,'sample.txt');await fs.writeFile(file,'synthetic');
  const task=await pair.call('reach_task',{node_id:'performance-node',action:'start',operation:'dex.file.read',arguments:{path:file},mode:'durable'});
  const id=task.text.match(/rtsk_[0-9a-f]+_[0-9a-f]+/)?.[0];if(!task.ok||!id)throw new Error('task not accepted');
  for(let batch=0;batch<8;batch++){
    await Promise.all(Array.from({length:8},async()=>{
      const start=performance.now();const res=await pair.authorizedFetch(`/api/v2/tasks/${id}/events?node_id=performance-node`);
      const text=await res.text();if(res.status!==200||!text.includes('COMPLETED'))throw new Error('stream incomplete');
      samples.push(performance.now()-start);bytes+=Buffer.byteLength(text);
    }));
  }
  samples.sort((a,b)=>a-b);const p=(q:number)=>samples[Math.ceil(samples.length*q)-1];
  console.log(JSON.stringify({capacityObservation:pair.capacityObservation,source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workload:'64 complete SSE replays, concurrency 8, one real OAuth durable task',samples:64,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),bytes,harnessRssDelta:process.memoryUsage().rss-before.rss,budget:'no project latency budget; distribution only',scope:'isolated source; no installed profiling'},null,2));
}finally{await pair.stop();await fs.rm(pair.workspace,{recursive:true,force:true});}
