import {
  AppError,
  assertSameOrigin,
  evidenceIdentity,
  canRenew,
} from "./domain.mjs";
import { TRANSCRIPT_PREAMBLE, transcriptRecord, transcriptMarkdown } from "./transcript-export.mjs";
const POLICY = "session-memory-v1";
const now = () => Date.now();
const id = () => crypto.randomUUID();
const stringify = JSON.stringify;
const parse = (s, f = null) => {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const all = async (db, sql, ...args) =>
  (await stmt(db, sql, ...args).all()).results;
const run = (db, sql, ...args) => stmt(db, sql, ...args).run();
const event = (db, entity, type, payload, actor) =>
  stmt(
    db,
    "INSERT INTO events(entity_id,type,payload,actor,created_at) VALUES(?,?,?,?,?)",
    entity,
    type,
    stringify(payload),
    actor,
    now(),
  );
function reply(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
function need(ok, message, status = 400) {
  if (!ok) throw new AppError(message, status);
}
async function json(req) {
  need(
    Number(req.headers.get("content-length") || 0) < 200_000,
    "Request too large.",
    413,
  );
  const t = await req.text();
  need(t.length < 200_000, "Request too large.", 413);
  const b = parse(t);
  need(b && typeof b === "object" && !Array.isArray(b), "Invalid request.");
  return b;
}
function cleanText(v, max = 20000) {
  need(
    typeof v === "string" && v.trim() && v.length <= max,
    "Text is empty or too long.",
  );
  return v.trim();
}
function wireEvidence(e) {
  return {
    id: e.id,
    kind: e.kind,
    hash: e.hash,
    sessionId: e.session_id,
    sequence: e.sequence,
    capturedAt: e.captured_at,
    storedAt: e.stored_at,
    text: e.text,
    status: e.quarantined ? "held" : e.status,
    revision: e.revision,
    quarantined: !!e.quarantined,
    mime: e.mime,
    media: e.object_key ? `/api/media/${e.id}` : null,
  };
}
async function auth(db, user, env) {
  need(user?.userId, 'Authentication required.', 401);
  // The adapter must supply a verified principal; no request headers are trusted here.
  need(user.userId === env.PRINCIPAL_ID, 'Workspace access denied.', 403);
  return {id:user.userId, accountId:user.userId, name:'Local operator', role:'admin'};
}
async function sessionStart(db, m, b) {
  need(
    /^[a-zA-Z0-9_-]{1,100}$/.test(b.deviceId || "") &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(b.sessionId || ""),
    "Invalid recorder identity.",
  );
  need(
    b.policy === POLICY &&
      b.consentAccepted === true &&
      b.processingAccepted === true,
    "Confirm participant consent, retention and permitted local transcription before recording.",
  );
  need(
    Array.isArray(b.participants) &&
      b.participants.length &&
      b.participants.length <= 12 &&
      b.participants.every(
        (x) => typeof x === "string" && x.trim().length < 100,
      ),
    "Record the consenting participants.",
  );
  const existing = await one(
    db,
    "SELECT * FROM sessions WHERE id=?",
    b.sessionId,
  );
  if (existing) {
    need(
      existing.owner_id === m.id && existing.device_id === b.deviceId,
      "Session identity conflict.",
      409,
    );
    return await one(
      db,
      "SELECT * FROM recorder WHERE session_id=?",
      b.sessionId,
    );
  }
  const independent = b.independent === true;
  if (independent) need(['microphone','computer'].includes(b.input), 'Choose a microphone or computer audio.');
  const recorderId = independent ? `capture:${m.id}:${b.input}` : 'room';
  await run(db, "INSERT OR IGNORE INTO recorder(id) VALUES(?)", recorderId);
  const old = await one(db, "SELECT * FROM recorder WHERE id=?", recorderId);
  need(
    old.lease_until <= now() || (!independent && b.takeover === true),
    independent ? "This input is already recording in another tab. Stop it there first. Other inputs are unchanged." : "Another device is recording. Use deliberate takeover.",
    409,
  );
  need(
    b.takeover !== true || b.expectedGeneration === old.generation,
    "Recorder changed. Refresh before takeover.",
    409,
  );
  const generation = old.generation + 1,
    time = now();
  const result = await db.batch([
    stmt(
      db,
      "UPDATE recorder SET session_id=?,device_id=?,generation=?,lease_until=?,owner_id=?,status='recording' WHERE id=? AND generation=?",
      b.sessionId,
      b.deviceId,
      generation,
      time + 60000,
      m.id,
      recorderId,
      old.generation,
    ),
    stmt(
      db,
      "INSERT INTO sessions(id,device_id,generation,owner_id,consent,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM recorder WHERE session_id=? AND generation=?)",
      b.sessionId,
      b.deviceId,
      generation,
      m.id,
      stringify({
        policy: POLICY,
        participants: b.participants,
        operator: m.id,
        synthetic: !!b.synthetic,
        input: independent ? b.input : "legacy",
      }),
      time,
      b.sessionId,
      generation,
    ),
    event(
      db,
      b.sessionId,
      "recording.requested",
      {
        sessionId: b.sessionId,
        deviceId: b.deviceId,
        generation,
        synthetic: !!b.synthetic,
      },
      m.id,
    ),
  ]);
  need(
    result[0].meta.changes === 1,
    "Another device acquired recording. Refresh.",
    409,
  );
  return await one(db, "SELECT * FROM recorder WHERE id=?", recorderId);
}
async function storeEvidence(db, env, m, req) {
  const meta = parse(req.headers.get("x-evidence-meta") || "");
  need(meta, "Missing evidence metadata.");
  const kind = meta.kind;
  need(["audio", "photo"].includes(kind), "Unsupported media kind.");
  const session = kind === "audio" ? await one(db, "SELECT * FROM sessions WHERE id=?", meta.sessionId) : null;
  if (kind === "audio") need(session && session.device_id === meta.deviceId && session.generation === meta.generation && (session.owner_id === m.id || m.role === "admin"), "Unknown recorder session.", 403);
  const identity = evidenceIdentity(meta), legacyKey = identity.key;
  identity.key = kind === "photo" ? `photo:${m.id}:${legacyKey}` : `audio:${legacyKey}`;
  const previous = await one(db, "SELECT * FROM evidence WHERE kind=? AND (identity=? OR (identity=? AND (?='audio' OR author_id=?))) LIMIT 1", kind, identity.key, legacyKey, kind, m.id);
  if (previous) {
    need(kind === "audio" || previous.author_id === m.id, "Evidence owner required.", 403);
    evidenceIdentity(meta, { hash: previous.hash });
    return { stored: true, id: previous.id, hash: previous.hash, replayed: true };
  }
  const mime = req.headers.get("content-type")?.split(";")[0];
  need(
    (kind === "audio"
      ? ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"]
      : ["image/jpeg", "image/png", "image/webp"]
    ).includes(mime),
    "Unsupported file format.",
  );
  need(
    Number(req.headers.get("content-length") || 0) <= 10 * 1024 * 1024,
    "File too large.",
    413,
  );
  const bytes = await req.arrayBuffer();
  need(
    bytes.byteLength > 0 && bytes.byteLength <= 10 * 1024 * 1024,
    "File empty or too large.",
    413,
  );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  need(hash === meta.hash, "Uploaded bytes do not match their hash.", 409);
  let quarantined = 0;
  if (kind === "audio") {
    // Late room uploads need explicit review; browser timestamps cannot prove consent.
    need(
      Number.isFinite(meta.duration) &&
        meta.duration > 0 &&
        meta.duration <= 125,
      "Invalid audio duration.",
    );
  }
  const sourceId = meta.sourceId || id();
  need(/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId), "Invalid source ID.");
  const collision = await one(
    db,
    "SELECT identity FROM evidence WHERE id=?",
    sourceId,
  );
  need(
    !collision || collision.identity === identity.key,
    "Source ID already belongs to other evidence.",
    409,
  );
  const key = `sources/${sourceId}/${hash}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  need(await env.BUCKET.head(key), "Storage did not confirm the file.", 503);
  const time = now(),
    captured = Number(meta.capturedAt);
  need(
    Number.isFinite(captured) && captured > 0 && captured <= time + 60000,
    "Invalid capture time.",
  );
  const source = {
    id: sourceId,
    kind,
    hash,
    sessionId: meta.sessionId,
    sequence: meta.sequence,
    capturedAt: captured,
    storedAt: time,
    text: typeof meta.caption === "string" ? meta.caption.slice(0, 2000) : "",
    status: kind === "audio" ? "pending" : "stored",
    revision: 1,
    quarantined: !!quarantined,
    mime,
    media: `/api/media/${sourceId}`,
  };
  const statements = [
    stmt(
      db,
      `INSERT OR IGNORE INTO evidence(id,identity,kind,session_id,device_id,generation,sequence,hash,mime,object_key,bytes,duration,captured_at,stored_at,author_id,text,status,quarantined)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='audio'
        AND COALESCE((SELECT json_extract(consent,'$.imported') FROM sessions WHERE id=?),0)<>1
        AND NOT EXISTS(SELECT 1 FROM recorder r WHERE r.session_id=? AND r.generation=?
          AND r.status='recording' AND r.lease_until>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
        THEN 1 ELSE 0 END`,
      sourceId,
      identity.key,
      kind,
      meta.sessionId,
      meta.deviceId,
      meta.generation || 0,
      meta.sequence,
      hash,
      mime,
      key,
      bytes.byteLength,
      meta.duration || null,
      captured,
      time,
      m.id,
      source.text,
      source.status,
      kind, meta.sessionId, meta.sessionId, meta.generation || 0,
    ),
    stmt(db, `INSERT INTO events(entity_id,type,payload,actor,created_at)
      SELECT id,'source.stored',json_set(?,'$.quarantined',json(CASE quarantined WHEN 1 THEN 'true' ELSE 'false' END),'$.status',CASE quarantined WHEN 1 THEN 'held' ELSE status END),?,?
      FROM evidence WHERE changes()=1 AND id=? AND identity=? AND hash=?`, stringify(source), m.id, time, sourceId, identity.key, hash),
  ];
  if (kind === "audio" && !quarantined)
    statements.push(
      stmt(
        db,
        "INSERT OR IGNORE INTO jobs(id,kind,source_id,status,created_at) SELECT ?,'transcription',?,'pending',? WHERE changes()=1 AND EXISTS(SELECT 1 FROM evidence WHERE id=? AND identity=? AND hash=? AND quarantined=0)",
        `transcription:${sourceId}`,
        sourceId,
        time,
        sourceId, identity.key, hash,
      ),
    );
  await db.batch(statements);
  const saved = await one(
    db,
    "SELECT * FROM evidence WHERE identity=?",
    identity.key,
  );
  need(saved?.hash === hash, "Upload identity conflict.", 409);
  return {
    stored: true,
    id: saved.id,
    hash: saved.hash,
    quarantined: !!saved.quarantined,
  };
}
export async function handleRequest(req, env, user) {
  try {
    need(env.DB && env.BUCKET, "Private storage is not configured.", 503);
    const db = env.DB,
      url = new URL(req.url),
      path = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    const m = await auth(db, user, env);
    if (req.method !== "GET")
      assertSameOrigin(req.headers.get("origin"), req.url);
    if (req.method === "GET" && path === "me") return reply({member:{id:m.id,name:m.name,role:m.role}});
    if (req.method === 'GET' && path === 'transcripts') {
      const format = url.searchParams.get('format') || 'md';
      need(['md','jsonl'].includes(format), 'Unknown transcript format.');
      const top = await one(db,"SELECT captured_at,id FROM evidence WHERE kind='audio' ORDER BY captured_at DESC,id DESC LIMIT 1");
      let cursor = {at:-1,id:''};
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          if (format === 'md') controller.enqueue(encoder.encode(TRANSCRIPT_PREAMBLE));
          if (!top) controller.close();
        },
        async pull(controller) {
          const rows = await all(db,"SELECT * FROM evidence WHERE kind='audio' AND (captured_at>? OR (captured_at=? AND id>?)) AND (captured_at<? OR (captured_at=? AND id<=?)) ORDER BY captured_at,id LIMIT 25",cursor.at,cursor.at,cursor.id,top.captured_at,top.captured_at,top.id);
          for (const source of rows) {
            const row = transcriptRecord(wireEvidence(source),url.origin);
            controller.enqueue(encoder.encode(format === 'jsonl' ? JSON.stringify(row)+'\n' : transcriptMarkdown(row)));
          }
          if (rows.length < 25) controller.close();
          else {const last=rows.at(-1);cursor={at:last.captured_at,id:last.id};}
        },
      });
      return new Response(stream,{headers:{
        'Content-Type':format==='jsonl'?'application/x-ndjson; charset=utf-8':'text/plain; charset=utf-8',
        'Content-Disposition':`attachment; filename="session-transcripts.${format}"`,
        'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      }});
    }
    if (req.method === 'GET' && path === 'state') {
      const [recorders,sources,records,jobs] = await Promise.all([
        all(db,'SELECT * FROM recorder'),
        all(db,'SELECT * FROM evidence ORDER BY captured_at DESC LIMIT 200'),
        all(db,'SELECT * FROM records ORDER BY created_at DESC LIMIT 200'),
        all(db,'SELECT kind,status,count(*) AS count FROM jobs GROUP BY kind,status')]);
      return reply({member:m,recorders,recorder:recorders.find(r=>r.id==='room'),
        sources:sources.map(wireEvidence),records:records.map(r=>({...r,payload:parse(r.payload)})),
        jobs,policy:POLICY,asOf:now()});
    }
    if (req.method === "GET" && path === "search") {
      const q = String(url.searchParams.get("q") || "").slice(0, 200);
      const query = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      const before = Number(
        url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
      );
      const sources = await all(
        db,
        "SELECT * FROM evidence WHERE captured_at<? AND text LIKE ? ESCAPE '\\' ORDER BY captured_at DESC LIMIT 50",
        before,
        query,
      );
      return reply({ sources: sources.map(wireEvidence) });
    }
    if (req.method === "GET" && path.startsWith("source/")) {
      const source = await one(
        db,
        "SELECT * FROM evidence WHERE id=?",
        path.slice(7),
      );
      need(source, "Source not found.", 404);
      return reply({ source: wireEvidence(source) });
    }
    if (req.method === "GET" && path.startsWith("media/")) {
      const source = await one(
        db,
        "SELECT * FROM evidence WHERE id=?",
        path.slice(6),
      );
      need(source?.object_key, "Source not found.", 404);
      const object = await env.BUCKET.get(source.object_key);
      need(object, "Media expired or unavailable.", 404);
      return new Response(object.body, {
        headers: {
          "Content-Type": source.mime,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    }
    if (req.method === "POST" && path === "evidence")
      return reply(await storeEvidence(db, env, m, req));
    need(req.method === "POST", "Unknown operation.", 404);
    const b = await json(req);
    if (path === "recorder/import") {
      need(
        b.policy === POLICY &&
          b.consentAccepted === true &&
          b.processingAccepted === true,
        "Confirm consent, retention and permitted local transcription.",
      );
      need(
        /^[a-zA-Z0-9_-]{1,100}$/.test(b.sessionId || "") &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(b.deviceId || "") &&
          Array.isArray(b.participants) &&
          b.participants.length > 0,
        "Invalid import session.",
      );
      await run(
        db,
        "INSERT OR IGNORE INTO sessions(id,device_id,generation,owner_id,consent,created_at) VALUES(?,?,0,?,?,?)",
        b.sessionId,
        b.deviceId,
        m.id,
        stringify({
          policy: POLICY,
          participants: b.participants,
          imported: true,
          operator: m.id,
        }),
        now(),
      );
      return reply({
        sessionId: b.sessionId,
        deviceId: b.deviceId,
        generation: 0,
      });
    }
    if (path === "recorder/start") {
      const recorder = await sessionStart(db, m, b), serverTime = now();
      return reply({ recorder, serverTime, leaseForMs: Math.max(0, recorder.lease_until-serverTime) });
    }
    if (path === "recorder/renew") {
      const lock = await one(db, "SELECT * FROM recorder WHERE session_id=?", b.sessionId);
      need(
        lock?.owner_id === m.id &&
          canRenew(
            {
              sessionId: lock.session_id,
              deviceId: lock.device_id,
              generation: lock.generation,
              leaseUntil: lock.lease_until,
            },
            b,
            now(),
          ),
        "Recording ownership expired or was transferred.",
        409,
      );
      const time = now(), expires = time + 60000;
      const renewed = await run(db, "UPDATE recorder SET lease_until=? WHERE session_id=? AND device_id=? AND generation=? AND owner_id=? AND status='recording' AND lease_until>?", expires, b.sessionId, b.deviceId, b.generation, m.id, time);
      need(renewed.meta.changes === 1, "Recording authorization changed.", 409);
      return reply({ leaseUntil: expires, serverTime: time, leaseForMs: 60000 });
    }
    if (path === "recorder/release") {
      need(typeof b.sessionId==='string' && typeof b.deviceId==='string' && Number.isSafeInteger(b.generation),'Invalid recorder claim.');
      const match="session_id=? AND device_id=? AND generation=? AND owner_id=? AND status='recording'";
      const args=[b.sessionId,b.deviceId,b.generation,m.id];
      const result=await db.batch([
        stmt(db,`UPDATE sessions SET ended_at=COALESCE(ended_at,?) WHERE id=(SELECT session_id FROM recorder WHERE ${match})`,now(),...args),
        stmt(db,`UPDATE recorder SET lease_until=0,status='paused' WHERE ${match}`,...args),
      ]);
      return reply({released:result[1].meta.changes===1});
    }
    if (path === "evidence/review") {
      const source = await one(db, "SELECT * FROM evidence WHERE id=?", b.id);
      need(source && source.kind === "audio" && source.quarantined && source.hash === b.hash && source.revision === b.revision, "Source changed. Refresh before review.", 409);
      need(source.author_id === m.id || m.role === "admin", "Source owner required.", 403);
      need(b.policy === POLICY, "Review the processing policy first.", 400);
      const revision = source.revision + 1, payload = {...wireEvidence(source), revision, quarantined:false, status:"pending", processingApprovedBy:m.id};
      const changes = await db.batch([
        stmt(db, "UPDATE evidence SET quarantined=0,revision=? WHERE id=? AND revision=? AND quarantined=1", revision, source.id, source.revision),
        stmt(db, "INSERT INTO events(entity_id,type,payload,actor,created_at) SELECT ?,'source.reviewed',?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM evidence WHERE id=? AND revision=? AND quarantined=0)", source.id, stringify(payload), m.id, now(), source.id, revision),
        stmt(db, "INSERT OR IGNORE INTO jobs(id,kind,source_id,status,created_at) SELECT ?,'transcription',?,'pending',? WHERE changes()=1 AND EXISTS(SELECT 1 FROM evidence WHERE id=? AND revision=? AND quarantined=0)", `transcription:${source.id}`, source.id, now(), source.id, revision)
      ]);
      need(changes[0].meta.changes === 1, "Source changed during review.", 409);
      return reply({ok:true});
    }
    if (path === "notes") {
      const text = cleanText(b.text),
        sourceId = b.id || id();
      need(/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId), "Invalid note ID.");
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
      )
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      const existing = await one(
        db,
        "SELECT * FROM evidence WHERE id=?",
        sourceId,
      );
      if (existing) {
        need(existing.hash === hash, "Note identity conflict.", 409);
        return reply({ id: sourceId, replayed: true });
      }
      const time = now(),
        source = {
          id: sourceId,
          kind: "note",
          text,
          hash,
          capturedAt: time,
          storedAt: time,
          status: "ready",
          revision: 1,
        };
      await db.batch([
        stmt(
          db,
          "INSERT INTO evidence(id,identity,kind,hash,captured_at,stored_at,author_id,text,status) VALUES(?,?,'note',?,?,?,?,?,'ready')",
          sourceId,
          `note:${sourceId}`,
          hash,
          time,
          time,
          m.id,
          text,
        ),
        event(db, sourceId, "source.noted", source, m.id),
      ]);
      return reply({ id: sourceId });
    }
    if (path === "candidates/propose") {
      need(
        [
          "IDEA",
          "QUESTION",
          "PROPOSAL",
          "DECISION_CANDIDATE",
          "ACTION_CANDIDATE",
          "RESULT_CLAIM",
        ].includes(b.type),
        "Invalid proposal type.",
      );
      const source = await one(
        db,
        "SELECT * FROM evidence WHERE id=?",
        b.sourceId,
      );
      need(source, "Choose an existing source.", 404);
      const recordId = id(),
        payload = {
          id: recordId,
          type: b.type,
          text: cleanText(b.text, 2000),
          sources: [source.id],
          sourceRevision: source.revision,
          status: "proposed",
        };
      await db.batch([
        stmt(
          db,
          "INSERT INTO records(id,kind,status,payload,author_id,created_at) VALUES(?,'candidate','proposed',?,?,?)",
          recordId,
          stringify(payload),
          m.id,
          now(),
        ),
        event(db, recordId, "candidate.proposed", payload, m.id),
      ]);
      return reply({ id: recordId });
    }
    if (path === "decisions/confirm" || path === "candidates/reject") {
      const candidate = await one(
        db,
        "SELECT * FROM records WHERE id=? AND kind='candidate'",
        b.id,
      );
      need(
        candidate &&
          candidate.version === b.version &&
          candidate.status === "proposed",
        "Proposal changed; refresh before reviewing.",
        409,
      );
      const old = parse(candidate.payload),
        decisionId = id(),
        payload = {
          id: decisionId,
          text: cleanText(b.text || old.text, 4000),
          sources: old.sources,
          sourceRevision: old.sourceRevision,
          status: "confirmed",
          approvedBy: m.id,
          approvedAt: now(),
          reversal: b.reversal || "Human review",
          candidateId: candidate.id,
        };
      for (const sourceId of old.sources)
        need(
          await one(db, "SELECT id FROM evidence WHERE id=? AND (?='candidates/reject' OR revision=?)", sourceId,path,old.sourceRevision),
          "Cited source changed. Propose a new candidate from its current revision.",
          409,
        );
      const status = path === "candidates/reject" ? "rejected" : "confirmed";
      const reviewed = stringify({
        ...old,
        reviewedBy: m.id,
        reviewedDecision: decisionId,
      });
      const statements = [
        stmt(
          db,
          "UPDATE records SET status=?,payload=?,version=version+1 WHERE id=? AND version=? AND status='proposed' AND (?='rejected' OR EXISTS(SELECT 1 FROM evidence WHERE id=? AND revision=?))",
          status,
          reviewed,
          candidate.id,
          b.version,
          status,old.sources[0],old.sourceRevision,
        ),
      ];
      if (status === "confirmed")
        statements.push(
          stmt(
            db,
            "INSERT INTO records(id,kind,status,payload,author_id,created_at) SELECT ?,'decision','confirmed',?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND version=? AND status='confirmed' AND payload=?)",
            decisionId,
            stringify(payload),
            m.id,
            now(),
            candidate.id,
            b.version + 1,
            reviewed,
          ),
          stmt(
            db,
            "INSERT INTO events(entity_id,type,payload,actor,created_at) SELECT ?,'decision.confirmed',?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=?)",
            decisionId,
            stringify(payload),
            m.id,
            now(),
            decisionId,
          ),
        );
      const changed = await db.batch(statements);
      need(changed[0].meta.changes === 1, "Proposal already reviewed.", 409);
      return reply({
        ok: true,
        id: status === "confirmed" ? decisionId : candidate.id,
      });
    }
    if(path === 'transcripts/attach') {
      const source=await one(db,"SELECT * FROM evidence WHERE id=? AND kind='audio'",b.id);
      need(source && !source.quarantined && source.revision===b.revision,'Review the held source or refresh its revision first.',409);
      const text=cleanText(b.text,50000);
      const changed=await db.batch([
        stmt(db,"UPDATE evidence SET text=?,status='ready',revision=revision+1 WHERE id=? AND revision=? AND quarantined=0",text,b.id,b.revision),
        stmt(db,"UPDATE jobs SET status='done',last_error=NULL WHERE source_id=? AND changes()=1",b.id),
        stmt(db,"INSERT INTO events(entity_id,type,payload,actor,created_at) SELECT ?,'source.transcribed',?,?,? WHERE EXISTS(SELECT 1 FROM evidence WHERE id=? AND revision=? AND text=?)",b.id,stringify({id:b.id,text}),m.id,now(),b.id,b.revision+1,text)]);
      need(changed[0].meta.changes===1,'Source changed during transcription.',409);
      return reply({ok:true});
    }
    if(path === 'jobs/retry') {
      await run(db,"UPDATE jobs SET status='pending',attempts=0,last_error=NULL WHERE (status='error' OR (status IN ('pending','running') AND attempts>=4 AND (status<>'running' OR lease_until<?))) AND source_id IN (SELECT id FROM evidence WHERE quarantined=0 AND status<>'ready')",now());
      return reply({ok:true});
    }
    throw new AppError('Unknown operation.',404);
  } catch(error) {
    return reply({error:error instanceof AppError ? error.message : 'Operation failed. Retry safely.'},error instanceof AppError ? error.status : 500);
  }
}
