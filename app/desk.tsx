"use client";
import { useState, useEffect, useRef } from "react";
import {
  openQueue,
  saveSegment,
  flushSegments,
} from "../lib/capture-queue.mjs";

import { acquireAudio, primeRecording, requestRecorder } from "../lib/capture-input.mjs";

type Any = any;
const uuid = () => crypto.randomUUID();
const stamp = (t: number) =>
  t
    ? new Date(t).toLocaleTimeString("en-US", {

        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
async function api(path: string, body?: Any, signal?: AbortSignal): Promise<Any> {
  const r = await fetch(
    `/api/${path}`,
    {signal, ...(body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })},
  );
  const data: Any = await r.json();
  if (!r.ok) throw Object.assign(Error(data.error || "Request failed."), { status: r.status });
  return data;
}
export default function Desk() {
  const [data, setData] = useState<Any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [ready, setReady] = useState(false);
  const [queued, setQueued] = useState<Any[]>([]),
    [recording, setRecording] = useState(false),
    [captureStatus, setCaptureStatus] = useState("Recorder stopped"),
    [hold, setHold] = useState(false),
    [consent, setConsent] = useState(false),
    [rules, setRules] = useState(false),
    [participants, setParticipants] = useState(""),
    [captureInput, setCaptureInput] = useState("microphone");
  const [note, setNote] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Any[] | null>(null),
    [selected, setSelected] = useState<Any>(null),
    [busy, setBusy] = useState(false);
  const queue = useRef<Any>(null),
    session = useRef<Any>(null),
    recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    sharedCapture = useRef<MediaStream | null>(null),
    active = useRef(false),
    preparing = useRef(false),
    flushBusy = useRef(false),
    holdRef = useRef(false),
    deadline = useRef(0),
    sequence = useRef(0),
    segmentTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    account = useRef("");
  const refresh = async () => {
    try {
      const requestedAt = performance.now();
      const next = await api("state");
      setData({...next, requestedAt});
    } catch (e: Any) {
      setError(e.message);
    }
  };
  const updateQueue = async () => {
    if (queue.current) setQueued(await queue.current.list());
  };
  async function upload(row: Any) {
    const r = await fetch("/api/evidence", {
      method: "POST",
      headers: {
        "Content-Type": row.blob.type || row.meta.mime,
        "x-evidence-meta": JSON.stringify(row.meta),
      },
      body: row.blob,
    });
    const result: Any = await r.json();
    if (!r.ok) throw Error(result.error);
    return result;
  }
  async function flush() {
    if (!queue.current || flushBusy.current || holdRef.current) return;
    flushBusy.current = true;
    try {
      const out = await flushSegments(queue.current, upload);
      const fail = out.find((x: Any) => !x.stored);
      if (fail) setError(`Audio is still saved on this device. ${fail.error}`);
      else if (out.length) {
        setNotice(`${out.length} segment(s) confirmed in private storage.`);
        await refresh();
      }
      await updateQueue();
    } finally {
      flushBusy.current = false;
    }
  }
  useEffect(() => {
    if(new URLSearchParams(location.search).get("input")==="computer")setCaptureInput("computer");
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!data?.member?.accountId || account.current === data.member.accountId)
      return;
    account.current = data.member.accountId;
    openQueue(data.member.accountId)
      .then(async (q) => {
        queue.current = q;
        setReady(true);
        await updateQueue();
        if (!holdRef.current) flush();
      })
      .catch((e: Any) =>
        setError(`Local recording storage unavailable: ${e.message}`),
      );
  }, [data?.member?.accountId]);
  useEffect(() => {
    const go = () => flush();
    window.addEventListener("online", go);
    const t = setInterval(go, 15000);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", go);
    };
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (active.current || preparing.current || queued.length) {
        e.preventDefault();
        e.returnValue = "Audio is recording or waiting to upload.";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queued.length]);
  useEffect(() => {
    const t = setInterval(async () => {
      if (!active.current) return;
      if (performance.now() >= deadline.current) {
        stopLocal();
        setError(
          "Recorder lease expired. Capture stopped; sealed audio remains recoverable.",
        );
        return;
      }
      try {
        const requestedAt = performance.now();
        const r = await api("recorder/renew", session.current);
        deadline.current = requestedAt + r.leaseForMs;
      } catch (e: Any) {
        if ([401, 403, 409].includes(e.status) || performance.now() >= deadline.current) {
          stopLocal();
          setError(e.message);
        }
      }
    }, 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const claim = session.current, lock = data?.recorders?.find((r: Any)=>r.session_id===claim?.sessionId) || data?.recorder;
    if (!active.current || !claim || data?.requestedAt < claim.acquiredAt) return;
    if (!lock || lock.status !== "recording" || lock.generation !== claim.generation || lock.session_id !== claim.sessionId || lock.device_id !== claim.deviceId) {
      stopLocal();
      setError("Recording stopped. Room authorization changed.");
    }
  }, [data?.asOf]);
  useEffect(() => {
    if (!data) return;
    const source = new URLSearchParams(location.search).get("source");
    if (source)
      api(`source/${encodeURIComponent(source)}`)
        .then((r) => setSelected(r.source))
        .catch((e: Any) => setError(e.message));
  }, [!!data]);
  useEffect(() => {
    if (!selected?.id || !data) return;
    const latest = data.sources.find((source: Any) => source.id === selected.id);
    if (latest) { setSelected(latest); return; }
    let current = true;
    api(`source/${encodeURIComponent(selected.id)}`).then((result) => {
      if (current) setSelected(result.source);
    }).catch((e: Any) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [data?.asOf, selected?.id]);
  function stopLocal() {
    active.current = false;
    setRecording(false);
    if (segmentTimer.current) clearTimeout(segmentTimer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
    sharedCapture.current?.getTracks().forEach((t) => t.stop());
    stream.current = null; sharedCapture.current = null;
    setCaptureStatus("Paused · sealed segments retained");
  }
  async function act(fn: () => Promise<Any>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: Any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function device() {
    const key = `session-memory-device-${data.member.accountId}`;
    let value = localStorage.getItem(key);
    if (!value) {
      value = uuid();
      localStorage.setItem(key, value);
    }
    return value;
  }
  function mime() {
    return (
      ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      ) || ""
    );
  }
  async function begin(synthetic = false, takeover = false, confirmed = false) {
    if (!queue.current)
      throw Error("Local storage must be available before recording.");
    if (active.current) throw Error("This device is already recording.");
    const captureQueue = queue.current;
    if (!synthetic && !confirmed && (!consent || !rules))
      throw Error("Confirm consent, retention and local processing first.");
    if (!window.MediaRecorder)
      throw Error(
        "This browser cannot record audio. Use an external recorder and upload the files.",
      );
    const request = {
        sessionId: uuid(),
        deviceId: device(),
        policy: data.policy,
        consentAccepted: synthetic || confirmed || consent,
        processingAccepted: synthetic || confirmed || rules,
        participants: synthetic
          ? ["Synthetic tone; no people recorded"]
          : participants
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
        synthetic,
        independent: true,
        input: captureInput,
        takeover: false,
        expectedGeneration: data.recorders?.find((r: Any)=>r.id===`capture:${data.member.id}:${captureInput}`)?.generation || 0,
    };
    const input = synthetic ? null : await acquireAudio(captureInput);
    preparing.current = !!input;
    let owned: Any = null;
    let primed: Any = null;
    try {
      if(input) {
        primed = await primeRecording(input.audio,mime());
        if(primed.error || primed.media.state !== "recording") throw primed.error || Error("The new recorder stopped.");
      }
      const response = await requestRecorder(request,data.member.id,{
        post:(body: Any)=>api("recorder/start",body,AbortSignal.timeout(15000)),
        read:()=>api("state",undefined,AbortSignal.timeout(5000)),
        ready:()=>!primed || (!primed.error && primed.media.state === "recording"),
      });
      const r = response.recorder;
      session.current = {
        sessionId: r.session_id,
        deviceId: r.device_id,
        generation: r.generation,
        acquiredAt: performance.now(),
        serverTime: response.serverTime,
      };
      owned = {...session.current};
      if(primed && (primed.error || primed.media.state !== "recording"))
        throw primed.error || Error("The new recorder stopped during the handover.");
      deadline.current = response.requestedAt + response.leaseForMs;
      sequence.current = 0;
      let audio: MediaStream,
        context: AudioContext | null = null,
        sample: AudioBufferSourceNode | null = null,
        sampleSeconds = 0;
      if (synthetic) {
        context = new AudioContext();
        const dest = context.createMediaStreamDestination();
        const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
        const samples=buffer.getChannelData(0);
        for(let i=0;i<samples.length;i++) samples[i]=0.05*Math.sin(2*Math.PI*440*i/context.sampleRate);
        sample = context.createBufferSource();
        sample.buffer = buffer;
        sampleSeconds = buffer.duration;
        sample.connect(dest);
        audio = dest.stream;
        setHold(true);
        holdRef.current = true;
      } else {
        audio = input!.audio;
        sharedCapture.current = input!.capture;
      }
      stream.current = audio;
      if (!(sharedCapture.current || audio).getTracks().every(track=>track.readyState==='live'))
        throw Error("Audio sharing stopped before recording began. Start again.");
      if (performance.now() >= deadline.current) throw Error("Recording authorization expired. Start again.");
      (sharedCapture.current || audio).getTracks().forEach(track => track.addEventListener("ended", () => {
        if (!active.current) return;
        stopLocal();
        setError("Audio input stopped. Sealed segments remain saved. Start recording to select an input again.");
        api("recorder/release", owned).catch(() => {});
      }, {once:true}));
      active.current = true;
      preparing.current = false;
      setRecording(true);
      setCaptureStatus(
        synthetic
          ? "Synthetic tone · saved on this device"
          : `Recording ${captureInput === "computer" ? "computer audio" : "microphone"} · current minute is not yet saved`,
      );
      const next = () => {
        if (!active.current) return;
        const initial = primed;
        primed = null;
        const startedMonotonic = initial?.startedAt ?? performance.now(),
          started = session.current.serverTime + (startedMonotonic - session.current.acquiredAt),
          chunks: BlobPart[] = initial?.chunks || [],
          claim = { ...session.current },
          seq = sequence.current++;
        const selectedMime = mime();
        const media: MediaRecorder = initial?.media || new MediaRecorder(
          audio,
          selectedMime ? { mimeType: selectedMime } : undefined,
        );
        recorder.current = media;
        media.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        media.onerror = () => {
          stopLocal();
          setError(
            "Recording failed. Previously sealed segments remain saved.",
          );
        };
        media.onstop = async () => {
          const blob = new Blob(chunks, { type: media.mimeType });
          try {
            if (blob.size)
              await saveSegment(captureQueue, {
                id: uuid(),
                blob,
                meta: {
                  ...claim,
                  sequence: seq,
                  kind: "audio",
                  duration: Math.min(125, (performance.now() - startedMonotonic) / 1000),
                  capturedAt: started,
                },
              });
            await updateQueue();
            if (!holdRef.current) await flush();
            else
              setNotice(
                "Synthetic segment saved on this device. Reload to verify recovery, then choose Retry uploads.",
              );
          } catch (e: Any) {
            stopLocal();
            setError(`Local save failed; recording stopped. ${e.message}`);
          }
          if (synthetic) {
            active.current = false;
            setRecording(false);
            audio.getTracks().forEach((t) => t.stop());
            context?.close();
            api("recorder/release", owned).catch(() => {});
            setCaptureStatus("Synthetic segment sealed");
          } else if (active.current && performance.now() < deadline.current) next();
        };
        if (!initial) media.start();
        if (sample) sample.start();
        segmentTimer.current = setTimeout(
          () => {
            if (media.state === "recording") media.stop();
          },
          synthetic ? (sampleSeconds + 0.5) * 1000 : Math.max(1,60000-(performance.now()-startedMonotonic)),
        );
      };
      next();
    } catch (e: Any) {
      let failure = e;
      if(primed) {
        try {
          const blob = await primed.stop();
          if(blob.size) {
            await saveSegment(captureQueue,{id:uuid(),blob,meta:{
              sessionId:request.sessionId,deviceId:request.deviceId,
              generation:owned?.generation ?? request.expectedGeneration+1,
              sequence:0,kind:"audio",provisional:true,
              capturedAt:data.asOf+(primed.startedAt-data.requestedAt),
              duration:Math.min(125,((primed.stoppedAt ?? performance.now())-primed.startedAt)/1000),
            }});
            await updateQueue();
            setNotice("This input did not start. Its buffered audio stays on this device. Download and import that copy. Other inputs are unchanged.");
          }
        } catch(recoveryError: Any) { failure=Error(`${e.message} Local audio recovery failed: ${recoveryError.message}`); }
      }
      input?.capture.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      preparing.current = false;
      stopLocal();
      if (owned) await api("recorder/release", owned).catch(() => {});
      throw failure;
    }
  }
  async function pause() {
    const claim = session.current;
    stopLocal();
    if(claim) await api("recorder/release", claim);
    await refresh();
  }
  async function photo(file: File) {
    if (!queue.current) throw Error("Local storage unavailable.");
    await saveSegment(queue.current, {
      id: uuid(),
      blob: file,
      meta: {
        sessionId: uuid(),
        deviceId: device(),
        sequence: 0,
        kind: "photo",
        capturedAt: Date.now(),
        caption: "",
      },
    });
    await updateQueue();
    await flush();
  }
  async function importAudio(file: File, confirmed = false) {
    if (!confirmed && (!consent || !rules))
      throw Error(
        "Confirm consent and permitted processing before importing audio.",
      );
    if (!queue.current) throw Error("Local recording storage is unavailable.");
    const objectUrl = URL.createObjectURL(file),
      audio = new Audio(objectUrl);
    const duration = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Audio metadata could not be read.")),
        10000,
      );
      audio.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve(audio.duration);
      };
      audio.onerror = () => {
        clearTimeout(timer);
        reject(Error("This audio file could not be decoded."));
      };
    }).finally(() => URL.revokeObjectURL(objectUrl));
    if (!Number.isFinite(duration) || duration <= 0 || duration > 125)
      throw Error(
        "Import one independently playable audio segment of at most 125 seconds.",
      );
    const session = await api("recorder/import", {
      sessionId: uuid(),
      deviceId: device(),
      policy: data.policy,
      consentAccepted: confirmed || consent,
      processingAccepted: confirmed || rules,
      participants: participants
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    });
    const type = file.type === "audio/x-wav" ? "audio/wav" : file.type;
    await saveSegment(queue.current, {
      id: uuid(),
      blob: new Blob([file], { type }),
      meta: {
        ...session,
        sequence: 0,
        kind: "audio",
        capturedAt: Date.now(),
        duration,
      },
    });
    await updateQueue();
    await flush();
  }
  function openSource(source: Any) {
    setSelected(source);
    history.replaceState(
      null,
      "",
      `/find?source=${encodeURIComponent(source.id)}`,
    );
  }
  function download(row: Any) {
    const url=URL.createObjectURL(row.blob), link=document.createElement('a');
    link.href=url;link.download=`segment-${row.id}.${row.blob.type.includes('mp4')?'mp4':row.blob.type.includes('ogg')?'ogg':'webm'}`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  if(!data)return <main><h1>Session memory</h1><p role="status">{error||'Opening local workspace…'}</p><button onClick={refresh}>Retry</button></main>;
  const sources=results ?? data.sources;
  return <main>
    <header><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>Session memory</h1></div><span>Audio, notes & source-linked decisions</span></header>
    <p className="scope">Local operator · stored on this computer · manual transcript entry or local adapter</p>
    {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}
    <section><h2>Capture</h2><p role="status">{captureStatus}</p>
      <label>Input <select value={captureInput} disabled={recording||busy} onChange={e=>setCaptureInput(e.target.value)}><option value="microphone">Microphone</option><option value="computer">Computer audio</option></select></label>
      <label>Consenting participants <input value={participants} placeholder="Participant labels, separated by commas" onChange={e=>setParticipants(e.target.value)}/></label>
      <label className="check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> Everyone has consented to recording and local retention.</label>
      <label className="check"><input type="checkbox" checked={rules} onChange={e=>setRules(e.target.checked)}/> Local transcription and processing are permitted.</label>
      <div className="actions"><button disabled={busy||recording||!ready} onClick={()=>act(()=>begin())}>Start recording</button><button disabled={busy||!recording} onClick={()=>act(pause)}>Stop & save</button><button disabled={busy||recording||!ready} onClick={()=>act(()=>begin(true))}>Synthetic recovery test</button></div>
      <p>Sealed segments save about once per minute. The current unsealed minute can be lost if this tab crashes. Keep this tab open while recording.</p>
      <label className="check"><input type="checkbox" checked={hold} onChange={e=>{setHold(e.target.checked);holdRef.current=e.target.checked;}}/> Hold uploads on this device</label>
      <button disabled={busy} onClick={()=>act(async()=>{holdRef.current=false;setHold(false);await flush();})}>Retry uploads ({queued.length})</button>
      <ul>{queued.map(row=><li key={row.id}>Segment {row.meta.sequence} · {row.blob.size} bytes {row.meta.provisional&&'· unconfirmed start; download and import'} <button onClick={()=>download(row)}>Download local copy</button></li>)}</ul>
      <div className="imports"><label>Import audio (≤125 seconds)<input type="file" accept="audio/webm,audio/mp4,audio/ogg,audio/wav" onChange={e=>{const f=e.target.files?.[0];if(f)act(()=>importAudio(f));e.target.value='';}}/></label><label>Add photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{const f=e.target.files?.[0];if(f)act(()=>photo(f));e.target.value='';}}/></label></div>
    </section>
    <section><h2>Notes</h2><form onSubmit={e=>{e.preventDefault();act(async()=>{await api('notes',{id:uuid(),text:note});setNote('');});}}><label>New source note<textarea value={note} onChange={e=>setNote(e.target.value)} required/></label><button disabled={busy}>Save note</button></form></section>
    <section><h2>Find sources</h2><form className="actions" onSubmit={e=>{e.preventDefault();act(async()=>setResults((await api(`search?q=${encodeURIComponent(query)}`)).sources));}}><input aria-label="Search source text" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search transcripts and notes"/><button>Search</button><button type="button" onClick={()=>setResults(null)}>Latest 200</button></form>
      <p><a href="/api/transcripts?format=md">Download transcripts (Markdown)</a> · <a href="/api/transcripts?format=jsonl">JSONL</a></p>
      <div className="sources">{sources.length?sources.map((s:Any)=><button className="source" key={s.id} onClick={()=>openSource(s)}><span>{s.kind} · {stamp(s.capturedAt)} · {s.status}</span><strong>{s.text?.slice(0,180)||'Transcript pending; open source to attach text.'}</strong></button>):<p>No sources yet. Record audio or add a note.</p>}</div>
    </section>
    {selected&&<section id="source"><h2>Source</h2><p className="mono">{selected.id} · revision {selected.revision} · {selected.status}</p><p className="mono">SHA-256: {selected.hash}</p>
      {selected.media&&(selected.kind==='photo'?<img alt="Captured source" src={selected.media}/>:<audio controls src={selected.media}/>)}
      <pre>{selected.text||'No transcript attached.'}</pre>
      {selected.quarantined?<><p>This late upload needs review before processing.</p><button disabled={busy} onClick={()=>act(()=>api('evidence/review',{id:selected.id,hash:selected.hash,revision:selected.revision,policy:data.policy}))}>Approve local processing</button></>:selected.kind==='audio'&&<form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const text=new FormData(form).get('text');act(async()=>{await api('transcripts/attach',{id:selected.id,revision:selected.revision,text});form.reset();});}}><label>Attach or correct transcript<textarea name="text" required maxLength={50000}/></label><button disabled={busy}>Save transcript</button></form>}
      <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const values=Object.fromEntries(new FormData(form));act(async()=>{await api('candidates/propose',{...values,sourceId:selected.id});form.reset();});}}><h3>Source-linked candidate</h3><label>Kind <select name="type">{['IDEA','QUESTION','PROPOSAL','DECISION_CANDIDATE','ACTION_CANDIDATE','RESULT_CLAIM'].map(t=><option key={t}>{t}</option>)}</select></label><label>Candidate text<textarea name="text" required maxLength={2000}/></label><button disabled={busy}>Propose for review</button></form>
    </section>}
    <section><h2>Processing</h2><p>{data.jobs.map((j:Any)=>`${j.status}: ${j.count}`).join(" · ")||"No queued jobs."} Start the local adapter from the terminal, or attach a transcript above.</p><button disabled={busy} onClick={()=>act(()=>api("jobs/retry",{}))}>Retry failed local processing</button></section>
    <section><h2>Memory & decisions</h2><p>Source text is untrusted evidence. Only an explicit review creates a confirmed decision.</p>{data.records.map((r:Any)=><article key={r.id}><p>{r.payload.type||r.kind} · {r.status}</p><p>{r.payload.text}</p><p>{r.payload.sources?.map((id:string)=><button key={id} onClick={()=>act(async()=>setSelected((await api(`source/${id}`)).source))}>Open source</button>)}</p>{r.kind==='candidate'&&r.status==='proposed'&&<div className="actions"><button disabled={busy} onClick={()=>act(()=>api('decisions/confirm',{id:r.id,version:r.version}))}>Confirm decision</button><button disabled={busy} onClick={()=>act(()=>api('candidates/reject',{id:r.id,version:r.version}))}>Reject</button></div>}</article>)}</section>
    <footer>Browser storage is not a backup. Export transcripts and copy the local data directory regularly.</footer>
  </main>;
}
