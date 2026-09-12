export function adminCommandReceiptLockKey(actorId: string, idempotencyKey: string): string {
  return `admin:command-receipt:${actorId}:${idempotencyKey}`;
}
