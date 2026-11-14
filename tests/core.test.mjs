import test from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStorage} from '../server/storage.mjs';
import {createApp} from '../server/index.mjs';
import {handleRequest} from '../lib/api.mjs';
import {processNext} from '../lib/transcription.mjs';
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'session-memory-test-')),storage=openStorage(dir);
 t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true});});
 const env={...storage,PRINCIPAL_ID:'operator'},user={userId:'operator'};
 const request=(path,body,who=user,headers={})=>handleRequest(new Request(`http://workspace.test/api/${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:'http://workspace.test','Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),env,who);
 const call=async(...args)=>{const r=await request(...args);return {status:r.status,body:await r.json()};};
 const policy={policy:'session-memory-v1',consentAccepted:true,processingAccepted:true,participants:['Participant'],independent:true,input:'microphone'};
 const start=async(sessionId='session',input='microphone')=>(await call('recorder/start',{...policy,sessionId,deviceId:'device',input})).body.recorder;
 const upload=async(lock,{text='synthetic encoded fixture',sequence=0,hash,sourceId='fixture',capturedAt=Date.now()}={})=>{
  const bytes=new TextEncoder().encode(text);hash??=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const meta={sessionId:lock.session_id,deviceId:lock.device_id,generation:lock.generation,sequence,kind:'audio',duration:1,sourceId,hash,capturedAt};
  const r=await handleRequest(new Request('http://workspace.test/api/evidence',{method:'POST',headers:{Origin:'http://workspace.test','Content-Type':'audio/webm','x-evidence-meta':JSON.stringify(meta)},body:bytes}),env,user);
  return {status:r.status,body:await r.json(),meta};
 };
 return {storage,call,request,start,upload,policy,dir,env};
}
test('authentication boundary, same-origin writes and removed integration paths fail closed',async t=>{
 const {call}=setup(t);
 assert.equal((await call('state',undefined,null)).status,401);
 assert.equal((await call('state',undefined,{userId:'outsider'})).status,403);
 assert.equal((await call('notes',{text:'blocked'},undefined,{Origin:'http://other.test'})).status,403);
 for(const path of ['worker/next','tasks/propose','members/invite','agent/update'])assert.equal((await call(path,{})).status,404);
});
test('independent inputs, repeated start, leases and stop/restart retain session identities',async t=>{
 const {call,start,policy}=setup(t),mic=await start();
 assert.equal(mic.generation,1);
 assert.equal((await call('recorder/start',{...policy,sessionId:'session',deviceId:'device'})).body.recorder.session_id,'session');
 assert.equal((await start('computer','computer')).status,'recording');
 assert.equal((await call('recorder/start',{...policy,sessionId:'duplicate',deviceId:'other'})).status,409);
 assert.equal((await call('recorder/renew',{sessionId:'session',deviceId:'wrong',generation:1})).status,409);
 const claim={sessionId:'session',deviceId:'device',generation:1};
 assert.equal((await call('recorder/release',claim)).body.released,true);
 assert.equal((await call('recorder/release',claim)).body.released,false);
 assert.equal((await start('second')).generation,2);
 assert.equal((await call('recorder/renew',claim)).status,409);
});
test('hash receipts, repeated uploads and source conflicts preserve original bytes',async t=>{
 const {start,upload,storage}=setup(t),lock=await start(),first=await upload(lock);
 assert.equal(first.status,200);assert.equal(first.body.stored,true);
 assert.equal((await upload(lock)).body.replayed,true);
 assert.equal((await upload(lock,{text:'different bytes'})).status,409);
 assert.equal((await upload(lock,{sequence:1,sourceId:'other',hash:'0'.repeat(64)})).status,409);
 assert.equal(storage.sql.prepare('SELECT count(*) AS n FROM evidence').get().n,1);
 const source=storage.sql.prepare('SELECT * FROM evidence').get();
 assert.equal(Buffer.from((await storage.BUCKET.get(source.object_key)).body).toString(),'synthetic encoded fixture');
 assert.equal(storage.sql.prepare('SELECT count(*) AS n FROM jobs').get().n,1);
});
test('late audio is held, review is versioned, local adapter results are searchable and exported',async t=>{
 const {start,upload,call,request,storage}=setup(t),lock=await start();
 await call('recorder/release',{sessionId:'session',deviceId:'device',generation:lock.generation});
 const receipt=await upload(lock);assert.equal(receipt.body.quarantined,true);
 assert.equal(await processNext(storage,async()=>{throw Error('must not run');}),null);
 assert.equal((await call('transcripts/attach',{id:'fixture',revision:1,text:'blocked'})).status,409);
 assert.equal((await call('evidence/review',{id:'fixture',hash:receipt.meta.hash,revision:1,policy:'session-memory-v1'})).status,200);
 await processNext(storage,async({bytes})=>{assert.ok(bytes.length);return 'Synthetic observation about a green triangle.';});
 const found=(await call('search?q=green')).body.sources;assert.equal(found.length,1);assert.equal(found[0].status,'ready');
 assert.equal(await processNext(storage,()=>{throw Error('must not repeat');}),null);
 assert.equal((await call('transcripts/attach',{id:'fixture',revision:1,text:'stale'})).status,409);
 assert.equal((await call('transcripts/attach',{id:'fixture',revision:found[0].revision,text:'Corrected triangle.'})).status,200);
 const jsonl=await (await request('transcripts?format=jsonl')).text();assert.equal(JSON.parse(jsonl).text,'Corrected triangle.');
 assert.match(await (await request('transcripts?format=md')).text(),/Corrected triangle/);
});
test('failed and interrupted transcription jobs recover without duplicate completion',async t=>{
 const {start,upload,storage}=setup(t);await upload(await start());
 await assert.rejects(processNext(storage,async()=>{throw Error('offline');}),/offline/);
 assert.equal(storage.sql.prepare('SELECT status FROM jobs').get().status,'pending');
 storage.sql.prepare("UPDATE jobs SET status='running',lease_until=0").run();
 const result=await processNext(storage,async()=> 'Recovered fixture');assert.equal(result.status,'done');
 assert.equal(storage.sql.prepare('SELECT attempts FROM jobs').get().attempts,2);
});
test('candidate review is explicit, source-linked and single-use',async t=>{
 const {call}=setup(t);await call('notes',{id:'note-fixture',text:'Possible next step.'});
 const candidate=await call('candidates/propose',{type:'DECISION_CANDIDATE',text:'Try a small test.',sourceId:'note-fixture'});
 const body={id:candidate.body.id,version:1};
 assert.equal((await call('decisions/confirm',body)).status,200);
 assert.equal((await call('decisions/confirm',body)).status,409);
 const state=(await call('state')).body;
 assert.equal(state.records.filter(r=>r.kind==='decision').length,1);
 assert.deepEqual(state.records.find(r=>r.kind==='decision').payload.sources,['note-fixture']);
});
test('persistent storage reopens audio and metadata after restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'session-memory-persist-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let storage=openStorage(dir);const key=`sources/fixture/${'a'.repeat(64)}`;
 await storage.BUCKET.put(key,new TextEncoder().encode('durable fixture'));
 storage.sql.prepare("INSERT INTO events(entity_id,type,payload,actor,created_at) VALUES('fixture','test','{}','test',1)").run();storage.close();
 storage=openStorage(dir);assert.equal(Buffer.from((await storage.BUCKET.get(key)).body).toString(),'durable fixture');assert.equal(storage.sql.prepare('SELECT count(*) AS n FROM events').get().n,1);storage.close();
});
test('ordinary HTTP route rejects hostile Host and Origin; serves browser app',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'session-memory-http-')),app=createApp({directory:dir,port:0}),origin=await app.start();
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const html=await fetch(origin);assert.equal(html.status,200);assert.match(await html.text(),/Session memory/);
 assert.equal((await fetch(`${origin}/api/state`)).status,200);
 assert.equal((await fetch(`${origin}/api/state`,{headers:{Origin:'http://hostile.test'}})).status,403);
 const hostileStatus=await new Promise((resolve,reject)=>{const req=httpRequest(`${origin}/api/state`,{headers:{Host:'hostile.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(hostileStatus,403);
 const post=await fetch(`${origin}/api/notes`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({id:'http-note',text:'HTTP path fixture'})});assert.equal(post.status,200);
 assert.equal((await fetch(`${origin}/api/source/http-note`)).status,200);
 assert.equal((await fetch(`${origin}/server/storage.mjs`)).status,404);
});

test('concurrent transcript corrections accept only one current revision',async t=>{
 const {call,start,upload}=setup(t);await upload(await start());
 const results=await Promise.all(['First correction.','Second correction.'].map(text=>call('transcripts/attach',{id:'fixture',revision:1,text})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});

test('a corrected source cannot confirm an older candidate; stale proposals can still be rejected',async t=>{
 const {call,start,upload}=setup(t);await upload(await start());
 const candidate=await call('candidates/propose',{type:'DECISION_CANDIDATE',text:'Proposed from original text.',sourceId:'fixture'});
 await call('transcripts/attach',{id:'fixture',revision:1,text:'Corrected source text.'});
 const body={id:candidate.body.id,version:1};
 assert.equal((await call('decisions/confirm',body)).status,409);
 assert.equal((await call('candidates/reject',body)).status,200);
 assert.equal((await call('state')).body.records.filter(r=>r.kind==='decision').length,0);
});
test('explicit retry reclaims an expired fourth attempt but cannot reset a live worker',async t=>{
 const {call,start,upload,storage}=setup(t);await upload(await start());
 storage.sql.prepare("UPDATE jobs SET status='running',attempts=4,lease_until=?").run(Date.now()+100000);
 await call('jobs/retry',{});assert.equal(storage.sql.prepare('SELECT attempts FROM jobs').get().attempts,4);
 storage.sql.prepare('UPDATE jobs SET lease_until=0').run();
 assert.equal(await processNext(storage,()=>assert.fail('must wait for retry')),null);
 await call('jobs/retry',{});
 assert.equal((await processNext(storage,async()=> 'Recovered fourth attempt.')).status,'done');
});
