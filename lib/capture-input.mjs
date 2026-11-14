// Request display capture synchronously from the user's click, before any network operation.
export async function acquireAudio(mode, {mediaDevices = navigator.mediaDevices, Stream = MediaStream} = {}) {
  if (mode === 'microphone') {
    const audio = await mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    return {audio,capture:audio};
  }
  if (mode !== 'computer' || !mediaDevices.getDisplayMedia)
    throw Error('This browser cannot share computer audio. Open the app in a current desktop Chrome or Edge browser.');
  const capture = await mediaDevices.getDisplayMedia({
    video:true, audio:{suppressLocalAudioPlayback:false}, systemAudio:'include', windowAudio:'window',
    selfBrowserSurface:'exclude', surfaceSwitching:'exclude',
  });
  const tracks = capture.getAudioTracks().filter(track=>track.readyState==='live');
  if (!tracks.length) {
    capture.getTracks().forEach(track=>track.stop());
    throw Error('No audio was shared. Enable Share audio in the browser picker. If shared audio is unavailable, use a browser that offers system audio, or open your call in the same browser and share its tab.');
  }
  // Keep the display capture alive, but never pass its video track to a recorder or uploader.
  return {audio:new Stream(tracks),capture};
}

// Keep the first encoded bytes for the new session before requesting a recorder handover.
export function primeRecording(audio,mime,{Recorder=MediaRecorder,probeMs=250,timeoutMs=5000,now=()=>performance.now()}={}) {
  return new Promise((resolve,reject)=>{
    const media=new Recorder(audio,mime?{mimeType:mime}:undefined),chunks=[],startedAt=now();
    let resolveStop;
    const stopped=new Promise(resolve=>{resolveStop=resolve;});
    const staged={media,chunks,startedAt,error:null,stoppedAt:null,stop:async()=>{
      if(media.state!=='inactive')media.stop();
      await stopped;
      return new Blob(chunks,{type:media.mimeType});
    }};
    let settled=false,probe,timer;
    const fail=error=>{
      staged.error ||= error;
      if(settled){if(media.state==='recording')media.stop();return;}
      settled=true;clearTimeout(probe);clearTimeout(timer);
      if(media.state==='recording')media.stop();
      reject(error);
    };
    media.ondataavailable=event=>{
      if(!event.data.size)return;
      chunks.push(event.data);
      if(!settled){settled=true;clearTimeout(probe);clearTimeout(timer);resolve(staged);}
    };
    media.onerror=()=>fail(Error('The new audio source failed.'));
    media.onstop=()=>{staged.stoppedAt=now();resolveStop();fail(Error('The new audio source stopped.'));};
    try {
      media.start();
      probe=setTimeout(()=>{try{media.requestData();}catch(error){fail(error);}},probeMs);
      timer=setTimeout(()=>fail(Error('The new source produced no audio data. The handover was not requested.')),timeoutMs);
    } catch(error){fail(error);}
  });
}

export async function requestRecorder(request,owner,{post,read,ready=()=>true,now=()=>performance.now()}) {
  let failure;
  for(let attempt=0;attempt<2;attempt++) {
    if(!ready())break;
    const requestedAt=now();
    try{return {...await post(request),requestedAt};}
    catch(error){
      if([400,401,403,404,409,413,422].includes(error.status))throw error;
      failure=error;
    }
  }
  const requestedAt=now();
  try {
    const state=await read(),r=request.independent ? state.recorders?.find(r=>r.session_id===request.sessionId) : state.recorder;
    if(r?.session_id===request.sessionId && r.device_id===request.deviceId &&
      r.generation===request.expectedGeneration+1 && r.owner_id===owner &&
      r.status==='recording' && r.lease_until>state.asOf)
      return {recorder:r,serverTime:state.asOf,leaseForMs:r.lease_until-state.asOf,requestedAt};
  } catch {}
  throw failure || Error('The new source stopped before recording ownership was confirmed.');
}
