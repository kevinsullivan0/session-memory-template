import { DatabaseSync } from 'node:sqlite';
import { readFileSync,mkdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync } from 'node:fs';
import { readFile,stat } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
export function openStorage(directory) {
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
  const sql=new DatabaseSync(resolve(root,'memory.sqlite'));
  sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const prepare=(query,args=[])=>({
    bind:(...values)=>prepare(query,values),
    first:async()=>sql.prepare(query).get(...args)||null,
    all:async()=>({results:sql.prepare(query).all(...args)}),
    run:()=>({meta:sql.prepare(query).run(...args)})
  });
  const DB={prepare,batch:async statements=>{
    sql.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}
  }};
  const objectPath=key=>{
    if(!/^sources\/[a-zA-Z0-9_-]{1,100}\/[a-f0-9]{64}$/.test(key))throw Error('Invalid object key.');
    return resolve(root,'objects',key);
  };
  const BUCKET={
    put:async(key,bytes)=>{
      const path=objectPath(key);mkdirSync(dirname(path),{recursive:true,mode:0o700});
      const temporary=`${path}.${crypto.randomUUID()}.tmp`,fd=openSync(temporary,'wx',0o600);
      try{const {writeFileSync}=await import('node:fs');writeFileSync(fd,new Uint8Array(bytes));fsyncSync(fd);}finally{closeSync(fd);}
      try{renameSync(temporary,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}catch(e){try{unlinkSync(temporary);}catch{}throw e;}
    },
    head:async key=>{try{return await stat(objectPath(key));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    get:async key=>{try{return {body:await readFile(objectPath(key))};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  };
  return {DB,BUCKET,sql,close:()=>sql.close(),root};
}
