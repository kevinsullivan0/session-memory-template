import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createWhisperAdapter} from '../adapters/whisper-local.mjs';
function tone(){
 const pcm=Buffer.alloc(16000*2),wav=Buffer.alloc(44+pcm.length);
 for(let i=0;i<16000;i++)pcm.writeInt16LE(Math.round(1000*Math.sin(2*Math.PI*440*i/16000)),i*2);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);return wav;
}
let ffmpeg=false;try{execFileSync('ffmpeg',['-version'],{stdio:'ignore'});ffmpeg=true;}catch{}
test('local speech adapter requires an explicit existing model; never downloads by model name',async()=>{
 await assert.rejects(createWhisperAdapter({modelPath:''})({bytes:tone()}),/WHISPER_MODEL_PATH/);
});
test('local Whisper command receives independently normalized audio and returns its text',{skip:!ffmpeg},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'whisper-fixture-')),model=join(dir,'fake-model.pt');await writeFile(model,'test-only placeholder');let temporary;
 try {
  const adapter=createWhisperAdapter({modelPath:model,python:'fixture-python',run:async(executable,args,options)=>{
   assert.equal(executable,'fixture-python');assert.deepEqual(args.slice(0,2),['-m','whisper']);assert.equal(args[args.indexOf('--model')+1],model);
   const input=await readFile(args[2]);assert.equal(input.toString('ascii',0,4),'RIFF');assert.ok(input.length>32000);
   assert.equal(options.timeout,180000);temporary=args[args.indexOf('--output_dir')+1];await writeFile(join(temporary,'audio.txt'),'Synthetic adapter result.');
  }});
  assert.equal(await adapter({bytes:tone(),signal:AbortSignal.timeout(5000)}),'Synthetic adapter result.');
  await assert.rejects(readFile(join(temporary,'audio.wav')),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
