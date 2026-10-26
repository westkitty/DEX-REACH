// Build-only packaging. Never installs, launches, or activates a service.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(repo,'src/node/compat-runtime');
const flag=process.argv.indexOf('--destination');
if(flag<0||!process.argv[flag+1])throw new Error('--destination is required');
const destination=path.resolve(process.argv[flag+1]);
if(destination===source||destination.startsWith(source+path.sep))throw new Error('refusing source overwrite');
await fs.mkdir(destination,{recursive:false});
const files=JSON.parse(await fs.readFile(path.join(source,'runtime-files.json'),'utf8'));
const hashes={};
for(const name of ['package.json','runtime-files.json','LICENSE','NOTICE.md',...files.map(f=>'runtime/'+f)]) {
 if(path.isAbsolute(name)||name.split('/').includes('..'))throw new Error('invalid package path');
 const bytes=await fs.readFile(path.join(source,name));
 await fs.mkdir(path.dirname(path.join(destination,name)),{recursive:true});
 await fs.writeFile(path.join(destination,name),bytes);
 hashes[name]=createHash('sha256').update(bytes).digest('hex');
}
try {const bytes=await fs.readFile(path.join(source,'package-lock.json'));await fs.writeFile(path.join(destination,'package-lock.json'),bytes);hashes['package-lock.json']=createHash('sha256').update(bytes).digest('hex');}
catch(error){if(error.code!=='ENOENT')throw error;}
await fs.writeFile(path.join(destination,'source-hashes.json'),JSON.stringify(hashes,null,2)+'\n');
console.log(JSON.stringify({packaged:destination,files:Object.keys(hashes).length,dependencyInstall:false}));
