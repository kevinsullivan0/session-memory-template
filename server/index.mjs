import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStorage } from './storage.mjs';
import { handleRequest } from '../lib/api.mjs';
export function createApp({directory='data',port=3210}={}) {
  const storage=openStorage(directory),env={...storage,PRINCIPAL_ID:'local-operator'};
  let origin;
  const server=createServer(async(req,res)=>{
    try {
      // Loopback binding alone does not prevent DNS rebinding. Pin the HTTP Host too.
      if(req.headers.host!==new URL(origin).host || (req.headers.origin && req.headers.origin!==origin)) {
        res.writeHead(403);res.end('Local same-origin access required.');return;
      }
      const url=new URL(req.url,origin);
      let response;
      if(url.pathname.startsWith('/api/')) {
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024){res.writeHead(413);res.end('Request too large.');return;}chunks.push(chunk);}
        const body=Buffer.concat(chunks), headers=new Headers();
        for(const [k,v] of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
        response=await handleRequest(new Request(url,{method:req.method,headers,...(req.method==='GET'||req.method==='HEAD'?{}:{body})}),env,{userId:env.PRINCIPAL_ID});
      } else {
        if(req.method!=='GET'){res.writeHead(405);res.end();return;}
        const assets={'/app.js':['app.js','text/javascript'],'/app.js.LEGAL.txt':['app.js.LEGAL.txt','text/plain'],'/style.css':['style.css','text/css'],'/':['index.html','text/html'],'/find':['index.html','text/html']};
        const item=assets[url.pathname];
        if(!item){res.writeHead(404);res.end('Not found.');return;}
        response=new Response(await readFile(resolve('dist',item[0])),{headers:{'Content-Type':`${item[1]}; charset=utf-8`}});
      }
      response.headers.set('Cache-Control','no-store');
      response.headers.set('X-Content-Type-Options','nosniff');
      response.headers.set('Referrer-Policy','no-referrer');
      response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)for await(const chunk of response.body)res.write(chunk);
      res.end();
    } catch {if(!res.headersSent)res.writeHead(500);res.end('Local operation failed.');}
  });
  return {server,storage,start:()=>new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;resolve(origin);});
  }),close:()=>new Promise((resolve,reject)=>server.close(error=>{storage.close();error?reject(error):resolve();}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const port=Number(process.env.PORT||3210);
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Choose a port from 1024 to 65535.');
  const app=createApp({directory:process.env.SESSION_MEMORY_DATA||'data',port});
  console.log(`Session memory: ${await app.start()} (local operator only)`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
