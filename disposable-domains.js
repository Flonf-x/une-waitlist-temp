// Domaines email jetables fréquents — copie de
// apps/backend/src/domains/marketing/waitlist/disposable-domains.ts (MKT-3).
// Stratégie : on filtre les domaines fréquents, on accepte le reste. Le rate-limit
// IP + honeypot + timing < 2 s arrêtent l'essentiel du trafic automatisé.
export const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  '10minutemail.net',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.biz',
  'guerrillamailblock.com',
  'mailinator.com',
  'mailinator.net',
  'maildrop.cc',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'throwawaymail.com',
  'yopmail.com',
  'yopmail.fr',
  'fakeinbox.com',
  'getnada.com',
  'mohmal.com',
  'sharklasers.com',
  'trashmail.com',
  'trashmail.net',
  'trashmail.de',
  'spamgourmet.com',
  'mytemp.email',
  'dispostable.com',
  'jetable.org',
  'jetable.fr.nf',
  'jetable.net',
  'speed.1s.fr',
]);

export function isDisposableDomain(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return DISPOSABLE_DOMAINS.has(email.slice(at + 1).toLowerCase());
}
