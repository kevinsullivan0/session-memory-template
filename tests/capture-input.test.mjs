import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireAudio,primeRecording,requestRecorder} from '../lib/capture-input.mjs';

class Stream {
 constructor(tracks){this.tracks=tracks;}
 getTracks(){return this.tracks;}
 getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}
}
const track=kind=>({kind,readyState:'live',stopped:false,stop(){this.stopped=true;}});
test('computer capture requests sharing immediately and records only audio, without a microphone fallback',async()=>{
 const audio=track('audio'),video=track('video');let requested=false;
 const promise=acquireAudio('computer',{mediaDevices:{getDisplayMedia(options){requested=true;assert.equal(options.audio.suppressLocalAudioPlayback,false);assert.ok(options.video);return Promise.resolve(new Stream([video,audio]));},getUserMedia(){throw Error('Microphone must not be requested');}},Stream});
 assert.equal(requested,true);
 const result=await promise;
 assert.deepEqual(result.audio.getTracks(),[audio]);
 assert.deepEqual(result.capture.getTracks(),[video,audio]);
});
test('missing shared audio closes the selected stream and fails instead of recording silence or microphone',async()=>{
 const video=track('video');
 await assert.rejects(acquireAudio('computer',{mediaDevices:{getDisplayMedia:async()=>new Stream([video]),getUserMedia(){throw Error('wrong input');}},Stream}),/share audio|no audio/i);
 assert.equal(video.stopped,true);
 await assert.rejects(acquireAudio('computer',{mediaDevices:{},Stream}),/browser/i);
});
test('microphone mode uses the microphone and permission denial is preserved',async()=>{
 const audio=track('audio');
 const result=await acquireAudio('microphone',{mediaDevices:{getUserMedia:async()=>new Stream([audio])},Stream});
 assert.equal(result.capture,result.audio);
 const denial=Error('Permission denied');
 await assert.rejects(acquireAudio('computer',{mediaDevices:{getDisplayMedia:()=>Promise.reject(denial)},Stream}),e=>e===denial);
});
test('a handover waits for recorded bytes and retains them in the first segment',async()=>{
 let recorder;
 class Recorder {
  constructor(){recorder=this;this.state='inactive';this.mimeType='audio/webm';}
  start(){this.state='recording';}
  requestData(){this.ondataavailable({data:new Blob(['first audio bytes'])});}
  stop(){this.state='inactive';this.onstop?.();}
 }
 let ready=false;
 const pending=primeRecording({},'',{Recorder,probeMs:0,timeoutMs:100,now:()=>42}).then(r=>{ready=true;return r;});
 await Promise.resolve();assert.equal(ready,false);
 const result=await pending;
 assert.equal(result.startedAt,42);assert.equal(result.media,recorder);assert.equal(recorder.state,'recording');
 recorder.ondataavailable({data:new Blob(['later bytes'])});
 assert.equal(await new Blob(result.chunks).text(),'first audio byteslater bytes');
 recorder.onerror();
 assert.match(result.error.message,/failed/);assert.equal(recorder.state,'inactive');
 assert.equal(await (await result.stop()).text(),'first audio byteslater bytes');
});
test('an ambiguous recorder response retries the same request and recovers only its current owned claim',async()=>{
 const request={sessionId:'new-session',deviceId:'new-device',expectedGeneration:4};
 const calls=[];
 const current={session_id:'new-session',device_id:'new-device',generation:5,owner_id:'owner',status:'recording',lease_until:5000};
 const result=await requestRecorder(request,'owner',{
  post:async body=>{calls.push(body);throw Error('Lost response');},
  read:async()=>({recorder:current,asOf:1000}),now:()=>17,
 });
 assert.equal(calls.length,2);assert.equal(calls[0],request);assert.equal(calls[1],request);
 assert.equal(result.recorder,current);assert.equal(result.leaseForMs,4000);assert.equal(result.requestedAt,17);
 await assert.rejects(requestRecorder(request,'owner',{post:async()=>{throw Error('Lost response');},read:async()=>({recorder:{...current,generation:6},asOf:1000})}),/Lost response/);
 await assert.rejects(requestRecorder(request,'owner',{post:async()=>{throw Error('Lost response');},read:async()=>({recorder:{...current,owner_id:'another'},asOf:1000})}),/Lost response/);
 let attempts=0;
 await assert.rejects(requestRecorder(request,'owner',{post:async()=>{attempts++;throw Object.assign(Error('Conflict'),{status:409});},read:async()=>{throw Error('Must not read');}}),/Conflict/);
 assert.equal(attempts,1);
});
test('a source that produces no data fails before handover and stops its recorder',async()=>{
 let recorder;
 class Recorder {
  constructor(){recorder=this;this.state='inactive';}
  start(){this.state='recording';}
  requestData(){this.ondataavailable({data:new Blob([])});}
  stop(){this.state='inactive';this.onstop?.();}
 }
 await assert.rejects(primeRecording({},'',{Recorder,probeMs:0,timeoutMs:5}),/audio.*data|recorded.*audio/i);
 assert.equal(recorder.state,'inactive');
});
test('independent claim recovery finds its own input rather than the room recorder',async()=>{
 const request={sessionId:'mic',deviceId:'mine',expectedGeneration:2,independent:true};
 const own={session_id:'mic',device_id:'mine',generation:3,owner_id:'me',status:'recording',lease_until:5000};
 const result=await requestRecorder(request,'me',{post:async()=>{throw Error('response lost');},read:async()=>({recorder:{session_id:'someone-else'},recorders:[own],asOf:1000})});
 assert.equal(result.recorder,own);
});
