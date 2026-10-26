// Bounded sequential comparison; no DEX services or owner state.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {performance} from 'node:perf_hooks';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/client';import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const exec=promisify(execFile),repo=process.cwd(),packageRoot=process.env.DEX_NATIVE_TEST_PACKAGE;
if(!packageRoot)throw new Error('DEX_NATIVE_TEST_PACKAGE required');
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-benchmark-'))),rows=[];
try{for(let round=0;round<3;round++)for(const kind of ['incumbent','candidate']){
 const root=path.join(dir,kind+round),home=path.join(root,'home');await fs.mkdir(home,{recursive:true});const file=path.join(root,'input.txt');await fs.writeFile(file,'bounded latency fixture\n'.repeat(32));
 await fs.mkdir(path.join(home,'.claude-server-commander'));await fs.writeFile(path.join(home,'.claude-server-commander/config.json'),JSON.stringify({allowedDirectories:[root],telemetryEnabled:false,welcomeOnboardingEligible:false,pendingWelcomeOnboarding:false}));
 let entry=path.join(packageRoot,'runtime/index.js');
 if(kind==='incumbent'){
  entry=path.join(root,'incumbent.mjs');const base=path.join(repo,'node_modules/@wonderwhy-er/desktop-commander/dist');const u=s=>JSON.stringify(pathToFileURL(path.join(base,s)).href);
  await fs.writeFile(entry,`global.disableOnboarding=true;const{server}=await import(${u('server.js')});const{configManager}=await import(${u('config-manager.js')});await configManager.loadConfig();const{FilteredStdioServerTransport}=await import(${u('custom-stdio.js')});const t=new FilteredStdioServerTransport();global.mcpTransport=t;await server.connect(t);`);
 }
 if(kind==='incumbent'&&process.env.DEX_INCUMBENT_CHROME_APP){
  const app=await fs.realpath(process.env.DEX_INCUMBENT_CHROME_APP);
  await fs.access(path.join(app,'Contents/MacOS/Google Chrome for Testing'));
  const cache=path.join(home,'.claude-server-commander/puppeteer-cache/chrome/existing-reference/chrome-mac-arm64');
  await fs.mkdir(cache,{recursive:true});
  await fs.symlink(app,path.join(cache,'Google Chrome for Testing.app'));
  entry=path.join(repo,'node_modules/@wonderwhy-er/desktop-commander/dist/index.js');
 }
 const transport=new StdioClientTransport({command:process.execPath,args:[entry],stderr:'pipe',env:{HOME:home,PATH:'/opt/homebrew/bin:/usr/bin:/bin',USER:os.userInfo().username,DEX_COMPAT_ALLOWED_ROOTS:JSON.stringify([root]),PUPPETEER_SKIP_DOWNLOAD:'true',DC_FLAG_URL:'http://127.0.0.1:1/disabled'}});
 transport.stderr?.on('data',()=>{});const client=new Client({name:'dex-benchmark',version:'1'}),at=performance.now();
 await client.connect(transport);const backendPid=transport.pid;await client.listTools();const startup=performance.now()-at,lat=[];
 const rss=async()=>Number((await exec('/bin/ps',['-p',String(backendPid),'-o','rss='],{timeout:3000})).stdout.trim());
 const initialRss=await rss();
 for(let i=0;i<100;i++){const t=performance.now();const r=await client.callTool({name:'read_file',arguments:{path:file,offset:0,length:4}});if(r.isError)throw new Error(kind+' read failed');lat.push(performance.now()-t);}
 const finalRss=await rss(),closeAt=performance.now();await client.close();const closeMs=performance.now()-closeAt;
 lat.sort((a,b)=>a-b);rows.push({round,kind,startupMs:startup,rssInitialKiB:initialRss,rssFinalKiB:finalRss,requests:100,latencyMedianMs:lat[49],latencyP95Ms:lat[94],closeMs,childExited:await exec('/bin/ps',['-p',String(backendPid),'-o','pid='],{timeout:3000}).then(v=>!v.stdout.trim(),()=>true)});
 }}
finally{await fs.rm(dir,{recursive:true,force:true});}
await fs.writeFile('docs/native-backend-evidence/performance.json',JSON.stringify({at:new Date().toISOString(),scope:process.env.DEX_INCUMBENT_CHROME_APP?'three alternating rounds, 100 identical reads; actual incumbent index, preseeded telemetry-off config and existing browser cache, flags pointed to refused loopback':'controlled incumbent launcher',rows},null,2)+'\n');console.log(JSON.stringify(rows,null,2));
