import {execFileSync} from 'node:child_process';
export function normalizedAudio(filename){
 // MediaRecorder WebM often has no duration header. Count bounded decoded PCM,
 // rather than trusting either browser metadata or the upload's duration field.
 const pcm=execFileSync('ffmpeg',['-v','error','-protocol_whitelist','file,pipe','-i',filename,'-vn','-ac','1','-ar','16000','-t','126','-f','s16le','pipe:1'],{timeout:20000,maxBuffer:4_100_000,stdio:['ignore','pipe','ignore']});
 const seconds=pcm.length/(16000*2);
 if(!Number.isFinite(seconds)||seconds<=0||seconds>125)throw Error('Audio duration is outside the independent segment limit.');
 const wav=Buffer.alloc(44+pcm.length);
 wav.write("RIFF",0);wav.writeUInt32LE(wav.length-8,4);wav.write("WAVEfmt ",8);
 wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
 wav.write("data",36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);
 return {seconds,wav};
}

export function verifiedAudioSeconds(filename){return normalizedAudio(filename).seconds;}
