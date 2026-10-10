import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fixture } from './helpers/recovery-fixture.js';
import { inspectCoverage, verifyCoverage, publicCoverage, familyRegistry } from '../scripts/lib/recovery-coverage.js';
import { inspectLink, defaultLinkPolicy, type LinkPolicy } from '../scripts/lib/recovery-symlinks.js';
import { SNAPSHOT_WRITERS, SyntheticWriterCohort, validateBoundary, liveSnapshotEligibility } from '../scripts/lib/recovery-consistency.js';
import { captureSynthetic, inspectSyntheticTransaction, liveCapture, isSyntheticCaptureReceipt } from '../scripts/lib/recovery-capture.js';
import { recoveryStoragePlan } from '../scripts/lib/recovery-storage.js';
import { destinationBlockers, type DestinationFacts } from '../scripts/lib/recovery-destination.js';
import { describeTaskEvidence, type Evidence } from '../scripts/lib/recovery-reconciliation.js';
import { retainedProvenanceBlockers, RETAINED_SOURCE, RETAINED_TRANSACTION, validateLiveBoundaryEvidence } from '../scripts/lib/c14-recovery-preflight.js';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { TaskEventLog } from '../src/shared/task-events.js';
import { appendReceipt } from '../src/shared/receipts.js';

const nodeId = 'macbook-air.local', hash = 'a'.repeat(64);
const policy: LinkPolicy = { version: 1, rules: [{ prefix: 'plans/', boundary: 'plans', role: 'internal-alias', requiredTarget: true }] };
async function ready(w: Awaited<ReturnType<typeof fixture>>, linkPolicy?: LinkPolicy) {
  const cohort = new SyntheticWriterCohort(w); for (const writer of SNAPSHOT_WRITERS) cohort.checkpoint(writer);
  const boundary = await cohort.freeze(linkPolicy);
  const root = path.join(w.directory, 'backups'); await fs.mkdir(root, { mode: 0o700 });
  const st = await fs.lstat(root), v = await fs.statfs(root);
  const facts: DestinationFacts = { root, approvedRoot: root, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'synthetic-volume', approvedMountIdentity: 'synthetic-volume', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space: recoveryStoragePlan(boundary.manifest), sources: w.source, gitRoots: ['/synthetic/git'] };
  return { cohort, boundary, facts };
}
for (const kind of ['internal', 'dependency', 'directory']) test(`supported ${kind} links preserve topology and independently covered targets`, async () => {
  const w = await fixture(); try {
    const prefix = kind === 'dependency' ? 'runtime/releases/synthetic/node_modules' : 'plans';
    await fs.mkdir(path.join(w.source.state, prefix, 'pkg'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(w.source.state, prefix, 'pkg/file.txt'), 'synthetic', { mode: 0o600 });
    const link = `${prefix}/alias`; await fs.symlink(kind === 'directory' ? 'pkg' : 'pkg/file.txt', path.join(w.source.state, link));
    const m = await inspectCoverage(w.source, 'synthetic', kind === 'dependency' ? defaultLinkPolicy() : policy);
    assert.deepEqual(m.problems, []); assert.equal(m.entries.find(e => e.relative === link)!.kind, 'link');
    await verifyCoverage(m, w.source, m.digest);
    assert.ok(!JSON.stringify(publicCoverage(m)).includes('pkg/file.txt'));
  } finally { await w.cleanup(); }
});
for (const kind of ['absolute', 'traversal', 'cycle', 'dangling', 'unapproved', 'hidden-directory', 'swapped-target', 'changed-inode', 'changed-restored-target']) test(`symlink policy refuses ${kind}`, async () => {
  const w = await fixture(); try {
    await fs.writeFile(path.join(w.source.state, 'plans/target.txt'), 'synthetic', { mode: 0o600 });
    const link = path.join(w.source.state, 'plans/alias');
    if (kind === 'absolute') await fs.symlink('/Users/andrew/.dex-reach/secrets.env', link);
    else if (kind === 'traversal') await fs.symlink('../secrets.env', link);
    else if (kind === 'cycle') await fs.symlink('alias', link);
    else if (kind === 'dangling') await fs.symlink('absent', link);
    else if (kind === 'hidden-directory') await fs.symlink('../nodes', link);
    else await fs.symlink('target.txt', link);
    if (['swapped-target', 'changed-inode', 'changed-restored-target'].includes(kind)) {
      const m = await inspectCoverage(w.source, 'synthetic', policy); await fs.unlink(link); await fs.symlink(kind === 'changed-inode' ? 'target.txt' : 'fixture.json', link);
      if (kind === 'changed-inode') { const cohort = new SyntheticWriterCohort(w); for (const writer of SNAPSHOT_WRITERS) cohort.checkpoint(writer); const boundary = await cohort.freeze(policy); await fs.unlink(link); await fs.symlink('target.txt', link); await assert.rejects(validateBoundary(boundary,w)); }
      else await assert.rejects(verifyCoverage(m, w.source, m.digest));
    } else await assert.rejects(inspectLink(w.source.state, 'plans/alias', kind === 'unapproved' ? defaultLinkPolicy() : policy));
  } finally { await w.cleanup(); }
});
test('historical family registry is narrow and missing/new contents cannot disappear', async () => {
  const w = await fixture(); try {
    const name = 'macos-hardening-rollback-a1B2c3'; await fs.mkdir(path.join(w.source.state,name),{mode:0o700});
    for (const role of ['coordinator','worker','gateway','node','oauth-canary']) await fs.writeFile(path.join(w.source.state,name,`com.stinkyweasel.dex-reach.${role}.plist`),'synthetic',{mode:0o600});
    const m = await inspectCoverage(w.source,'synthetic'); assert.deepEqual(m.problems,[]);
    assert.equal(familyRegistry([name]).families.find(f=>f.relative===name)!.category,'HISTORICAL_PRESERVATION');
    await fs.writeFile(path.join(w.source.state,'new-authority.json'),'{}',{mode:0o600}); await assert.rejects(verifyCoverage(m,w.source,m.digest));
    assert.ok((await inspectCoverage(w.source)).families.some(f=>f.status==='UNKNOWN'));
  } finally { await w.cleanup(); }
});
test('synthetic capture certifies captured bytes and restored links end to end', async () => {
  const w = await fixture(); try {
    await fs.symlink('fixture.json',path.join(w.source.state,'plans/alias'));
    const {boundary,facts}=await ready(w,policy), receipt=await captureSynthetic(w,boundary,facts);
    assert.equal(receipt.scope,'synthetic'); assert.equal(receipt.installationAuthority,false); assert.ok(isSyntheticCaptureReceipt(receipt)); assert.ok(!isSyntheticCaptureReceipt(JSON.parse(JSON.stringify(receipt))));
    assert.equal(await fs.readlink(path.join(facts.root,boundary.transactionId,'state/plans/alias')),'fixture.json');
    assert.equal((await inspectSyntheticTransaction(w,boundary)).state,'CERTIFIED');
    await assert.rejects(captureSynthetic(w,boundary,facts),/TRANSACTION_ALREADY/);
  } finally { await w.cleanup(); }
});
for (const fault of ['interrupt','lost-response'] as const) test(`capture ${fault} reconciles without blind repeat`,async()=>{
  const w=await fixture();try{const{boundary,facts}=await ready(w);await assert.rejects(captureSynthetic(w,boundary,facts,fault));
    const r=await inspectSyntheticTransaction(w,boundary);assert.equal(r.state,fault==='interrupt'?'UNCERTAIN':'CERTIFIED');assert.equal(r.retryAuthorized,false);
    await assert.rejects(captureSynthetic(w,boundary,facts),/TRANSACTION_ALREADY/);
  }finally{await w.cleanup();}
});
for (const fault of ['task','result','receipt','event','policy','claim','rename','same-size','mtime-restored','process-death','incomplete-checkpoint','mismatched-generation','partial-writer']) test(`snapshot boundary refuses ${fault} during or after capture`,async()=>{
  const w=await fixture();try{
    const cohort=new SyntheticWriterCohort(w);
    if(fault==='incomplete-checkpoint'){cohort.checkpoint('receipts');await assert.rejects(cohort.freeze());return;}
    for(const writer of SNAPSHOT_WRITERS)cohort.checkpoint(writer);
    const boundary=await cohort.freeze();
    if(fault==='process-death'){cohort.writerDied();await assert.rejects(validateBoundary(boundary,w));return;}
    if(fault==='mismatched-generation'){await assert.rejects(validateBoundary({...boundary,generation:boundary.generation+1},w));return;}
    if(fault==='partial-writer'){await assert.rejects(cohort.write('tasks-results-events',async()=>{}),/ADMISSION/);return;}
    const paths:Record<string,string>={task:'tasks/store.json',result:'results/manifest.json',receipt:`receipts/${nodeId}.jsonl`,event:'tasks/events.jsonl',policy:`nodes/${nodeId}.access.json`,claim:'coordinator/leases/new.json',rename:'plans/fixture.json','same-size':'secrets.env','mtime-restored':'secrets.env'};
    const file=path.join(w.source.state,paths[fault]!);
    if(fault==='rename')await atomicWriteFile(file,'{"version":1,"fixture":true}',0o600);
    else if(fault==='same-size'||fault==='mtime-restored'){const st=await fs.stat(file),b=await fs.readFile(file);b[0]=b[0]===65?66:65;await fs.writeFile(file,b);if(fault==='mtime-restored')await fs.utimes(file,st.atime,st.mtime);}
    else if(fault==='claim')await fs.writeFile(file,'{}',{mode:0o600});
    else await fs.appendFile(file,'\n{}');
    await assert.rejects(validateBoundary(boundary,w));
    await assert.rejects(cohort.freeze());
  }finally{await w.cleanup();}
});
for (const writer of SNAPSHOT_WRITERS) test(`active concurrent writer ${writer} blocks capture and requires fresh checkpoints`,async()=>{
  const w=await fixture();try{const cohort=new SyntheticWriterCohort(w);let release!:()=>void,started!:()=>void;
    const start=new Promise<void>(r=>{started=r;}), hold=new Promise<void>(r=>{release=r;});
    const writing=cohort.write(writer,async()=>{started();await hold;await atomicWriteFile(path.join(w.source.state,'plans/fixture.json'),'{"version":1,"fixture":true}');});await start;
    await assert.rejects(cohort.freeze());release();await writing;
    await assert.rejects(cohort.freeze());for(const p of SNAPSHOT_WRITERS)cohort.checkpoint(p);const b=await cohort.freeze();await validateBoundary(b,w);
  }finally{await w.cleanup();}
});
const destinationFaults: Record<string,(f:DestinationFacts)=>void>={unknownVolume:f=>{f.approvedDevice=-1;},wrongMount:f=>{f.mountIdentity='other';},reserve:f=>{f.space.reserveBytes=0;},unknownSize:f=>{f.measured=false;},unapproved:f=>{f.approved=false;},sourceOverlap:f=>{f.root=f.sources.state;f.approvedRoot=f.root;},git:f=>{f.gitRoots=[f.root];},cloud:f=>{f.cloudSynced=true;},permissions:f=>{f.mode=0o755;},changedIdentity:f=>{f.approvedInode++;},capacity:f=>{f.freeBytes=1;},encryption:f=>{f.encrypted=false;},durability:f=>{f.durable=false;}};
for(const [fault,alter]of Object.entries(destinationFaults))test(`destination admission refuses ${fault}`,async()=>{const w=await fixture();try{const{boundary,facts}=await ready(w);alter(facts);assert.ok(destinationBlockers(facts).length);await assert.rejects(captureSynthetic(w,boundary,facts));assert.deepEqual(await fs.readdir(path.join(w.directory,'backups')),[]);}finally{await w.cleanup();}});
test('destination symlink and underestimated budget refuse without copy',async()=>{const w=await fixture();try{const{boundary,facts}=await ready(w);facts.space.backupBytes=1;await assert.rejects(captureSynthetic(w,boundary,facts),/BUDGET/);facts.space=recoveryStoragePlan(boundary.manifest);await fs.rmdir(facts.root);await fs.symlink(w.source.state,facts.root);await assert.rejects(captureSynthetic(w,boundary,facts),/SYMLINK/);}finally{await w.cleanup();}});
const ev:Evidence={result:'missing',activity:false,lease:false,ticket:false,process:'unknown',sharedProcess:false,stale:true,complete:true};
for(const kind of ['ambiguous','conflicting','live-pid','absent-pid','delayed-result','corrupt-result','cross-task','cross-node','duplicate-evidence','missing-idempotency'])test(`task evidence ${kind} preserves authority and uncertainty`,()=>{
  const e={...ev},t={state:'RUNNING' as const,failureClass:undefined as string|undefined,idempotencyKey:'private-synthetic'},receipts:Array<{nodeId:string;resultHash:string;ok:boolean}>=[];
  if(kind==='ambiguous')t.failureClass='AMBIGUOUS_EFFECT';if(kind==='live-pid')e.process='matching';if(kind==='absent-pid')e.process='absent';if(kind==='delayed-result')e.result='verified';if(kind==='corrupt-result')e.result='invalid-or-expired';if(kind==='missing-idempotency')t.idempotencyKey='';
  if(['conflicting','duplicate-evidence','cross-task','cross-node'].includes(kind))receipts.push({nodeId:kind==='cross-node'?'other':nodeId,resultHash:hash,ok:true},{nodeId,resultHash:'b'.repeat(64),ok:false});
  const r=describeTaskEvidence(t,e,receipts);assert.equal(r.replayAuthorized,false);assert.equal(r.EXTERNAL_EFFECT_PROOF,'UNPROVEN');assert.equal(r.OWNER_DECISION_REQUIRED,true);assert.ok(!JSON.stringify(r).includes(hash));
});
test('live boundary, approval JSON and synthetic tokens cannot become maintenance authority',()=>{
  assert.equal(liveSnapshotEligibility().eligible,false);assert.throws(liveCapture);
  const forged:any={scope:'live',version:1,symlinkPolicy:true,knownFamilies:true,consistency:true,manifestTrust:true,destination:true,durableBackup:true,restore:true,taskDisposition:true,provenance:true,candidateIdentity:true};
  assert.ok(Object.values(validateLiveBoundaryEvidence(forged)).every(v=>!v));forged.scope='synthetic';assert.ok(Object.values(validateLiveBoundaryEvidence(forged)).every(v=>!v));
});
for(const fault of ['source','journal','dependency','config','policy','coverage','incomplete','metadata','reserve'])test(`retained provenance refuses ${fault}`,()=>{
  const p={sourceSha:RETAINED_SOURCE,installTransaction:RETAINED_TRANSACTION,dependencyDigest:hash,configDigest:hash,expectedConfigDigest:hash,policyDigest:hash,expectedPolicyDigest:hash,ownerManifestDigest:hash,trustedManifestDigest:hash,snapshotComplete:true,metadataVerified:true,reserveVerified:true};
  assert.deepEqual(retainedProvenanceBlockers(p),[]);
  if(fault==='source')p.sourceSha='b'.repeat(40);if(fault==='journal')p.installTransaction=crypto.randomUUID();if(fault==='dependency')p.dependencyDigest='';if(fault==='config')p.configDigest='b'.repeat(64);if(fault==='policy')p.policyDigest='b'.repeat(64);if(fault==='coverage')p.trustedManifestDigest='b'.repeat(64);if(fault==='incomplete')p.snapshotComplete=false;if(fault==='metadata')p.metadataVerified=false;if(fault==='reserve')p.reserveVerified=false;
  assert.ok(retainedProvenanceBlockers(p).length);
});

test('partial canonical task writer failure poisons all subsequent snapshot attempts',async()=>{
  const w=await fixture();try{const c=new SyntheticWriterCohort(w);
    await assert.rejects(c.write('tasks-results-events',async()=>{await new NodeTaskStore(w.source.state).create({actorId:'synthetic',nodeId,operation:'dex.fingerprint',idempotencyKey:'partial',payloadSha256:hash});throw new Error('writer died before result commit');}));
    assert.throws(()=>c.checkpoint('tasks-results-events'));await assert.rejects(c.freeze());
  }finally{await w.cleanup();}
});
for(const kind of ['task','result','event','receipt','policy','coordinator'])test(`canonical ${kind} writer after freeze invalidates the frozen generation`,async()=>{
  const w=await fixture();const previous=process.env.DEX_REACH_STATE_DIR;process.env.DEX_REACH_STATE_DIR=w.source.state;
  try{const{boundary}=await ready(w),store=new NodeTaskStore(w.source.state),task=(await store.list())[0]!;
    if(kind==='task')await store.create({actorId:task.actorId,nodeId,operation:'dex.fingerprint',idempotencyKey:'racing',payloadSha256:hash});
    if(kind==='result'){const result=await new ResultStore(65536,60000,w.source.state).boundWithReference({race:true},task.taskId);await store.update(task.taskId,{resultRef:result.metadata.handle,resultHash:result.metadata.resultHash});}
    if(kind==='event')await new TaskEventLog(w.source.state).append({taskId:task.taskId,kind:'updated',state:task.state,actorId:task.actorId,nodeId,operation:task.operation,attempt:task.attemptNumber});
    if(kind==='receipt')await appendReceipt({nodeId,operation:task.operation,args:{},result:{race:true},ok:true,durationMs:1,policy:{}});
    if(kind==='policy'){const{updateAccessState}=await import('../src/shared/access.js');await updateAccessState(nodeId,s=>({...s,mode:'off'}),w.source.state);}
    if(kind==='coordinator')await atomicWriteFile(path.join(w.source.state,'coordinator/queue/racing.json'),JSON.stringify({id:'race',taskId:task.taskId,attempt:task.attemptNumber,pid:process.pid,executor:'codex',access:'read',workload:'light',enqueuedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString()}));
    await assert.rejects(validateBoundary(boundary,w));
  }finally{if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;await w.cleanup();}
});

test('exclusive capture reservation preserves a competing transaction directory',async()=>{
  const w=await fixture();try{const{boundary,facts}=await ready(w),root=path.join(facts.root,boundary.transactionId);await fs.mkdir(root,{mode:0o700});await fs.writeFile(path.join(root,'preserved'),'synthetic prior transaction',{mode:0o600});
    await assert.rejects(captureSynthetic(w,boundary,facts),/EEXIST/);assert.equal(await fs.readFile(path.join(root,'preserved'),'utf8'),'synthetic prior transaction');assert.equal((await inspectSyntheticTransaction(w,boundary)).state,'UNCERTAIN');
  }finally{await w.cleanup();}
});
test('nested directory entries and link parents sync before transaction certification',async(t)=>{
  const w=await fixture();try{await fs.symlink('fixture.json',path.join(w.source.state,'plans/alias'));const{boundary,facts}=await ready(w,policy),synced:string[]=[];
    const original=fs.open.bind(fs);t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args),sync=h.sync.bind(h);h.sync=async()=>{synced.push(String(args[0]));return sync();};return h;});
    await captureSynthetic(w,boundary,facts);const root=path.join(facts.root,boundary.transactionId);
    for(const d of boundary.manifest.directories){const p=path.join(root,d.root,d.relative);assert.ok(synced.includes(p),`not synced: ${d.root}/${d.relative}`);assert.ok(synced.indexOf(p)<synced.lastIndexOf(root));}
    assert.equal(synced.at(-1),facts.root);
  }finally{t.mock.restoreAll();await w.cleanup();}
});
test('cross-volume symlink hop refuses before capture',async(t)=>{
  const w=await fixture();try{const target=path.join(w.source.state,'plans/fixture.json');await fs.symlink('fixture.json',path.join(w.source.state,'plans/alias'));const original=fs.lstat.bind(fs);
    t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>{const st=await original(...args);if(String(args[0])===target)Object.defineProperty(st,'dev',{value:Number(st.dev)+1});return st;});
    await assert.rejects(inspectLink(w.source.state,'plans/alias',policy),/CROSS_VOLUME/);
  }finally{t.mock.restoreAll();await w.cleanup();}
});
test('captured restored link with a substituted target cannot reconcile as certified',async()=>{
  const w=await fixture();try{await fs.symlink('fixture.json',path.join(w.source.state,'plans/alias'));const{boundary,facts}=await ready(w,policy);await captureSynthetic(w,boundary,facts);
    const link=path.join(facts.root,boundary.transactionId,'state/plans/alias');await fs.unlink(link);await fs.symlink('absent',link);await assert.rejects(inspectSyntheticTransaction(w,boundary));
  }finally{await w.cleanup();}
});

