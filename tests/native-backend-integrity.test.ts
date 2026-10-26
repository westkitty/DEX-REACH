import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativeCompatibilityAdapter} from '../src/node/adapters/native-compatibility.js';
import {AdapterRegistry} from '../src/shared/adapter-contract.js';
const exec=promisify(execFile);
test('native admission refuses a truncated source inventory before creating a backend child',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-integrity-'));
 try{
  const inventory=['index.js','server.js','config-manager.js'];
  const pkg=JSON.stringify({name:'@dex-reach/native-backend',version:'0.1.0'});
  const files:Record<string,string>={'package.json':pkg,'runtime-files.json':JSON.stringify(inventory),'LICENSE':'MIT','NOTICE.md':'fixture','runtime/index.js':'','runtime/server.js':''};
  for(const [name,content]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),content);}
  const hashes=Object.fromEntries(Object.entries(files).map(([name,content])=>[name,crypto.createHash('sha256').update(content).digest('hex')]));
  await fs.writeFile(path.join(root,'source-hashes.json'),JSON.stringify(hashes));
  const registry=new AdapterRegistry();const adapter=new NativeCompatibilityAdapter(registry,root);
  await assert.rejects(adapter.start([root]),/manifest incomplete/);
  assert.deepEqual(registry.remoteToolSurface(),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('DEX stdio drops sustained diagnostics without raw output or retained queue',async()=>{
 const code=`
import assert from 'node:assert/strict';
const {FilteredStdioServerTransport}=await import('./src/node/compat-runtime/runtime/custom-stdio.js');
const transport=new FilteredStdioServerTransport();
global.gc();const before=process.memoryUsage().heapUsed;
for(let i=0;i<100000;i++){console.log('synthetic-secret-'+i);process.stdout.write('synthetic-secret');}
global.gc();const growth=process.memoryUsage().heapUsed-before;
assert.ok(growth<2*1024*1024,'diagnostic retention exceeded 2 MiB: '+growth);
assert.ok(!('messageBuffer' in transport));
await transport.send({jsonrpc:'2.0',method:'dex-proof',params:{pass:true,growth}});
`;
 const result=await exec(process.execPath,['--expose-gc','--input-type=module','-e',code],{cwd:process.cwd(),timeout:10000,maxBuffer:1024*1024});
 assert.doesNotMatch(result.stdout,/synthetic-secret/);assert.doesNotMatch(result.stderr,/synthetic-secret/);
 const message=JSON.parse(result.stdout.trim());assert.equal(message.params.pass,true);
});
