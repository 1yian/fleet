export const QUEUED_DELIVERY = "'pending', 'resent'";
export const SENT_DELIVERY = "'pushed', 'pushed-again'";
export const UNREAD_DELIVERY = `${QUEUED_DELIVERY}, ${SENT_DELIVERY}`;
export const IN_FLIGHT_DELIVERY = `${UNREAD_DELIVERY}, 'read'`;
export const TAKEN_DELIVERY = "'acknowledged', 'confirmed'";
export const RETIRABLE_DELIVERY = "state <> 'confirmed'";

export function retireNoticeDeliveries(notices: string): string {
  return `UPDATE deliveries SET retired_at = ? WHERE retired_at IS NULL AND entry IN (
    WITH notices AS (${notices})
    SELECT id FROM notices
    UNION ALL
    SELECT f.id FROM notices n JOIN entries f ON f.card = n.card
    WHERE f.kind = 'finding' AND f.author = 'check'
      AND json_extract(f.fields, '$.condition') = 'missed'
      AND json_extract(f.fields, '$.entry') = n.id
  )`;
}
