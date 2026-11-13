/**
 * Race-safe quota accounting for mailboxes.
 *
 * Every function here takes an explicit `client` — a connection already
 * inside a transaction (from `companyContext.withCompany`) — rather than
 * reaching for the shared pool itself. That's what makes the row lock mean
 * anything: two inbound messages landing in the same mailbox at once must
 * serialize on `used_bytes`, not race to read-then-write it independently.
 */

class QuotaExceededError extends Error {
  constructor(mailboxId, wouldUseBytes, quotaBytes) {
    super(`Mailbox ${mailboxId} is over quota: ${wouldUseBytes} bytes would exceed the ${quotaBytes}-byte limit.`);
    this.name = 'QuotaExceededError';
    this.code = 'MAILBOX_QUOTA_EXCEEDED';
    this.mailboxId = mailboxId;
    this.wouldUseBytes = wouldUseBytes;
    this.quotaBytes = quotaBytes;
  }
}

/**
 * Lock the mailbox row, check whether `incomingBytes` fits, and — if it does
 * — apply the increment in the same statement so the check and the write
 * can never be split by a concurrent message on the same mailbox.
 *
 * Throws QuotaExceededError (without writing anything) if it does not fit.
 */
async function reserve(client, mailboxId, incomingBytes) {
  const { rows } = await client.query(
    'SELECT used_bytes, quota_bytes FROM mailboxes WHERE id = $1 FOR UPDATE',
    [mailboxId]
  );
  if (!rows.length) throw new Error(`Mailbox ${mailboxId} does not exist.`);

  const { used_bytes: used, quota_bytes: quota } = rows[0];
  const wouldUse = Number(used) + Number(incomingBytes);
  if (wouldUse > Number(quota)) {
    throw new QuotaExceededError(mailboxId, wouldUse, quota);
  }

  await client.query(
    'UPDATE mailboxes SET used_bytes = used_bytes + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [mailboxId, incomingBytes]
  );
}

/** Give bytes back — used when a message/attachment is deleted. */
async function release(client, mailboxId, bytes) {
  await client.query(
    `UPDATE mailboxes
        SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [mailboxId, bytes]
  );
}

module.exports = { reserve, release, QuotaExceededError };
