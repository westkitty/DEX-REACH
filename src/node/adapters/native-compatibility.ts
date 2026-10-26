import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {AdapterManifest, AdapterRegistry} from '../../shared/adapter-contract.js';
import {DesktopCommanderAdapter, loadDesktopCommanderManifest, type ResolvedAdapterSource} from './desktop-commander.js';

/** Independently packaged DEX backend. The production entry continues selecting the incumbent. */
export class NativeCompatibilityAdapter extends DesktopCommanderAdapter {
  constructor(registry: AdapterRegistry, private readonly packageRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../../dist/src/node/compat-runtime/' : '../compat-runtime/',import.meta.url))) {
    super(registry);
  }
  protected override async resolveSource(): Promise<ResolvedAdapterSource> {
    const root=await fs.realpath(this.packageRoot);
    const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')) as {name?:string;version?:string};
    if(pkg.name!=='@dex-reach/native-backend'||!pkg.version)throw new Error('native backend package identity mismatch');
    const hashes=JSON.parse(await fs.readFile(path.join(root,'source-hashes.json'),'utf8')) as Record<string,string>;
    const inventory=JSON.parse(await fs.readFile(path.join(root,'runtime-files.json'),'utf8')) as string[];
    const required=['package.json','runtime-files.json','LICENSE','NOTICE.md',...inventory.map(file=>'runtime/'+file)];
    if(new Set(required).size!==required.length || required.some(file=>!hashes[file]) ||
       Object.keys(hashes).some(file=>!required.includes(file)&&file!=='package-lock.json'))
      throw new Error('native backend source manifest incomplete');
    if(!hashes['runtime/index.js']||!hashes['runtime/server.js'])throw new Error('native backend entry manifest incomplete');
    for(const [relative,expected] of Object.entries(hashes)){
      if(path.isAbsolute(relative)||relative.split('/').includes('..'))throw new Error('invalid native source manifest path');
      const file=await fs.realpath(path.join(root,relative));
      if(!file.startsWith(root+path.sep))throw new Error('native backend source escapes package');
      const actual=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      if(actual!==expected)throw new Error('native backend source integrity mismatch: '+relative);
    }
    return {root,entry:path.join(root,'runtime/index.js'),version:pkg.version,sourceHash:crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
  }
  protected override manifestForSource(source:ResolvedAdapterSource):AdapterManifest {
    return {...loadDesktopCommanderManifest(source),source:'@dex-reach/native-backend'};
  }
  protected override runtimeEnvironment(home:string,allowedRoots:string[]):Record<string,string>{
    return {...super.runtimeEnvironment(home,allowedRoots),DEX_COMPAT_ALLOWED_ROOTS:JSON.stringify(allowedRoots),PUPPETEER_SKIP_DOWNLOAD:'true'};
  }
  protected override ownerConfigurationRequired():boolean{return false;}
  protected override verifyOfferedTools(offered:string[],admitted:Set<string>):void {
    super.verifyOfferedTools(offered,admitted);
    if(offered.length!==22||offered.some(name=>!admitted.has(name)))throw new Error('native backend offered a widened or incomplete surface');
  }
}
