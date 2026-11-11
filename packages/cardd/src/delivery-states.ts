export const QUEUED_DELIVERY = "'pending', 'resent'";
export const SENT_DELIVERY = "'pushed', 'pushed-again'";
export const UNREAD_DELIVERY = `${QUEUED_DELIVERY}, ${SENT_DELIVERY}`;
export const IN_FLIGHT_DELIVERY = `${UNREAD_DELIVERY}, 'read'`;
export const TAKEN_DELIVERY = "'acknowledged', 'confirmed'";
