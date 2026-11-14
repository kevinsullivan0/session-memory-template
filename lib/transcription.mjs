// Local adapter boundary: adapters return text; they have no decision-approval API.
export async function processNext(storage,transcribe,{now=()=>Date.now()}={}) {
  const {sql,BUCKET}=storage,time=now();
  const job=sql.prepare("SELECT * FROM jobs WHERE kind='transcription' AND (status='pending' OR (status='running' AND lease_until<?)) AND attempts<4 ORDER BY created_at LIMIT 1").get(time);
  if(!job)return null;
  const token=crypto.randomUUID();
  const claim=sql.prepare("UPDATE jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND (status='pending' OR (status='running' AND lease_until<?))").run(token,time+240000,job.id,time);
  if(!claim.changes)return null;
  const source=sql.prepare('SELECT * FROM evidence WHERE id=?').get(job.source_id);
  try {
    if(!source || source.quarantined)throw Error('Source is unavailable or held for review.');
    const object=await BUCKET.get(source.object_key);
    if(!object)throw Error('Audio object is missing.');
    const text=await transcribe({bytes:new Uint8Array(object.body),mime:source.mime,sourceId:source.id,signal:AbortSignal.timeout(180000)});
    if(typeof text!=='string'||text.length>50000)throw Error('Adapter must return a string of at most 50000 characters.');
    sql.exec('BEGIN IMMEDIATE');
    try {
      const current=sql.prepare("SELECT id FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?").get(job.id,token,now());
      if(!current)throw Error('Transcription lease expired.');
      const changed=sql.prepare("UPDATE evidence SET text=?,status='ready',revision=revision+1 WHERE id=? AND revision=? AND quarantined=0").run(text.trim()||'[No intelligible speech detected.]',source.id,source.revision);
      if(!changed.changes)throw Error('Source changed during transcription.');
      sql.prepare("UPDATE jobs SET status='done',last_error=NULL WHERE id=? AND lease_token=?").run(job.id,token);
      sql.prepare("INSERT INTO events(entity_id,type,payload,actor,created_at) VALUES(?,'source.transcribed',?,'local-transcriber',?)").run(source.id,JSON.stringify({id:source.id,text}),now());
      sql.exec('COMMIT');
    } catch(e){sql.exec('ROLLBACK');throw e;}
    return {id:source.id,status:'done'};
  } catch(e) {
    sql.prepare("UPDATE jobs SET status='pending',last_error=? WHERE id=? AND lease_token=? AND status='running'").run(String(e.message).slice(0,200),job.id,token);
    throw e;
  }
}
