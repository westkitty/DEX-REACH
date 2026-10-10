import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startLivePair } from './lib/live-reach.js';

const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historical = process.argv[2];
if (!historical || !path.isAbsolute(historical)) throw new Error('absolute disposable historical checkout required');
const historicalSha = execFileSync('git',['rev-parse','HEAD'],{cwd:historical,encoding:'utf8'}).trim();
const historicalProtocol = await fs.readFile(path.join(historical,'src/shared/protocol.ts'),'utf8');
assert.ok(!historicalProtocol.includes('REACH_PROTOCOL_V2'),'historical source must predate semantic v2');
const evidence: Array<Record<string,unknown>> = [];
for (const [label,gatewayRepoRoot,nodeRepoRoot] of [
  ['current/current',current,current], ['current/historical',current,historical],
  ['historical/current',historical,current], ['historical/historical',historical,historical]
]) {
  const pair=await startLivePair({repoRoot:current,gatewayRepoRoot,nodeRepoRoot,compiled:true,nodeIds:['matrix-node']});
  try {
    await pair.dexCli(['enable','--node','matrix-node']);
    const source=path.join(pair.roots,'read.txt'); await fs.writeFile(source,'historical interoperability');
    const sync=await pair.call('reach_file_read',{node_id:'matrix-node',path:source});
    assert.equal(sync.ok,true,sync.text); assert.match(sync.text,/historical interoperability/);
    const durable=await pair.call('reach_task',{node_id:'matrix-node',action:'start',operation:'dex.file.read',arguments:{path:source},mode:'durable'}).catch(error => { if (error?.code !== -32602 || !/reach_task.*not found/.test(error.message)) throw error; return {ok:false,text:'Protocol v1 ingress refuses unknown reach_task tool (-32602).'}; });
    if(label==='current/current') {assert.equal(durable.ok,true,durable.text);assert.match(durable.text,/rtsk_/);}
    else {assert.equal(durable.ok,false,durable.text);assert.doesNotMatch(durable.text,/rtsk_/);}
    await pair.stopNode('matrix-node'); await pair.waitForNodeCount(0);
    await pair.startNode('matrix-node'); await pair.waitForNodeCount(1);
    const reconnect=await pair.call('reach_file_read',{node_id:'matrix-node',path:source}); assert.equal(reconnect.ok,true,reconnect.text);
    const wrong=await pair.call('reach_file_read',{node_id:'missing-node',path:source}); assert.equal(wrong.ok,false);
    await pair.migrateNodeToAsymmetric('matrix-node');
    const signed=await pair.call('reach_file_read',{node_id:'matrix-node',path:source}); assert.equal(signed.ok,true,signed.text);
    evidence.push({label,signedTransport:'PASS',sync:'PASS',durable:label==='current/current'?'PASS':'REFUSED',reconnect:'PASS',noFallback:'PASS',processes:'independently compiled gateway and node',authentication:'synthetic bearer node enrollment and real OAuth MCP',refusal:durable.ok?undefined:durable.text.slice(0,300)});
  } finally {await pair.stop();await fs.rm(pair.workspace,{recursive:true,force:true});}
}
console.log(JSON.stringify({historicalSha,currentSha:execFileSync('git',['rev-parse','HEAD'],{cwd:current,encoding:'utf8'}).trim(),matrix:evidence},null,2));
