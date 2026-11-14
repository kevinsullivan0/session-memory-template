import test from "node:test";
import assert from "node:assert/strict";
import { saveSegment, flushSegments } from "../lib/capture-queue.mjs";
test('unconfirmed switches stay local without blocking current recording uploads',async()=>{
 const rows=[{id:'old',meta:{provisional:true,hash:'old'}},{id:'current',meta:{hash:'current'}}];
 const uploaded=[],removed=[];
 const results=await flushSegments({list:async()=>rows,delete:async id=>removed.push(id)},async row=>{uploaded.push(row.id);return {stored:true,hash:row.meta.hash};});
 assert.deepEqual(uploaded,['current']);
 assert.deepEqual(removed,['current']);
 assert.equal(results.filter(r=>r.stored).length,1);
});
function adapter() {
  const rows = new Map();
  return {
    put: async (r) => rows.set(r.id, r),
    list: async () => [...rows.values()],
    delete: async (id) => rows.delete(id),
    rows,
  };
}
test("sealed audio remains recoverable across a failed upload and removes only a matching durable receipt", async () => {
  const a = adapter();
  const source = {
    id: "segment-1",
    blob: new Blob(["sealed recording"]),
    meta: { sessionId: "s1", deviceId: "d1", sequence: 1 },
  };
  await saveSegment(a, source);
  assert.equal(a.rows.size, 1);
  await flushSegments(a, async () => {
    throw Error("network");
  });
  assert.equal(a.rows.size, 1);
  await flushSegments(a, async () => ({ stored: true, hash: "wrong" }));
  assert.equal(a.rows.size, 1);
  await flushSegments(a, async (row) => ({
    stored: true,
    hash: row.meta.hash,
    id: "stored-id",
  }));
  assert.equal(a.rows.size, 0);
});
test("quota failure is exposed before any upload acknowledgment", async () => {
  const a = adapter();
  a.put = async () => {
    throw Error("QuotaExceededError");
  };
  await assert.rejects(
    saveSegment(a, { id: "segment", blob: new Blob(["a"]), meta: {} }),
    /Quota/,
  );
});
