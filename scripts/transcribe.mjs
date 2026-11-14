import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStorage } from '../server/storage.mjs';
import { processNext } from '../lib/transcription.mjs';
const adapterPath=process.argv[2];
if(!adapterPath)throw Error('Usage: npm run transcribe -- ./path/to/local-adapter.mjs');
const {transcribe}=await import(pathToFileURL(resolve(adapterPath)).href);
if(typeof transcribe!=='function')throw Error('Adapter must export transcribe.');
const storage=openStorage(process.env.SESSION_MEMORY_DATA||'data');
try {let result;while((result=await processNext(storage,transcribe)))console.log(`${result.id}: ${result.status}`);}finally{storage.close();}
