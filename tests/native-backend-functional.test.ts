import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const exec=promisify(execFile);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const text=(result:any)=>result.content?.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n')??'';
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
test('standalone native backend: real PDF security/parse, process exits and EOF descendant cleanup',{timeout:90000},async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-functional-')));
 const root=path.join(dir,'root'),home=path.join(dir,'home');await fs.mkdir(root);await fs.mkdir(home);
 let packageRoot=process.env.DEX_NATIVE_TEST_PACKAGE;
 if(!packageRoot){
  packageRoot=path.join(dir,'package');
  await exec(process.execPath,['scripts/package-native-backend.mjs','--destination',packageRoot],{cwd:process.cwd()});
  await exec('npm',['ci','--ignore-scripts','--no-fund','--no-audit'],{cwd:packageRoot,env:{...process.env,PUPPETEER_SKIP_DOWNLOAD:'true'},timeout:60000});
 }
 let requests=0;const server=http.createServer((_req,res)=>{requests++;if(_req.url==='/fixture.pdf'){void fs.readFile(path.join(root,'markdown.pdf')).then(bytes=>{res.setHeader('Content-Type','application/pdf');res.end(bytes);});return;}if(_req.url==='/oversized'){res.setHeader('Content-Type','text/plain');res.end(Buffer.alloc(17*1024*1024,'x'));}else res.end('unreachable');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as {port:number}).port;
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(packageRoot,'runtime/index.js')],stderr:'pipe',
  env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:home,USER:os.userInfo().username,DEX_COMPAT_ALLOWED_ROOTS:JSON.stringify([root])}});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'dex-functional-test',version:'1'});const pids=new Set<number>();
 const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args},{timeout:20000});
 const ok=async(name:string,args:Record<string,unknown>={})=>{const r=await call(name,args);assert.ok(!r.isError,name+': '+text(r));return r;};
 try{
  await client.connect(transport);
  const sparse=path.join(root,'oversized.txt');await fs.writeFile(sparse,'');await fs.truncate(sparse,17*1024*1024);
  const oversized=await call('read_file',{path:sparse,length:1});assert.equal(oversized.isError,true);assert.match(text(oversized),/16 MiB/);
  const hugeLine=path.join(root,'huge-line.txt');await fs.writeFile(hugeLine,'x'.repeat(3*1024*1024));
  const bounded=await call('read_file',{path:hugeLine,length:1});assert.equal(bounded.isError,true);assert.match(text(bounded),/2 MiB/);
  await fs.unlink(sparse);await fs.unlink(hugeLine);
  const output=path.join(root,'markdown.pdf'),sideEffect=path.join(root,'forbidden.txt');
  const unsafe=await call('write_pdf',{path:output,content:'x',options:{launch_options:{executablePath:'/bin/sh',args:['-c','touch '+sideEffect]}}});
  assert.equal(unsafe.isError,true);await assert.rejects(fs.access(sideEffect));
  const pathOption=await call('write_pdf',{path:output,content:'x',options:{pdf_options:{path:sideEffect}}});
  assert.equal(pathOption.isError,true);
  const content='# DEX native markdown\n\nRetained PDF text.\n\n<img src="http://127.0.0.1:'+port+'/external">\n<script>fetch("http://127.0.0.1:'+port+'/script")</script>';
  await ok('write_pdf',{path:output,content,options:{pdf_options:{format:'A4',landscape:false}}});
  assert.equal(requests,0,'rendering must not fetch external images or execute scripts');
  const swift=path.join(dir,'parse.swift');
  await fs.writeFile(swift,'import Foundation\nimport PDFKit\nguard let d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1])) else {exit(2)}\nprint(d.pageCount)\nprint(d.string ?? "")\n');
  const parsed=await exec('/usr/bin/swift',[swift,output],{timeout:60000,env:{PATH:'/usr/bin:/bin',HOME:home,CLANG_MODULE_CACHE_PATH:path.join(home,'clang')}});
  assert.match(parsed.stdout,/DEX native markdown/);assert.match(parsed.stdout,/Retained PDF text/);
  const reopened=await ok('read_file',{path:output});assert.match(text(reopened),/Retained PDF text/);
  // Document frontmatter cannot select a filesystem destination.
  await ok('write_pdf',{path:path.join(root,'frontmatter.pdf'),content:'---\ndest: '+sideEffect+'\n---\n# harmless'});
  await assert.rejects(fs.access(sideEffect));
  await fs.writeFile(path.join(root,'local-secret.txt'),'LOCAL_RESOURCE_SENTINEL');
  const resourceContent='# Resource refusal\n<style>@import url(http://127.0.0.1:'+port+'/css);</style><iframe src="file://'+path.join(root,'local-secret.txt')+'"></iframe><iframe src="http://127.0.0.1:'+port+'/frame"></iframe><meta http-equiv="refresh" content="0;url=http://127.0.0.1:'+port+'/navigation">';
  await ok('write_pdf',{path:path.join(root,'resources.pdf'),content:resourceContent});
  assert.equal(requests,0);
  const resourceParsed=await exec('/usr/bin/swift',[swift,path.join(root,'resources.pdf')],{timeout:60000,env:{PATH:'/usr/bin:/bin',HOME:home,CLANG_MODULE_CACHE_PATH:path.join(home,'clang')}});
  assert.doesNotMatch(resourceParsed.stdout,/LOCAL_RESOURCE_SENTINEL/);
  const urlPdf=await ok('read_file',{path:'http://127.0.0.1:'+port+'/fixture.pdf',isUrl:true});assert.match(text(urlPdf),/Retained PDF text/);
  const urlLimit=await call('read_file',{path:'http://127.0.0.1:'+port+'/oversized',isUrl:true});
  assert.equal(urlLimit.isError,true);assert.match(text(urlLimit),/size|limit|exceed/i);
  const code="process.stdout.write('out\\n');process.stderr.write('err\\n');setTimeout(()=>{console.log('delayed');process.exit(7)},250)";
  const started=await ok('start_process',{command:quote(process.execPath)+' -e '+quote(code),shell:'/bin/sh',timeout_ms:50});
  const pid=Number(/PID\s+(\d+)/i.exec(text(started))?.[1]);assert.ok(pid>0);pids.add(pid);
  await sleep(400);
  const read=await ok('read_process_output',{pid,timeout_ms:20,offset:0,length:100});
  assert.match(text(started)+text(read),/out/);assert.match(text(started)+text(read),/err/);assert.match(text(read),/delayed/);
  const large=await ok('start_process',{command:quote(process.execPath)+' -e '+quote("process.stdout.write('x'.repeat(10*1024*1024));setTimeout(()=>{},2000)"),shell:'/bin/sh',timeout_ms:50});
  const largePid=Number(/PID\s+(\d+)/i.exec(text(large))?.[1]);assert.ok(largePid>0);pids.add(largePid);
  const paged=await ok('read_process_output',{pid:largePid,timeout_ms:20,offset:-1,length:1});
  assert.ok(text(paged).length<2*1024*1024,'one output page must remain bounded');
  await ok('force_terminate',{pid:largePid});
  await fs.writeFile(path.join(root,'search.txt'),Array.from({length:2500},(_,i)=>'needle '+i).join('\n'));
  const search=await ok('start_search',{path:root,pattern:'needle',searchType:'content',maxResults:100000,contextLines:0,timeout_ms:1000});
  const id=/session: (\S+)/.exec(text(search))?.[1];assert.ok(id);
  const page=await ok('get_more_search_results',{sessionId:id,offset:0,length:2});assert.ok(text(page).length<10000);
  await ok('stop_search',{sessionId:id});await ok('stop_search',{sessionId:id});
  assert.equal((await call('get_more_search_results',{sessionId:'invalid'})).isError,true);
  const empty=await ok('start_search',{path:root,pattern:'no_such_marker_0123456789',searchType:'content',timeout_ms:1000});
  const emptyId=/session: (\S+)/.exec(text(empty))?.[1];assert.ok(emptyId);
  const emptyPage=await ok('get_more_search_results',{sessionId:emptyId});assert.match(text(emptyPage),/0|No results/);
  const virtual=await ok('start_process',{command:'node:local',timeout_ms:500});
  const virtualId=Number(/PID\s+(-\d+)/i.exec(text(virtual))?.[1]);assert.ok(virtualId<0);
  const virtualResult=await ok('interact_with_process',{pid:virtualId,input:'console.log("virtual sentinel")',timeout_ms:500});
  assert.match(text(virtualResult),/virtual sentinel/);
  const virtualFlood=await call('interact_with_process',{pid:virtualId,input:'process.stdout.write("x".repeat(1024*1024))',timeout_ms:500});
  assert.equal(virtualFlood.isError,true);
  const virtualTimeout=await call('interact_with_process',{pid:virtualId,input:'setInterval(()=>{},1000)',timeout_ms:50});
  assert.equal(virtualTimeout.isError,true);
  await ok('force_terminate',{pid:virtualId});
  const descendantFile=path.join(root,'unref-child.pid');
  const childProgram='setInterval(()=>{},1000)';
  const unrefProgram='import {spawn} from "node:child_process";import fs from "node:fs";const c=spawn(process.execPath,["-e",'+JSON.stringify(childProgram)+'],{stdio:"ignore"});fs.writeFileSync('+JSON.stringify(descendantFile)+',String(c.pid));c.unref();console.log("parent success");';
  const unrefVirtual=await ok('start_process',{command:'node:local',timeout_ms:1000});
  const unrefId=Number(/PID\s+(-\d+)/i.exec(text(unrefVirtual))?.[1]);
  await ok('interact_with_process',{pid:unrefId,input:unrefProgram,timeout_ms:1000});
  const unrefChild=Number(await fs.readFile(descendantFile,'utf8'));pids.add(unrefChild);
  const assertStopped=async(target:number)=>{await sleep(100);const status=await exec('/bin/ps',['-p',String(target),'-o','stat='],{timeout:3000}).then(v=>v.stdout.trim(),()=> '');assert.ok(!status||status.startsWith('Z'),'unowned live descendant '+target+': '+status);};
  await assertStopped(unrefChild);await ok('force_terminate',{pid:unrefId});
  // Ordinary shell parent success must also clean its background descendant group.
  await ok('start_process',{command:quote(process.execPath)+' --input-type=module -e '+quote(unrefProgram),shell:'/bin/sh',timeout_ms:300});
  const shellUnref=Number(await fs.readFile(descendantFile,'utf8'));pids.add(shellUnref);await assertStopped(shellUnref);
  const resistant='process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)';
  const parentWithResistantChild='import {spawn} from "node:child_process";import fs from "node:fs";const c=spawn(process.execPath,["-e",'+JSON.stringify(resistant)+'],{stdio:["ignore","pipe","ignore"]});c.stdout.once("data",()=>fs.writeFileSync('+JSON.stringify(descendantFile)+',String(c.pid)));setInterval(()=>{},1000);';
  const timeoutVirtual=await ok('start_process',{command:'node:local',timeout_ms:1000});
  const timeoutId=Number(/PID\s+(-\d+)/i.exec(text(timeoutVirtual))?.[1]);
  const timeoutResult=await call('interact_with_process',{pid:timeoutId,input:parentWithResistantChild,timeout_ms:300});assert.equal(timeoutResult.isError,true);
  const resistantChild=Number(await fs.readFile(descendantFile,'utf8'));pids.add(resistantChild);await assertStopped(resistantChild);await ok('force_terminate',{pid:timeoutId});
  // Explicit force termination must finish a TERM-resistant virtual child before its original deadline.
  const forceVirtual=await ok('start_process',{command:'node:local',timeout_ms:5000});
  const forceId=Number(/PID\s+(-\d+)/i.exec(text(forceVirtual))?.[1]),forceFile=path.join(root,'force-child.pid');
  const forcedPending=call('interact_with_process',{pid:forceId,input:'import fs from "node:fs";process.on("SIGTERM",()=>{});fs.writeFileSync('+JSON.stringify(forceFile)+',String(process.pid));setInterval(()=>{},1000)',timeout_ms:5000});
  const forceReady=Date.now()+2000;while(!(await fs.access(forceFile).then(()=>true,()=>false))){if(Date.now()>forceReady)throw new Error('force child not ready');await sleep(20);}
  const forcePid=Number(await fs.readFile(forceFile,'utf8'));pids.add(forcePid);
  const forceAt=Date.now();await ok('force_terminate',{pid:forceId});assert.equal((await forcedPending).isError,true);
  assert.ok(Date.now()-forceAt<2000,'force termination waited for original per-call deadline');await assertStopped(forcePid);
  const virtualIds:number[]=[];
  for(let i=0;i<16;i++){const r=await ok('start_process',{command:'node:local',timeout_ms:500});virtualIds.push(Number(/PID\s+(-\d+)/i.exec(text(r))?.[1]));}
  const virtualCap=await call('start_process',{command:'node:local',timeout_ms:500});assert.equal(virtualCap.isError,true);
  for(const pid of virtualIds)await ok('force_terminate',{pid});
  const virtualLive=await ok('start_process',{command:'node:local',timeout_ms:5000});
  const virtualLiveId=Number(/PID\s+(-\d+)/i.exec(text(virtualLive))?.[1]);
  const pidFile=path.join(root,'virtual-child.pid');
  const pendingVirtual=call('interact_with_process',{pid:virtualLiveId,input:'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',timeout_ms:5000}).catch(()=>null);
  const readyUntil=Date.now()+3000;while(!(await fs.access(pidFile).then(()=>true,()=>false))){if(Date.now()>readyUntil)throw new Error('virtual child did not start');await sleep(20);}
  const virtualChild=Number(await fs.readFile(pidFile,'utf8'));assert.ok(virtualChild>0);pids.add(virtualChild);
  // Keep both a shell and its descendant live; EOF must stop their owned process group.
  const descendant=await ok('start_process',{command:"sleep 30 & echo CHILD:$!; wait",shell:'/bin/sh',timeout_ms:100});
  const shell=Number(/PID\s+(\d+)/i.exec(text(descendant))?.[1]),child=Number(/CHILD:(\d+)/.exec(text(descendant))?.[1]);
  assert.ok(shell>0&&child>0);pids.add(shell);pids.add(child);
  await client.close();await pendingVirtual;await sleep(300);
  for(const target of [shell,child,virtualChild]){
   const status=await exec('/bin/ps',['-p',String(target),'-o','stat='],{timeout:3000}).then(v=>v.stdout.trim(),()=> '');
   assert.ok(!status||status.startsWith('Z'),'EOF left a live owned child '+target+': '+status);
  }
 }finally{
  await client.close().catch(()=>{});
  for(const pid of pids){try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}}
  await new Promise<void>(r=>server.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});
 }
});
