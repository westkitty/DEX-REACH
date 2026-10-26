// DEX-owned stdio boundary: protocol output is separate from inherited handler diagnostics.
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Writable} from 'node:stream';
const protocolWrite=process.stdout.write.bind(process.stdout);
// Handlers may log command arguments or document contents. DEX owns redacted reporting upstream.
// Drop them without retaining a queue or sending raw values to remote clients.
for(const method of ['log','info','debug','warn','error'])console[method]=()=>{};
export class FilteredStdioServerTransport extends StdioServerTransport {
 constructor(){
  const output=new Writable({write(chunk,encoding,callback){protocolWrite(chunk,encoding,callback);}});
  super(process.stdin,output,{maxBufferSize:1024*1024});
  process.stdout.write=function(_chunk,encoding,callback){
   const done=typeof encoding==='function'?encoding:callback;
   if(done)done();
   return true;
  };
 }
}
