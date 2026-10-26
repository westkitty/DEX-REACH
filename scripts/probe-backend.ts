import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {NativeCompatibilityAdapter} from '../src/node/adapters/native-compatibility.js';
import {AdapterRegistry} from '../src/shared/adapter-contract.js';
import {remoteCompatibilityTools} from '../src/shared/operations.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const packageRoot=here.endsWith(path.join('dist','scripts'))
 ?path.resolve(here,'../src/node/compat-runtime')
 :path.resolve(here,'../dist/src/node/compat-runtime');
const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-probe-')));
const previous=process.env.DEX_REACH_STATE_DIR;
process.env.DEX_REACH_STATE_DIR=path.join(temporary,'state');
const root=path.join(temporary,'root');await fs.mkdir(root);
const adapter=new NativeCompatibilityAdapter(new AdapterRegistry(),packageRoot);
try{
 const frozen=await fs.readFile(path.join(packageRoot,'runtime/fixtures/desktop-commander-0.2.52-remote-contract.json'));
 assert.equal(crypto.createHash('sha256').update(frozen).digest('hex'),'1d10d5b9b43b0f7ab0d83be849c5ade4bb9f4bc93067d9b1376197d2a4d740b8');
 const fixture=JSON.parse(frozen.toString()) as {tools:Array<{name:string;inputSchema:unknown}>};
 await adapter.start([root]);
 const tools=adapter.listTools();
 assert.deepEqual(tools.map(t=>t.name).sort(),remoteCompatibilityTools().sort());
 assert.equal(tools.length,22);
 for(const tool of fixture.tools)assert.deepEqual(tools.find(t=>t.name===tool.name)?.inputSchema,tool.inputSchema);
 await fs.writeFile(path.join(root,'probe.txt'),'isolated replacement probe');
 await adapter.callTool('read_file',{path:path.join(root,'probe.txt')});
 await assert.rejects(adapter.callTool('set_config_value',{key:'allowedDirectories',value:[]}),/Unknown tool/);
 console.log(JSON.stringify({ok:true,count:tools.length,names:tools.map(t=>t.name),implementation:adapter.manifest()?.source,sourceHash:adapter.manifest()?.sourceHash,scope:'compiled backend in isolated state; no live node or service'},null,2));
}finally{
 await adapter.close();
 if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;
 await fs.rm(temporary,{recursive:true,force:true});
}
