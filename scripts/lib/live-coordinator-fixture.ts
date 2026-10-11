/** Isolated live-pair test host. Production coordinator protocol and persistence, synthetic sensors. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createCoordinatorHandler,handleCoordinatorSocket} from '../../src/coordinator/main.js';
import {coordinatorSocketPath} from '../../src/shared/work-coordinator.js';
import {stateDir} from '../../src/shared/local-env.js';
async function main(){
 const dir=await fs.realpath(stateDir());
 const marker=JSON.parse(await fs.readFile(path.join(dir,'live-pair-fixture.json'),'utf8')) as {stateRoot?:string};
 const ownerState=path.join(os.homedir(),'.dex-reach');
 if(marker.stateRoot!==dir || dir===ownerState || dir.startsWith(ownerState+path.sep))throw new Error('synthetic coordinator requires minted live-pair state');
 const handler=createCoordinatorHandler(async()=>({physicalMemoryBytes:64*1024**3,logicalCpuCount:16,loadAverage1m:0.5,memory:'healthy',thermal:'healthy',observed:{uncoordinatedHeavy:0,dexServices:0,processObservation:'observed'}}));
 const socketPath=coordinatorSocketPath();const server=net.createServer(socket=>handleCoordinatorSocket(socket,handler));
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await fs.chmod(socketPath,0o600);
 const stop=()=>server.close(()=>{void fs.rm(socketPath,{force:true}).finally(()=>process.exit(0));});
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
