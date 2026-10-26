// Real elapsed-time retention comparison in isolated protocol sessions.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL}from'node:url';import {performance}from'node:perf_hooks';
import {Client}from'@modelcontextprotocol/client';import{StdioClientTransport}from'@modelcontextprotocol/client/stdio';
const repo=process.cwd(),pkg=process.env.DEX_NATIVE_TEST_PACKAGE;if(!pkg)throw new Error('DEX_NATIVE_TEST_PACKAGE required');
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-expiry-'))),sessions=[];
const text=r=>(r.content??[]).filter(i=>i.type==='text').map(i=>i.text).join('\n');
try{
 for(const kind of ['incumbent','candidate']){
  const root=path.join(dir,kind),home=path.join(root,'home');await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(root,'input.txt'),'needle');
  await fs.mkdir(path.join(home,'.claude-server-commander'));await fs.writeFile(path.join(home,'.claude-server-commander/config.json'),JSON.stringify({allowedDirectories:[root],telemetryEnabled:false,welcomeOnboardingEligible:false,pendingWelcomeOnboarding:false,defaultShell:'/bin/sh'}));
  let entry=path.join(pkg,'runtime/index.js');
  if(kind==='incumbent'){
   const base=path.join(repo,'node_modules/@wonderwhy-er/desktop-commander/dist'),u=s=>JSON.stringify(pathToFileURL(path.join(base,s)).href);entry=path.join(root,'reference.mjs');
   await fs.writeFile(entry,`global.disableOnboarding=true;const{server}=await import(${u('server.js')});const{configManager}=await import(${u('config-manager.js')});await configManager.loadConfig();const{FilteredStdioServerTransport}=await import(${u('custom-stdio.js')});const t=new FilteredStdioServerTransport();global.mcpTransport=t;await server.connect(t);`);
  }
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],stderr:'pipe',env:{HOME:home,USER:os.userInfo().username,PATH:'/opt/homebrew/bin:/usr/bin:/bin',DEX_COMPAT_ALLOWED_ROOTS:JSON.stringify([root])}});transport.stderr?.on('data',()=>{});
  const client=new Client({name:'dex-expiry-proof',version:'1'});await client.connect(transport);
  const result=await client.callTool({name:'start_search',arguments:{path:root,pattern:'needle',searchType:'content',timeout_ms:1000}}),id=/session: (\S+)/.exec(text(result))?.[1];
  if(!id||result.isError)throw new Error(kind+' search startup failed');
  sessions.push({kind,client,id,started:performance.now()});
 }
 console.log('Waiting 310 seconds for actual five-minute completed search expiry; no owner state or live workload.');
 await new Promise(resolve=>setTimeout(resolve,310000));
 const rows=[];
 for(const s of sessions){const r=await s.client.callTool({name:'get_more_search_results',arguments:{sessionId:s.id}});rows.push({kind:s.kind,ageMs:performance.now()-s.started,expired:!!r.isError,error:text(r).replaceAll(s.id,'<HANDLE>')});}
 const report={at:new Date().toISOString(),rows,pass:rows.every(r=>r.expired)};
 await fs.writeFile('docs/native-backend-evidence/expiry.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 if(!report.pass)process.exitCode=1;
}finally{for(const s of sessions)await s.client.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});}
