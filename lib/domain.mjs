export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function assertSameOrigin(origin, url) {
  if (!origin || origin !== new URL(url).origin)
    throw new AppError("Same-origin request required.", 403);
}
export function evidenceIdentity(item, existing = null) {
  if (!Number.isSafeInteger(item.sequence) || item.sequence < 0)
    throw new AppError("Invalid segment sequence.");
  for (const k of ["sessionId", "deviceId"])
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item[k] ?? ""))
      throw new AppError("Invalid evidence identity.");
  if (!/^[a-f0-9]{64}$/.test(item.hash ?? ""))
    throw new AppError("Invalid content hash.");
  if (existing && existing.hash !== item.hash)
    throw new AppError(
      "Segment conflict: different bytes use the same identity.",
      409,
    );
  return {
    key: `${item.sessionId}:${item.deviceId}:${item.sequence}`,
    hash: item.hash,
  };
}
export function canRenew(lock, claim, now) {
  return (
    !!lock &&
    lock.sessionId === claim.sessionId &&
    lock.deviceId === claim.deviceId &&
    lock.generation === claim.generation &&
    lock.leaseUntil > now
  );
}
