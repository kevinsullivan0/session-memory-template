export async function saveSegment(store, segment) {
  const bytes = await segment.blob.arrayBuffer();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const row = {
    ...segment,
    meta: { ...segment.meta, hash, sourceId: segment.id },
  };
  await store.put(row);
  return row;
}
export async function flushSegments(store, upload) {
  const results = [];
  for (const row of await store.list()) {
    // A failed start has no confirmed session. Preserve its download; do not retry it as live audio.
    if (row.meta.provisional) continue;
    try {
      const receipt = await upload(row);
      if (receipt?.stored === true && receipt.hash === row.meta.hash) {
        await store.delete(row.id);
        results.push({ id: row.id, stored: true, receipt });
      } else
        results.push({
          id: row.id,
          stored: false,
          error: "Storage receipt did not match.",
        });
    } catch (error) {
      results.push({
        id: row.id,
        stored: false,
        error: error.message || "Upload failed.",
      });
    }
  }
  return results;
}
export async function openQueue(accountId) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(`session-memory-audio-${accountId}`, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("segments", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const op = (mode, fn) =>
    new Promise((resolve, reject) => {
      const tx = database.transaction("segments", mode);
      const req = fn(tx.objectStore("segments"));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error || req.error);
      tx.onerror = () => reject(tx.error || req.error);
    });
  return {
    put: (r) => op("readwrite", (s) => s.put(r)),
    list: () => op("readonly", (s) => s.getAll()),
    delete: (id) => op("readwrite", (s) => s.delete(id)),
    close: () => database.close(),
  };
}
