import type { Queryable } from '@voltline/db';

export type AuthorizationStatus = 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';

export interface IdTagInfo {
  status: AuthorizationStatus;
  expiryDate?: string;
  parentIdTag?: string;
}

/**
 * OCPP 1.6 authorization of an id tag (an RFID card, say).
 *
 * Unknown tags are Invalid, an Accepted tag past its expiry is Expired, and an Accepted tag that's
 * already in an open session is ConcurrentTx. Tags compare case-insensitively, because OCPP's
 * IdToken is a case-insensitive string (D-020).
 */
export async function authorizeIdTag(db: Queryable, idTag: string, now: Date): Promise<IdTagInfo> {
  const { rows } = await db.query<{
    status: Exclude<AuthorizationStatus, 'ConcurrentTx'>;
    expires_at: Date | null;
    parent_id_tag: string | null;
    in_open_session: boolean;
  }>(
    `SELECT status, expires_at, parent_id_tag,
            EXISTS (SELECT 1 FROM transactions
                     WHERE lower(id_tag) = lower($1) AND stopped_at IS NULL) AS in_open_session
       FROM id_tags
      WHERE lower(id_tag) = lower($1)`,
    [idTag],
  );
  const tag = rows[0];
  if (!tag) return { status: 'Invalid' };

  const info: IdTagInfo = { status: tag.status };
  if (tag.expires_at) info.expiryDate = tag.expires_at.toISOString();
  if (tag.parent_id_tag) info.parentIdTag = tag.parent_id_tag;
  if (tag.status === 'Accepted') {
    if (tag.expires_at && tag.expires_at <= now) info.status = 'Expired';
    else if (tag.in_open_session) info.status = 'ConcurrentTx';
  }
  return info;
}
