// DEX runtime resource envelope; authorization remains with the node and validatePath.
import fs from 'node:fs/promises';
import {validatePath} from '../tools/filesystem.js';
export const READ_BUDGET_BYTES=16*1024*1024;
export const RESULT_BUDGET_BYTES=2*1024*1024;
export async function checkReadBudget(name,args){
 const paths=name==='read_file'&&!args.isUrl&&typeof args.path==='string'?[args.path]:
  name==='read_multiple_files'&&Array.isArray(args.paths)?args.paths:[];
 let total=0;
 for(const file of paths){
  if(typeof file!=='string')continue;
  let size;
  try{const canonical=await validatePath(file);size=(await fs.stat(canonical)).size;}
  catch{continue;} // Existing handlers preserve per-path missing/permission/refusal behavior.
  total+=size;
  if(total>READ_BUDGET_BYTES)throw new Error('DEX file-read budget exceeds 16 MiB; use bounded process/file inspection');
 }
}
export function checkResultBudget(result,name){
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>RESULT_BUDGET_BYTES){
  if(['start_process','read_process_output','interact_with_process'].includes(name)){
   // Keep the process identity prefix even when output floods during launch. Refusing a
   // launch response after spawning would hide the handle needed for reconciliation.
   const bounded={...result,content:(result.content??[]).map(block=>block.type==='text'?{...block,text:block.text.slice(0,65536)+'\n[DEX output truncated; use paginated read_process_output]'}:block)};
   if(Buffer.byteLength(JSON.stringify(bounded),'utf8')<=RESULT_BUDGET_BYTES)return bounded;
  }
  throw new Error('DEX tool output exceeds 2 MiB; request a smaller page');
 }
 return result;
}
