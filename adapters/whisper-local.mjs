import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizedAudio} from '../lib/audio.mjs';
// Requires a locally installed Whisper package, ffmpeg and an existing model file.
// An explicit model path prevents this adapter from asking Whisper to download weights.
export function createWhisperAdapter({modelPath=process.env.WHISPER_MODEL_PATH,python=process.env.WHISPER_PYTHON||'python3',run=promisify(execFile)}={}) {
  return async function transcribe({bytes,signal}) {
    if(!modelPath||!(await stat(modelPath)).isFile())throw Error('Set WHISPER_MODEL_PATH to an existing local model file.');
    const directory=await mkdtemp(join(tmpdir(),'session-transcribe-'));
    try {
      const encoded=join(directory,'encoded.media'),wav=join(directory,'audio.wav');
      await writeFile(encoded,bytes,{mode:0o600});
      await writeFile(wav,normalizedAudio(encoded).wav,{mode:0o600});
      await run(python,['-m','whisper',wav,'--model',resolve(modelPath),'--device','cpu','--fp16','False','--verbose','False','--condition_on_previous_text','False','--output_dir',directory,'--output_format','txt'],{signal,timeout:180000,maxBuffer:1024*1024,windowsHide:true});
      return await readFile(join(directory,'audio.txt'),'utf8');
    } finally {await rm(directory,{recursive:true,force:true});}
  };
}
export const transcribe=createWhisperAdapter();
