// Isolated black-box protocol comparison; never starts a DEX node or touches owner state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const exec = promisify(execFile);
const repo = process.cwd();
const fixture = JSON.parse(await fs.readFile('tests/fixtures/desktop-commander-0.2.52-remote-contract.json','utf8'));
const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dex-native-parity-')));
const report = {at:new Date().toISOString(),base:'274ba16e058e2b1e855a8ae4a5c30ad63ea81363',
 scope:'isolated backend protocol; incumbent launcher omits upstream download/flag startup; no production node executor proof',
 backends:{}, rows:[], failures:[], sourceHashes:{}};
for (const name of ['server.js','index.js','search-manager.js','terminal-manager.js','utils/capture.js','utils/trackTools.js','tools/pdf/markdown.js']) report.sourceHashes[name]=createHash('sha256').update(await fs.readFile(path.join(repo,'src/node/compat-runtime/runtime',name))).digest('hex');
const require = createRequire(path.join(repo,'src/node/compat-runtime/runtime/server.js'));
const {PDFDocument, StandardFonts} = require('pdf-lib');
const text = r => (r.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
const alive = pid => {try {process.kill(pid,0);return true;}catch{return false;}};
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ownerLocal = ['set_config_value','get_recent_tool_calls','give_feedback_to_desktop_commander','get_prompts','toString'];
const swift = path.join(parent,'parse.swift');
await fs.writeFile(swift,`import Foundation
import PDFKit
guard let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(2) }
print("pages=\\(doc.pageCount)")
print(doc.string ?? "")
`);
function normal(value, root) {
 return text(value).replaceAll(root,'<ROOT>').replaceAll(path.dirname(root),'<FIXTURE>').replace(/PID:?\s*\d+/gi,'PID <PID>')
 .replace(/\b(process|session) (\d+)\b/gi,'$1 <PID>').replace(/\bprocess (\d+)\b/gi,'process <PID>').replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g,'<TIME>').replace(/search_\d+_\d+/g,'<SEARCH>').replace(/Runtime: \d+ms/g,'Runtime: <TIME>')
 .replace(/\d+\.\d+ seconds/g,'<TIME>');
}
function normalizedResult(result,root,name) {
 if(name==='list_processes')return {scope:'host listing withheld',validLines:text(result).split('\n').filter(Boolean).every(line=>/^PID: \d+, Command: .*, CPU: .*, Memory: /.test(line))};
 const ignored=new Set(['currentClient','version','systemInfo','clientHistory','clientId','usageStats','featureFlags']);
 function walk(value,key=''){
  if(name==='get_config'&&ignored.has(key))return '<IDENTITY_OR_VOLATILE>';
  if(typeof value==='string'&&name==='get_config'&&value.startsWith('Current configuration:\n')) {try{return 'Current configuration:\n'+JSON.stringify(walk(JSON.parse(value.slice('Current configuration:\n'.length))));}catch{}}
  if(typeof value==='string')return normal({content:[{type:'text',text:value}]},root);
  if(Array.isArray(value))return value.map(child=>walk(child));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(k=>!(name==='get_config'&&ignored.has(k))).sort().map(k=>[k,walk(value[k],k)]));
  return value;
 }
 return walk(result);
}
for (const kind of ['incumbent','candidate']) {
 const home = path.join(parent,kind,'home'), root = path.join(parent,kind,'root');
 await fs.mkdir(path.join(home,'.claude-server-commander'),{recursive:true});
 await fs.mkdir(root,{recursive:true});
 await fs.writeFile(path.join(home,'.claude-server-commander/config.json'),JSON.stringify({
 allowedDirectories:[root],telemetryEnabled:false,defaultShell:'/bin/sh',blockedCommands:[],
 fileReadLineLimit:1000,fileWriteLineLimit:50,welcomeOnboardingEligible:false,pendingWelcomeOnboarding:false
 }));
 const file = path.join(root,'unicode é space.txt');
 await fs.writeFile(file,'alpha\r\nneedle é\r\nomega\n');
 await fs.writeFile(path.join(parent,kind,'outside.txt'),'outside sentinel');
 await fs.symlink(path.join(parent,kind,'outside.txt'),path.join(root,'escape'));
 const pdf = await PDFDocument.create(), font=await pdf.embedFont(StandardFonts.Helvetica);
 pdf.addPage().drawText('DEX independent PDF retained',{font});pdf.addPage().drawText('delete me',{font});
 await fs.writeFile(path.join(root,'input.pdf'),await pdf.save());
 let entry = process.env.DEX_NATIVE_PARITY_PACKAGE ? path.join(process.env.DEX_NATIVE_PARITY_PACKAGE,'runtime/index.js') : path.join(repo,'src/node/compat-runtime/runtime/index.js');
 if (kind === 'incumbent') {
  const dist=path.join(repo,'node_modules/@wonderwhy-er/desktop-commander/dist');
  entry=path.join(parent,kind,'reference.mjs');
  const url = file=>JSON.stringify(pathToFileURL(path.join(dist,file)).href);
  await fs.writeFile(entry,`global.disableOnboarding=true;
const {server}=await import(${url('server.js')});
const {configManager}=await import(${url('config-manager.js')});
await configManager.loadConfig();
await configManager.setValue('telemetryEnabled',false);
await configManager.setValue('allowedDirectories',${JSON.stringify([root])});
const {FilteredStdioServerTransport}=await import(${url('custom-stdio.js')});
const transport=new FilteredStdioServerTransport();global.mcpTransport=transport;
await server.connect(transport);
`);
 }
 if(kind==='incumbent'&&process.env.DEX_INCUMBENT_CHROME_APP){
  const app=await fs.realpath(process.env.DEX_INCUMBENT_CHROME_APP);
  await fs.access(path.join(app,'Contents/MacOS/Google Chrome for Testing'));
  const cache=path.join(home,'.claude-server-commander/puppeteer-cache/chrome/existing-reference/chrome-mac-arm64');
  await fs.mkdir(cache,{recursive:true});
  await fs.symlink(app,path.join(cache,'Google Chrome for Testing.app'));
  const originalIndex=path.join(repo,'node_modules/@wonderwhy-er/desktop-commander/dist/index.js');
  entry=path.join(parent,kind,'stock-reference.mjs');
  await fs.writeFile(entry,`import http from 'node:http';
const listen=http.Server.prototype.listen;
http.Server.prototype.listen=function(...args){
 if(args[0]&&typeof args[0]==='object')args[0]={...args[0],host:'127.0.0.1'};
 else if(typeof args[1]==='string')args[1]='127.0.0.1';
 else args.splice(1,0,'127.0.0.1');
 return listen.apply(this,args);
};
await import(${JSON.stringify(pathToFileURL(originalIndex).href)});
`);
 }
 const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--no-onboarding'],stderr:'pipe',cwd:root,
 env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,USER:os.userInfo().username,
 DEX_COMPAT_ALLOWED_ROOTS:JSON.stringify([root]),DEX_REACH_STATE_DIR:path.join(home,'dex-state'),
 PUPPETEER_SKIP_DOWNLOAD:'true',DC_FLAG_URL:'http://127.0.0.1:1/disabled'}});
 // Drain diagnostics; do not persist raw tool arguments or results.
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'dex-reach-parity',version:'1'});
 const owned=new Set(), records={}, metrics={latenciesMs:[]};
 report.backends[kind]={metrics,records};
 const started=performance.now();
 try {
  await client.connect(transport);
  metrics.startupMs=performance.now()-started;
  const listed=await client.listTools();
  metrics.schemaMatches=fixture.tools.filter(f=>JSON.stringify(listed.tools.find(t=>t.name===f.name)?.inputSchema)===JSON.stringify(f.inputSchema)).length;
  metrics.advertised=listed.tools.map(t=>t.name);
  try {metrics.rssKiB=Number((await exec('/bin/ps',['-p',String(transport.pid),'-o','rss='],{timeout:3000})).stdout.trim());}catch{metrics.rssKiB=null;}
  async function call(name,args={},label='success') {
   const t=performance.now();let result;
   try {result=await client.callTool({name,arguments:args},undefined,{timeout:15000});}
   catch(error){result={isError:true,content:[{type:'text',text:String(error)}]};}
   metrics.latenciesMs.push({name,label,ms:performance.now()-t});
   (records[name]??={})[label]={isError:!!result.isError,normalized:name === 'list_processes' ? '<process listing withheld: host-wide volatile data>' : normal(result,root),normalizedResult:normalizedResult(result,root,name)};
   return result;
  }
  const ok=async(name,args={})=>{
   const r=await call(name,args);
   if(r.isError)report.failures.push(kind+': '+name+' success failed: '+text(r).slice(0,240));
   return r;
  };
  await ok('get_config');
  await ok('read_file',{path:file,offset:1,length:1});
  await ok('read_multiple_files',{paths:[file,path.join(root,'missing')]});
  await ok('write_file',{path:path.join(root,'write.txt'),content:'one\ntwo é\n'});
  await call('write_file',{path:path.join(root,'write.txt'),content:'append\n',mode:'append'},'append');
  metrics.writtenContent=await fs.readFile(path.join(root,'write.txt'),'utf8');
  await ok('create_directory',{path:path.join(root,'new dir')});
  await ok('list_directory',{path:root,depth:1});
  await ok('move_file',{source:path.join(root,'write.txt'),destination:path.join(root,'moved.txt')});
  await ok('get_file_info',{path:file});
  await ok('edit_block',{file_path:path.join(root,'moved.txt'),old_string:'one',new_string:'ONE'});
  await ok('write_pdf',{path:path.join(root,'input.pdf'),outputPath:path.join(root,'output.pdf'),content:[{type:'delete',pageIndexes:[1]}]});
  try {
   const parsed=await exec('/usr/bin/swift',[swift,path.join(root,'output.pdf')],{timeout:60000,maxBuffer:1024*1024,
     env:{PATH:'/usr/bin:/bin',HOME:home,CLANG_MODULE_CACHE_PATH:path.join(home,'clang-cache')}});
   metrics.independentPdf={pass:parsed.stdout.includes('pages=1')&&parsed.stdout.includes('DEX independent PDF retained')&&!parsed.stdout.includes('delete me'),reader:'Apple PDFKit',output:parsed.stdout.trim()};
  }catch(e){metrics.independentPdf={pass:false,error:String(e).slice(0,400)};}
  // Additional format cases use real files, without browser installation.
  metrics.formats={};
  for(const [extension,content] of [['docx','# DEX title\nparagraph unicode é'],['xlsx','[["name","value"],["é space",42]]']]) {
   const document=path.join(root,'format.'+extension);
   const written=await call('write_file',{path:document,content},'format:'+extension);
   const read=await call('read_file',{path:document},'format:'+extension);
   let independentlyOpened=false;
   try {
    const member=extension==='docx'?'word/document.xml':'xl/worksheets/sheet1.xml';
    const reopened=await exec('/usr/bin/unzip',['-p',document,member],{timeout:5000});
    independentlyOpened=reopened.stdout.includes(extension==='docx'?'paragraph unicode':'42');
   }catch {}
   metrics.formats[extension]={write:!written.isError,read:!read.isError,independentContainerXml:independentlyOpened};
   if(written.isError||read.isError||!independentlyOpened)report.failures.push(kind+': '+extension+' format check failed');
  }
  const image=path.join(root,'image.png');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
  const imageWrite=await call('write_file',{path:image,content:png},'format:png');
  const imageRead=await call('read_file',{path:image},'format:png');
  const imageParsed=await exec('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',image],{timeout:5000});
  metrics.formats.png={write:!imageWrite.isError,read:!imageRead.isError,independentReader:imageParsed.stdout.includes('pixelWidth: 1')&&imageParsed.stdout.includes('pixelHeight: 1')};
  if(imageWrite.isError||imageRead.isError||!metrics.formats.png.independentReader)report.failures.push(kind+': PNG transform/reopen failed');
  metrics.malformedFormats={};
  for(const ext of ['pdf','docx','xlsx']){
   const bad=path.join(root,'malformed.'+ext);await fs.writeFile(bad,'malformed fixture bytes');
   const r=await call('read_file',{path:bad},'malformed:'+ext);
   metrics.malformedFormats[ext]=!!r.isError||/^Error reading PDF: Invalid PDF structure\./.test(text(r));
   if(!metrics.malformedFormats[ext])report.failures.push(kind+': malformed '+ext+' unexpectedly accepted');
  }
  const concurrent=path.join(root,'concurrent.txt');await fs.writeFile(concurrent,'');
  await Promise.all(['alpha','beta'].map(label=>call('write_file',{path:concurrent,content:label+'\n',mode:'append'},'concurrency:'+label)));
  metrics.concurrentAppend=(await fs.readFile(concurrent,'utf8')).trim().split('\n').sort().join(',')==='alpha,beta';
  if(!metrics.concurrentAppend)report.failures.push(kind+': concurrent append lost or corrupted content');
  const utf16=path.join(root,'utf16.txt');
  await fs.writeFile(utf16,Buffer.concat([Buffer.from([255,254]),Buffer.from('alpha\r\nneedle é\r\n','utf16le')]));
  const utfRead=await call('read_file',{path:utf16},'utf16');
  metrics.formats.utf16=!utfRead.isError&&text(utfRead).includes('needle é');
  const denied=path.join(root,'denied.txt');await fs.writeFile(denied,'permission sentinel');await fs.chmod(denied,0);
  const refused=await call('read_file',{path:denied},'permission');await fs.chmod(denied,0o600);
  metrics.permissionRefused=!!refused.isError;
  if(!metrics.permissionRefused)report.failures.push(kind+': permission boundary did not refuse');
  if(process.env.DEX_INCUMBENT_CHROME_APP){
   const markdownPath=path.join(root,'generated.pdf');
   const generated=await call('write_pdf',{path:markdownPath,content:'# DEX differential Markdown\n\nMarkdown retained text.'},'format:markdown');
   const parsed=await exec('/usr/bin/swift',[swift,markdownPath],{timeout:60000,env:{PATH:'/usr/bin:/bin',HOME:home,CLANG_MODULE_CACHE_PATH:path.join(home,'clang-cache')}});
   metrics.markdownPdf={success:!generated.isError,independentParse:parsed.stdout.includes('Markdown retained text.')};
   if(generated.isError||!metrics.markdownPdf.independentParse)report.failures.push(kind+': Markdown PDF differential transformation failed');
  }
  const search=await ok('start_search',{path:root,pattern:'needle',searchType:'content',timeout_ms:1000});
  const sid=/session: (\S+)/.exec(text(search))?.[1];
  if(sid) {
   await sleep(100);
   await ok('get_more_search_results',{sessionId:sid,offset:0,length:1});
   await ok('list_searches');
   await ok('stop_search',{sessionId:sid});
  } else report.failures.push(kind+': search handle missing');
  const fifo=path.join(root,'cancel-search.fifo');await exec('/usr/bin/mkfifo',[fifo],{timeout:3000});
  const active=await call('start_search',{path:fifo,pattern:'waiting',searchType:'content',timeout_ms:1000},'active-cancel');
  const activeId=/session: (\S+)/.exec(text(active))?.[1];
  const wasRunning=/Status: RUNNING/.test(text(active));
  let stopped=false;
  if(activeId){
   await call('stop_search',{sessionId:activeId},'active-cancel');
   await sleep(100);
   const after=await call('get_more_search_results',{sessionId:activeId},'active-cancel');
   stopped=/Status: COMPLETED/.test(text(after));
  }
  metrics.activeSearchCancellation={wasRunning,stopped};
  if(!wasRunning||!stopped)report.failures.push(kind+': active FIFO search cancellation was not proven');
  const p=await ok('start_process',{command:"printf 'ready\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",timeout_ms:100,shell:'/bin/sh'});
  const pid=Number(/PID\s+(\d+)/i.exec(text(p))?.[1]);
  if(pid>0) {
   owned.add(pid);
   await ok('read_process_output',{pid,timeout_ms:100});
   await ok('interact_with_process',{pid,input:'hello',timeout_ms:100,wait_for_prompt:false});
   await ok('list_sessions');await ok('list_processes');
   await ok('force_terminate',{pid});await call('force_terminate',{pid},'repeat');
  } else report.failures.push(kind+': process handle missing');
  const k=await ok('start_process',{command:'sleep 30',timeout_ms:100,shell:'/bin/sh'});
  const killPid=Number(/PID\s+(\d+)/i.exec(text(k))?.[1]);
  if(killPid>0) {owned.add(killPid);await ok('kill_process',{pid:killPid});}
  await ok('get_usage_stats');
  for(const name of fixture.tools.map(t=>t.name)) {
   const args={read_file:{path:path.join(root,'missing')},read_multiple_files:{paths:'invalid'},
    write_file:{path:file,content:42},write_pdf:{path:path.join(root,'missing.pdf'),content:[]},
    create_directory:{path:file},list_directory:{path:path.join(root,'missing')},
    move_file:{source:path.join(root,'missing'),destination:path.join(root,'absent')},
    get_file_info:{path:path.join(root,'missing')},edit_block:{file_path:file,old_string:'absent marker',new_string:'x'},
    start_search:{path:root,pattern:42,searchType:'content'},get_more_search_results:{sessionId:'invalid'},
    stop_search:{sessionId:'invalid'},start_process:{command:42,timeout_ms:1},
    read_process_output:{pid:2147483647,timeout_ms:1},interact_with_process:{pid:2147483647,input:'x',timeout_ms:1},
    force_terminate:{pid:2147483647},kill_process:{pid:2147483647}}[name];
   if(args) await call(name,args,'error');
  }
  for(const suffix of ['escape','../outside.txt']) await call('read_file',{path:path.join(root,suffix)},'boundary:'+suffix);
  const outside=path.join(parent,kind,'outside.txt');
  const boundaries={
   read_multiple_files:{paths:[file,outside]},write_file:{path:outside,content:'forbidden mutation'},
   write_pdf:{path:path.join(root,'input.pdf'),content:[],outputPath:path.join(parent,kind,'outside.pdf')},
   create_directory:{path:path.join(parent,kind,'outside-dir')},list_directory:{path:path.dirname(root)},
   move_file:{source:file,destination:path.join(parent,kind,'moved-outside')},
   get_file_info:{path:outside},edit_block:{file_path:outside,old_string:'outside sentinel',new_string:'forbidden'},
   start_search:{path:path.dirname(root),pattern:'needle',searchType:'content'}
  };
  metrics.fileBoundaries={};
  for(const [name,args]of Object.entries(boundaries)){
   const r=await call(name,args,'boundary');
   const refused=!!r.isError||/error|not.allowed|not.found|access denied|outside.*allowed/i.test(text(r));
   metrics.fileBoundaries[name]=refused&&!text(r).includes('outside sentinel');
   if(!metrics.fileBoundaries[name])report.failures.push(kind+': '+name+' boundary not refused');
  }
  if((await fs.readFile(outside,'utf8'))!=='outside sentinel')report.failures.push(kind+': outside file mutated');
  if((await fs.readFile(file,'utf8'))!=='alpha\r\nneedle é\r\nomega\n')report.failures.push(kind+': denied move changed source');
  if(kind==='candidate') {
   for(const name of ownerLocal) await call(name,name==='set_config_value'?{key:'allowedDirectories',value:[]}: {},'owner-refusal');
   const config=await call('get_config',{},'after-refusals');
   metrics.rootsUnchanged=JSON.stringify(config.structuredContent?.config?.allowedDirectories)===JSON.stringify([root]);
   metrics.ownerLocalRefused=ownerLocal.every(name=>records[name]['owner-refusal'].isError);
  }
  // Leave an owned synthetic child running to measure candidate shutdown cleanup.
  const residual=await ok('start_process',{command:'sleep 30',timeout_ms:100,shell:'/bin/sh'});
  const residualPid=Number(/PID\s+(\d+)/i.exec(text(residual))?.[1]);
  if(residualPid>0)owned.add(residualPid);
  const closeAt=performance.now();
  if(kind==='candidate'&&transport.pid)process.kill(transport.pid,'SIGTERM');
  await client.close();await sleep(150);
  metrics.shutdownMs=performance.now()-closeAt;
  metrics.remainingOwnedPids=[...owned].filter(alive);
 }catch(error){report.failures.push(kind+': harness '+String(error));}
 finally {
  await client.close().catch(()=>{});
  // Only handles returned by this isolated backend are eligible for cleanup.
  for(const pid of owned) {try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}}
 }
}
for (const tool of fixture.tools) {
 const a=report.backends.incumbent.records[tool.name],b=report.backends.candidate.records[tool.name];
 report.rows.push({tool:tool.name,schema:report.backends.candidate.metrics.schemaMatches===22?'PASS':'FAIL',
 success:a?.success&&!a.success.isError&&b?.success&&!b.success.isError?'PASS':'FAIL',
 normalizedText:tool.name !== 'list_processes' && a?.success&&b?.success&&a.success.normalized===b.success.normalized?'PASS':'UNVERIFIED',
 error:a?.error&&b?.error?(a.error.isError===b.error.isError &&
   (a.error.isError||(/error|failed|not.found|could not|cannot|no match|no active|does not exist/i.test(a.error.normalized)&&/error|failed|not.found|could not|cannot|no match|no active|does not exist/i.test(b.error.normalized)))?'PASS':a.error.isError!==b.error.isError?'FAIL':'UNVERIFIED'):'NOT_APPLICABLE: no parameter-dependent error',
 normalizedStructuredResult:a?.success&&b?.success&&JSON.stringify(a.success.normalizedResult)===JSON.stringify(b.success.normalizedResult)?'PASS':'UNVERIFIED',
 normalizedErrorText:a?.error&&b?.error&&a.error.normalized===b.error.normalized?'PASS':'UNVERIFIED',
 authorization:'UNVERIFIED: real node executor not exercised',lifecycle:'UNVERIFIED: extended cases pending',
 implementation:'DEX dispatcher; MIT-derived operation handlers',overall:'UNVERIFIED'});
}
for (const kind of ['incumbent','candidate']) {
 const b=report.backends[kind];
 if(b.metrics.schemaMatches!==22)report.failures.push(kind+': schema mismatch');
 if(!b.metrics.independentPdf?.pass)report.failures.push(kind+': independent PDF parse failed');
 for(const label of ['boundary:escape','boundary:../outside.txt'])
  if(!b.records.read_file?.[label]?.isError)report.failures.push(kind+': boundary accepted '+label);
}
const candidate=report.backends.candidate.metrics;
if(!candidate.ownerLocalRefused || !candidate.rootsUnchanged)report.failures.push('candidate: owner boundary failed');
if(candidate.remainingOwnedPids?.length)report.failures.push('candidate: shutdown left owned children');
report.incumbentEntry=process.env.DEX_INCUMBENT_CHROME_APP?'stock index with HTTP listeners forced to loopback; telemetry-off seeded; existing isolated browser cache; feature flag loopback refused':'controlled launcher';
// Search startup is explicitly progressive. Compare stable admission fields plus the completed
// continuation, rather than demanding identical scheduler-dependent initial result snapshots.
for(const row of report.rows){
 row.outputContract=row.normalizedStructuredResult==='PASS'?'PASS':'UNVERIFIED';
 if(row.tool==='start_search'&&row.outputContract!=='PASS'){
  const a=report.backends.incumbent.records,b=report.backends.candidate.records;
  const prefix=r=>r.start_search.success.normalized.split('Status:')[0];
  const final=r=>r.get_more_search_results.success;
  if(prefix(a)===prefix(b)&&!final(a).isError&&!final(b).isError&&
     JSON.stringify(final(a).normalizedResult)===JSON.stringify(final(b).normalizedResult)){
   row.asynchronousContinuation='PASS';row.outputContract='PASS';
  }
 }
 row.overall=row.schema==='PASS'&&row.success==='PASS'&&row.outputContract==='PASS'&&
  (row.error==='PASS'||row.error.startsWith('NOT_APPLICABLE'))?'PASS_RECORDED_CASES':'UNVERIFIED';
}

report.packageRoot=process.env.DEX_NATIVE_PARITY_PACKAGE??'source runtime';
if(process.env.DEX_NATIVE_PARITY_PACKAGE)report.packageSourceHashes=JSON.parse(await fs.readFile(path.join(process.env.DEX_NATIVE_PARITY_PACKAGE,'source-hashes.json'),'utf8'));
report.verdict=report.failures.length?'FAIL':report.rows.every(row=>row.overall==='PASS_RECORDED_CASES')?'PASS_RECORDED_CASES':'PARTIAL';
await fs.mkdir('docs/native-backend-evidence',{recursive:true});
await fs.writeFile('docs/native-backend-evidence/parity.json',JSON.stringify(report,null,2)+'\n');
await fs.rm(parent,{recursive:true,force:true});
console.log(JSON.stringify({verdict:report.verdict,rows:report.rows.length,failures:report.failures,metrics:Object.fromEntries(Object.entries(report.backends).map(([k,v])=>[k,v.metrics]))},null,2));
process.exitCode=report.failures.length?1:0;