test('expanded restore preserves lineage, budgets, plans, revocation, runtime and old/new reader authority',async()=>{
  const{expandedFixture}=await import('./helpers/recovery-fixture.js');const{rehearseRestore}=await import('../scripts/lib/recovery-rehearsal.js');
  const{decideExistingTask,retryAllowed}=await import('../src/shared/durable-execution.js');const{inspectBudgetPolicy}=await import('../src/shared/budget-policy.js');const{loadBudgetUsage}=await import('../src/shared/budget-usage.js');
  const{NodeAuthStore}=await import('../src/gateway/node-auth.js');const{consumePlan}=await import('../src/shared/plans.js');
  const{execFileSync}=await import('node:child_process');const{transpileModule,ModuleKind,ScriptTarget}=await import('typescript');const{pathToFileURL}=await import('node:url');
  const w=await expandedFixture(),previous=process.env.DEX_REACH_STATE_DIR;
  try{const m=await inspectCoverage(w.source,'synthetic');assert.deepEqual(m.problems,[]);const restored=await rehearseRestore(w,m,m.digest);
    const tasks=await new NodeTaskStore(restored.roots.state).list();assert.equal(tasks.length,3);assert.ok(tasks.some(t=>t.parentTaskId&&t.rootTaskId===t.parentTaskId));
    const oldDir=path.join(w.directory,'old-reader');await fs.mkdir(oldDir,{mode:0o700});
    for(const file of ['durable-execution','hash']){const source=execFileSync('git',['show',`87a99494ebb3:src/shared/${file}.ts`],{encoding:'utf8'});await fs.writeFile(path.join(oldDir,`${file}.js`),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText,{mode:0o600});}
    await fs.writeFile(path.join(oldDir,'package.json'),'{"type":"module"}',{mode:0o600});const old=await import(pathToFileURL(path.join(oldDir,'durable-execution.js')).href);
    const staged=new Set<string>();
    async function stage(file:string):Promise<void>{
      if(staged.has(file))return;staged.add(file);
      const source=execFileSync('git',['show',`87a99494ebb3:${file}`],{encoding:'utf8'}),output=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/from (['"])([^.'"][^'"]*)\1/g,(whole,quote,specifier)=>specifier.startsWith('node:')?whole:`from ${quote}${import.meta.resolve(specifier)}${quote}`);
      const destination=path.join(oldDir,file.replace(/\.ts$/,'.js'));await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,output,{mode:0o600});
      for(const match of output.matchAll(/from ['"](\.[^'"]+)['"]/g))await stage(path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]!.replace(/\.js$/,'.ts'))));
    }
    await stage('src/node/task-store.ts');await stage('src/node/result-store.ts');
    const oldTasks=await import(pathToFileURL(path.join(oldDir,'src/node/task-store.js')).href),oldResults=await import(pathToFileURL(path.join(oldDir,'src/node/result-store.js')).href);
    const historicalTasks=await new oldTasks.NodeTaskStore(restored.roots.state).list();assert.equal(historicalTasks.length,3);assert.deepEqual(historicalTasks.map((t:any)=>[t.taskId,t.actorId,t.nodeId,t.parentTaskId]),tasks.map(t=>[t.taskId,t.actorId,t.nodeId,t.parentTaskId]));

    const completed=tasks.find(t=>t.state==='COMPLETED')!,ambiguous=tasks.find(t=>t.state==='AMBIGUOUS')!;
    assert.equal(typeof old.decideExistingTask,'undefined'); // Historical reader lacks the newer duplicate-attachment gate.
    assert.equal(old.retryAllowed('PROCESS_UNKNOWN_EFFECT','AMBIGUOUS_EFFECT'),false);
    for(const reader of [{decideExistingTask,retryAllowed}]){
      const binding={existing:completed,actorId:completed.actorId,nodeId,operation:completed.operation,payloadSha256:completed.payloadSha256,policyHash:completed.policyHash??'unknown-policy'};
      assert.equal(reader.decideExistingTask(binding).kind,'RETURN_RESULT');assert.equal(reader.decideExistingTask({...binding,actorId:'other'}).kind,'COLLISION');assert.equal(reader.decideExistingTask({...binding,nodeId:'other'}).kind,'COLLISION');
      assert.equal(reader.decideExistingTask({...binding,existing:ambiguous,operation:ambiguous.operation}).kind,'REFUSE_AMBIGUOUS');assert.equal(reader.retryAllowed('PROCESS_UNKNOWN_EFFECT','AMBIGUOUS_EFFECT'),false);
    }
    // Old schema-1 store/result readers preserve identity and references; historical reader has no newer actor-bound attachment API.
    const historicalResultStore=new oldResults.ResultStore(65536,60000,restored.roots.state);
    assert.equal(typeof historicalResultStore.readValueForTask,'undefined');
    const historicalMetadata=await historicalResultStore.metadata(completed.resultRef!);assert.equal(historicalMetadata.taskId,completed.taskId);assert.equal(historicalMetadata.resultHash,completed.resultHash);
    assert.deepEqual(await historicalResultStore.readValue(completed.resultRef!),{synthetic:'child'});
    await new ResultStore(65536,60000,restored.roots.state).readValueForTask(completed.resultRef!,completed.taskId,completed.resultHash!);
    assert.equal((await inspectBudgetPolicy(nodeId,restored.roots.state)).policy.shared!.maxOperations,1);assert.equal((await loadBudgetUsage(nodeId,restored.roots.state)).samples[0]!.operations,1);
    const auth=new NodeAuthStore(restored.roots.state);await auth.initialize();assert.equal(await auth.isRevoked('revoked-synthetic-node'),true);assert.equal(await auth.authenticate('revoked-synthetic-node','synthetic-revoked-token'.repeat(4)),false);
    process.env.DEX_REACH_STATE_DIR=restored.roots.state;const plans=(await fs.readdir(path.join(restored.roots.state,'plans'))).filter(n=>n!== 'fixture.json'&&n.endsWith('.json'));assert.equal(plans.length,1);await assert.rejects(consumePlan(plans[0]!.slice(0,-5)),/already used or claimed/);
    const{boundary,facts}=await ready(w);assert.equal((await captureSynthetic(w,boundary,facts)).status,'SYNTHETIC_BACKUP_CERTIFIED');
  }finally{if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;await w.cleanup();}
});
for(const fault of ['event-state','event-actor','event-node','event-attempt','lineage','budget','claim','runtime','service','missing-runtime-evidence'])test(`expanded application restore refuses ${fault} even with a fresh content manifest`,async()=>{
  const{expandedFixture}=await import('./helpers/recovery-fixture.js');const{rehearseRestore}=await import('../scripts/lib/recovery-rehearsal.js');const w=await expandedFixture();
  try{const state=w.source.state,store=new NodeTaskStore(state),task=(await store.list()).find(t=>t.state==='COMPLETED')!;
    if(fault.startsWith('event-')){const file=path.join(state,'tasks/events.jsonl'),events=(await fs.readFile(file,'utf8')).trim().split('\n').map(l=>JSON.parse(l));const e=events.filter(e=>e.taskId===task.taskId).at(-1)!;if(fault==='event-state'){e.state='RUNNING';e.toState='RUNNING';}if(fault==='event-actor')e.actorId='other';if(fault==='event-node')e.nodeId='other';if(fault==='event-attempt')e.attempt=99;await fs.writeFile(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');}
    if(fault==='lineage'){const file=path.join(state,'tasks/store.json'),v=JSON.parse(await fs.readFile(file,'utf8'));v.records[task.taskId].rootTaskId='rtask_'+'1'.repeat(32);await fs.writeFile(file,JSON.stringify(v));}
    if(fault==='budget')await fs.writeFile(path.join(state,`nodes/${nodeId}.budget-usage.json`),'{"version":9}');
    if(fault==='claim'){const file=(await fs.readdir(path.join(state,'plans'))).find(n=>n.endsWith('.claim'))!;await fs.writeFile(path.join(state,'plans',file),'{}');}
    if(fault==='runtime')await fs.writeFile(path.join(state,'runtime/releases/synthetic-retained/package.json'),'{"version":"wrong"}');
    if(fault==='service')await fs.writeFile(path.join(w.source.agents,'com.stinkyweasel.dex-reach.worker.plist'),'<plist>mixed release</plist>');
    if(fault==='missing-runtime-evidence')await fs.unlink(path.join(state,'runtime/retained-evidence.json'));
    const m=await inspectCoverage(w.source,'synthetic');assert.deepEqual(m.problems,[]);await assert.rejects(rehearseRestore(w,m,m.digest));
  }finally{await w.cleanup();}
});
test('canonical expired plan sanitization restores without inventing a consumed claim',async()=>{
  const{createPlan,sweepExpiredPlans}=await import('../src/shared/plans.js');const{rehearseRestore}=await import('../scripts/lib/recovery-rehearsal.js');const w=await fixture(),previous=process.env.DEX_REACH_STATE_DIR;process.env.DEX_REACH_STATE_DIR=w.source.state;
  try{const p=await createPlan({nodeId,actor:null,operation:'dex.file.write',args:{path:'/synthetic/workspace/file',content:'synthetic'},policyHash:hash,checkpointId:null});await sweepExpiredPlans(Date.parse(p.expiresAt)+1);const m=await inspectCoverage(w.source,'synthetic');const r=await rehearseRestore(w,m,m.digest);const stored=JSON.parse(await fs.readFile(path.join(r.roots.state,'plans',p.id+'.json'),'utf8'));assert.equal(stored.used,true);assert.equal(stored.args.reason,'expired');await assert.rejects(fs.lstat(path.join(r.roots.state,'plans',p.id+'.claim')),/ENOENT/);
  }finally{if(previous===undefined)delete process.env.DEX_REACH_STATE_DIR;else process.env.DEX_REACH_STATE_DIR=previous;await w.cleanup();}
});
test('immutable dependencies and checkpoint payloads retain arbitrary bytes without pretending to be authority JSON',async()=>{
  const w=await fixture();try{for(const p of ['runtime/releases/synthetic/node_modules/pkg/options.json','checkpoints/synthetic/untracked/copied.json']){await fs.mkdir(path.dirname(path.join(w.source.state,p)),{recursive:true,mode:0o700});await fs.writeFile(path.join(w.source.state,p),'// arbitrary copied content\n{"version":"user-defined"}',{mode:0o600});}
    const m=await inspectCoverage(w.source,'synthetic');assert.deepEqual(m.problems,[]);await verifyCoverage(m,w.source,m.digest);assert.equal(m.entries.find(e=>e.relative.endsWith('options.json'))!.schema,undefined);
  }finally{await w.cleanup();}
});
for (const kind of ['extra-dex-reach-plist', 'renamed-dex-reach-plist', 'extra-worker-file', 'worker-subdirectory', 'worker-socket-not-socket']) test(`closed-world services/worker roots refuse ${kind}`, async () => {
  const w = await fixture(); try {
    if (kind === 'extra-dex-reach-plist') await fs.writeFile(path.join(w.source.agents, 'com.stinkyweasel.dex-reach.extra.plist'), '<plist/>', { mode: 0o600 });
    if (kind === 'renamed-dex-reach-plist') await fs.writeFile(path.join(w.source.agents, 'com.stinkyweasel.dex-reach.worker.plist.bak'), '<plist/>', { mode: 0o600 });
    if (kind === 'extra-worker-file') await fs.writeFile(path.join(w.source.worker, 'roots.override.json'), '{}', { mode: 0o600 });
    if (kind === 'worker-subdirectory') { await fs.mkdir(path.join(w.source.worker, 'state'), { mode: 0o700 }); await fs.writeFile(path.join(w.source.worker, 'state/x.json'), '{}', { mode: 0o600 }); }
    if (kind === 'worker-socket-not-socket') await fs.writeFile(path.join(w.source.worker, 'worker.sock'), 'not a socket', { mode: 0o600 });
    const m = await inspectCoverage(w.source, 'synthetic');
    assert.ok(m.problems.includes('UNKNOWN_OWNER_STATE_FAMILY')); assert.ok(m.families.some(f => f.status === 'UNKNOWN'));
    await assert.rejects(verifyCoverage(m, w.source, m.digest));
  } finally { await w.cleanup(); }
});
test('unrelated LaunchAgents outside the dex-reach namespace are not owner-state families', async () => {
  const w = await fixture(); try {
    await fs.writeFile(path.join(w.source.agents, 'com.example.unrelated.plist'), '<plist/>', { mode: 0o600 });
    const m = await inspectCoverage(w.source, 'synthetic'); assert.deepEqual(m.problems, []);
  } finally { await w.cleanup(); }
});
test('duplicate or unfinished hosted check runs cannot be masked by a later success', async () => {
  const { aggregateCheckRuns } = await import('../scripts/lib/c14-recovery-preflight.js');
  const ok = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
  assert.equal(aggregateCheckRuns([ok('validate')]).validate, 'SUCCESS');
  assert.equal(aggregateCheckRuns([{ name: 'validate', status: 'COMPLETED', conclusion: 'FAILURE' }, ok('validate')]).validate, 'AMBIGUOUS');
  assert.equal(aggregateCheckRuns([{ name: 'validate', status: 'IN_PROGRESS', conclusion: '' }, ok('validate')]).validate, 'AMBIGUOUS');
  assert.equal(aggregateCheckRuns([ok('validate'), ok('validate')]).validate, 'AMBIGUOUS');
  assert.equal(aggregateCheckRuns([{ name: 'validate', status: 'IN_PROGRESS', conclusion: 'SUCCESS' }]).validate, 'INCOMPLETE');
  assert.deepEqual(aggregateCheckRuns(undefined), {});
  assert.equal(aggregateCheckRuns([{ context: 'validate', state: 'SUCCESS' }]).validate, 'SUCCESS');
});
for (const target of ['.', '..', '../../node_modules']) test(`directory link to its own ancestor ${target} is a refused traversal cycle`, async () => {
  const w = await fixture(); try {
    const nm = path.join(w.source.state, 'runtime/releases/synthetic/node_modules/pkg'); await fs.mkdir(nm, { recursive: true, mode: 0o700 });
    await fs.symlink(target, path.join(nm, 'self'));
    await assert.rejects(inspectLink(w.source.state, 'runtime/releases/synthetic/node_modules/pkg/self', defaultLinkPolicy()), /LINK_CYCLE|LINK_ESCAPE/);
    assert.ok((await inspectCoverage(w.source, 'synthetic')).problems.length);
  } finally { await w.cleanup(); }
});
test('task report separates execution evidence and unresolved uncertainty without inferring termination or failure', () => {
  const base: Evidence = { result: 'missing', activity: false, lease: false, ticket: false, process: 'unknown', sharedProcess: false, stale: true, complete: true };
  const none = describeTaskEvidence({ state: 'PREPARING', failureClass: 'AMBIGUOUS_EFFECT', idempotencyKey: 'k' } as any, base, []);
  assert.deepEqual(none.EXECUTION_EVIDENCE, ['NONE_OBSERVED_NOT_TERMINATION_PROOF']);
  for (const u of ['TASK_BOUND_RESULT', 'RECEIPT_TASK_BINDING', 'EXTERNAL_EFFECT', 'PROCESS_LIVENESS', 'PERSISTED_AMBIGUOUS_EFFECT']) assert.ok(none.UNRESOLVED_UNCERTAINTY.includes(u), u);
  // A verified result and a live matching process still leave receipt binding and external effect unresolved.
  const strong = describeTaskEvidence({ state: 'RUNNING', idempotencyKey: 'k' } as any, { ...base, result: 'verified', process: 'matching', lease: true }, [{ nodeId: 'macbook-air.local', resultHash: 'a'.repeat(64), ok: true }]);
  assert.deepEqual(strong.EXECUTION_EVIDENCE, ['COORDINATOR_LEASE', 'MATCHING_PROCESS']);
  assert.deepEqual(strong.UNRESOLVED_UNCERTAINTY, ['RECEIPT_TASK_BINDING', 'EXTERNAL_EFFECT']);
  assert.equal(strong.replayAuthorized, false); assert.equal(strong.EXTERNAL_EFFECT_PROOF, 'UNPROVEN');
  const lost = describeTaskEvidence({ state: 'RUNNING', idempotencyKey: '' } as any, { ...base, process: 'absent', complete: false }, []);
  assert.deepEqual(lost.EXECUTION_EVIDENCE, ['RECORDED_PROCESS_ABSENT']); assert.equal(lost.RECEIPT_PROOF, 'MISSING');
  assert.ok(lost.UNRESOLVED_UNCERTAINTY.includes('EXTERNAL_EFFECT') && lost.UNRESOLVED_UNCERTAINTY.includes('IDEMPOTENCY_BINDING') && lost.UNRESOLVED_UNCERTAINTY.includes('EVIDENCE_INCOMPLETE'));
});
for (const kind of ['symlink-dotdot-escape', 'symlink-dotdot-dangling', 'nested-symlink-dotdot-escape']) test(`physical link resolution refuses ${kind} that lexical collapse would accept`, async () => {
  const w = await fixture(); try {
    const nm = path.join(w.source.state, 'runtime/releases/syn/node_modules');
    await fs.mkdir(path.join(nm, 'pkg/s/t'), { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(nm, 'q'), { mode: 0o700 });
    await fs.writeFile(path.join(nm, 'b'), 'inside', { mode: 0o600 }); await fs.writeFile(path.join(nm, 'pkg/b'), 'inside', { mode: 0o600 });
    await fs.writeFile(path.join(nm, '..', 'b'), 'outside', { mode: 0o600 });
    let link: string;
    if (kind === 'symlink-dotdot-escape') { await fs.symlink('../q', path.join(nm, 'pkg/a')); await fs.symlink('a/../../b', path.join(nm, 'pkg/L')); link = 'pkg/L'; }
    else if (kind === 'symlink-dotdot-dangling') { await fs.symlink('missing/../b', path.join(nm, 'pkg/L')); link = 'pkg/L'; }
    else { await fs.symlink('../../../q', path.join(nm, 'pkg/s/t/a')); await fs.symlink('t/a/../../b', path.join(nm, 'pkg/s/L')); link = 'pkg/s/L'; }
    const relative = `runtime/releases/syn/node_modules/${link}`;
    // The kernel's own resolution is the ground truth the policy must agree with.
    const kernel = await fs.realpath(path.join(w.source.state, relative)).catch(() => 'ENOENT');
    assert.ok(kernel === 'ENOENT' || !kernel.startsWith(await fs.realpath(nm) + path.sep));
    await assert.rejects(inspectLink(w.source.state, relative, defaultLinkPolicy()));
  } finally { await w.cleanup(); }
});
test('accepted links resolve to exactly the target the kernel resolves', async () => {
  const w = await fixture(); try {
    const base = 'runtime/releases/syn/node_modules', nm = path.join(w.source.state, base);
    await fs.mkdir(path.join(nm, 'pkg/bin'), { recursive: true, mode: 0o700 }); await fs.mkdir(path.join(nm, '.bin'), { mode: 0o700 });
    await fs.writeFile(path.join(nm, 'pkg/bin/cli.js'), 'synthetic', { mode: 0o700 });
    await fs.symlink('../pkg/bin/cli.js', path.join(nm, '.bin/cli'));
    await fs.symlink('pkg', path.join(nm, 'alias')); await fs.symlink('../alias/bin/./cli.js', path.join(nm, '.bin/via-alias'));
    await fs.symlink('../alias/bin/../bin/cli.js', path.join(nm, '.bin/via-alias-dotdot'));
    for (const name of ['.bin/cli', '.bin/via-alias', '.bin/via-alias-dotdot', 'alias']) {
      const r = await inspectLink(w.source.state, `${base}/${name}`, defaultLinkPolicy());
      assert.equal(path.join(await fs.realpath(w.source.state), r.resolvedRelative), await fs.realpath(path.join(nm, name)), name);
    }
  } finally { await w.cleanup(); }
});
test('a path vanishing inside an optional family is a problem, never a silent policy exclusion', async (t) => {
  const w = await fixture(); try {
    await fs.mkdir(path.join(w.source.state, 'traces'), { mode: 0o700 });
    for (const name of ['a.json', 'b.json', 'c.json']) await fs.writeFile(path.join(w.source.state, 'traces', name), '{}', { mode: 0o600 });
    const vanished = path.join(w.source.state, 'traces', 'b.json'), real = fs.lstat;
    t.mock.method(fs, 'lstat', async (p: any, ...rest: any[]) => { if (String(p) === vanished) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return (real as any).call(fs, p, ...rest); });
    const m = await inspectCoverage(w.source, 'synthetic');
    assert.notEqual(m.families.find(f => f.id === 'traces')!.status, 'EXCLUDED_BY_POLICY');
    assert.ok(m.problems.length);
  } finally { t.mock.restoreAll(); await w.cleanup(); }
});
test('an absent optional family root is still a normal policy exclusion', async () => {
  const w = await fixture(); try {
    const m = await inspectCoverage(w.source, 'synthetic');
    assert.equal(m.families.find(f => f.id === 'traces')!.status, 'EXCLUDED_BY_POLICY'); assert.deepEqual(m.problems, []);
  } finally { await w.cleanup(); }
});
for (const kind of ['unexpected-file', 'in-flight-temp', 'lock', 'added-during-inspection']) test(`file-level family parent directory is closed-world: ${kind}`, async () => {
  const w = await fixture(); try {
    const dir = path.join(w.source.state, 'tasks');
    if (kind === 'unexpected-file') await fs.writeFile(path.join(dir, 'store.backup.json'), '{}', { mode: 0o600 });
    if (kind === 'in-flight-temp') await fs.writeFile(path.join(dir, 'store.json.123.abc.tmp'), '{}', { mode: 0o600 });
    if (kind === 'lock') await fs.writeFile(path.join(dir, 'store.lock'), '', { mode: 0o600 });
    if (kind === 'added-during-inspection') {
      const m = await inspectCoverage(w.source, 'synthetic'); assert.deepEqual(m.problems, []);
      await fs.writeFile(path.join(dir, 'late.json'), '{}', { mode: 0o600 });
      await assert.rejects(verifyCoverage(m, w.source, m.digest)); return;
    }
    const m = await inspectCoverage(w.source, 'synthetic'); assert.ok(m.problems.length, kind);
    await assert.rejects(verifyCoverage(m, w.source, m.digest));
  } finally { await w.cleanup(); }
});
test('a source write after the final directory sync still prevents certification', async (t) => {
  const w = await fixture(); try {
    const { boundary, facts } = await ready(w), real = fs.open; let mutated = false;
    t.mock.method(fs, 'open', async (p: any, ...rest: any[]) => {
      if (!mutated && String(p) === facts.root && rest[0] === 'r') { mutated = true; await fs.appendFile(path.join(w.source.state, 'audit.jsonl'), '{}\n'); }
      return (real as any).call(fs, p, ...rest);
    });
    await assert.rejects(captureSynthetic(w, boundary, facts)); assert.ok(mutated);
    t.mock.restoreAll();
    assert.notEqual((await inspectSyntheticTransaction(w, boundary).catch(() => ({ state: 'REFUSED' }))).state, 'CERTIFIED');
  } finally { t.mock.restoreAll(); await w.cleanup(); }
});
test('a tampered private manifest beside a certified capture refuses reconciliation', async () => {
  const w = await fixture(); try {
    const { boundary, facts } = await ready(w); await captureSynthetic(w, boundary, facts);
    const file = path.join(facts.root, boundary.transactionId, 'manifest.private.json');
    await fs.chmod(file, 0o600); await fs.writeFile(file, JSON.stringify({ ...boundary.manifest, totalBytes: 0 }));
    await assert.rejects(inspectSyntheticTransaction(w, boundary), /MANIFEST/);
  } finally { await w.cleanup(); }
});
test('in-state checkpoint control directory: only real sockets and this holder\'s fenced lock are runtime-only', async () => {
  const { withFencedLocks } = await import('../scripts/lib/recovery-coverage.js');
  const net = await import('node:net');
  const w = await fixture(); const cwd = process.cwd(); let server: import('node:net').Server | undefined; try {
    const control = path.join(w.source.state, 'checkpoint'); await fs.mkdir(control, { mode: 0o700 });
    // Listen by relative path: the absolute temporary path exceeds the platform socket-path limit.
    process.chdir(control); server = net.createServer(); await new Promise<void>(r => server!.listen('gateway.sock', () => r())); process.chdir(cwd);
    assert.deepEqual((await inspectCoverage(w.source, 'synthetic')).problems, []);
    const lock = path.join(control, 'holder.lock'); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 't' }), { mode: 0o600 });
    assert.ok((await inspectCoverage(w.source, 'synthetic')).problems.includes('checkpoint-control:TRANSIENT_WRITE_OR_LOCK_PRESENT'));
    assert.deepEqual((await withFencedLocks(new Set([lock]), () => inspectCoverage(w.source, 'synthetic'))).problems, []);
    // A lock naming another process is never exempt, even inside a fence.
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid + 1, createdAt: Date.now(), token: 't' }), { mode: 0o600 });
    assert.ok((await withFencedLocks(new Set([lock]), () => inspectCoverage(w.source, 'synthetic'))).problems.length);
    await fs.rm(lock); await fs.writeFile(path.join(control, 'node.sock'), 'not a socket', { mode: 0o600 });
    assert.ok((await inspectCoverage(w.source, 'synthetic')).problems.includes('UNKNOWN_OWNER_STATE_FAMILY'));
  } finally { process.chdir(cwd); await new Promise<void>(r => server ? server.close(() => r()) : r()); await w.cleanup(); }
});
