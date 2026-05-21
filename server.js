// ════════════════════════════════════════════════════════════════════════════
// une. — backend waitlist TEMPORAIRE
//
// Réplique le contrat de apps/backend/src/domains/marketing/waitlist du
// monorepo une. :
//   POST /api/v1/waitlist               → { accepted: true } (réponse uniforme)
//   GET  /api/v1/waitlist/unsubscribe   → page HTML, one-click, idempotent
//   GET  /health                        → { ok: true }
//
// But : capturer les emails de la landing une-app.fr dès maintenant, le temps
// que le backend NAS de prod soit accessible publiquement en HTTPS. Quand ce
// sera le cas, supprimer le bloc window.UNE_API_BASE_URL de la landing : le
// formulaire repassera en same-origin sur le vrai backend, et on importera les
// emails capturés ici (SELECT email, source, ref_code, created_at ...).
// ════════════════════════════════════════════════════════════════════════════

import express from 'express';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDisposableDomain } from './disposable-domains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'bonjour@une-app.fr';
// URL publique DE CE SERVICE (pour fabriquer le lien de désinscription dans l'email).
const PUBLIC_BACKEND_URL = (process.env.PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
// Origines autorisées en CORS (la landing). Liste séparée par des virgules.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://une-app.fr,https://www.une-app.fr')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MIN_FORM_FILL_MS = 2000; // un humain ne soumet pas en moins de 2 s
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL manquant.');
  process.exit(1);
}

// ── Postgres ────────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // Les Postgres managés (Neon, Render, Fly) imposent TLS. rejectUnauthorized:false
  // suffit pour un service pre-launch (la connexion reste chiffrée).
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function migrate() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema.sql appliqué (idempotent).');
}

// ── SendGrid (best-effort) ───────────────────────────────────────────────────
let sg = null;
if (SENDGRID_API_KEY) {
  const mod = await import('@sendgrid/mail');
  sg = mod.default;
  sg.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('SENDGRID_API_KEY absent — les emails de confirmation seront ignorés.');
}

async function sendConfirmation(to, unsubToken) {
  if (!sg) return;
  const unsubLink = `${PUBLIC_BACKEND_URL}/api/v1/waitlist/unsubscribe?token=${unsubToken}`;
  const subject = 'Ta place est gardée.';
  const text = `On t'a bien ajouté·e à la waitlist.

On t'écrit dès qu'on ouvre — probablement les prochains mois.
Si tu fais partie des 100 premiers, ta première pellicule est à -50 %.

À très vite,
L'équipe une.

—
Tu reçois ce mail parce que tu t'es inscrit·e sur une-app.fr.
Te désinscrire : ${unsubLink}`;
  const html = `<p>On t'a bien ajouté·e à la waitlist.</p>
<p>On t'écrit dès qu'on ouvre — probablement les prochains mois.<br>
Si tu fais partie des 100 premiers, ta première pellicule est à -50 %.</p>
<p>À très vite,<br>L'équipe une.</p>
<hr>
<p style="font-size:0.85em;color:#666">Tu reçois ce mail parce que tu t'es inscrit·e sur une-app.fr.<br>
<a href="${unsubLink}">Te désinscrire</a></p>`;
  await sg.send({
    to,
    from: SENDGRID_FROM_EMAIL,
    replyTo: SENDGRID_FROM_EMAIL,
    subject,
    text,
    html,
  });
}

// ── Rate-limit IP en mémoire (5 / 10 min) ────────────────────────────────────
// En mémoire = suffisant pour une instance unique pre-launch. Un redémarrage
// remet le compteur à zéro (acceptable). Aligné sur marketing.router.ts.
const RL_LIMIT = 5;
const RL_WINDOW_MS = 10 * 60 * 1000;
const rlHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  rlHits.set(ip, arr);
  return arr.length > RL_LIMIT;
}
// Purge périodique pour éviter une fuite mémoire lente.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rlHits) {
    const keep = arr.filter((t) => now - t < RL_WINDOW_MS);
    if (keep.length) rlHits.set(ip, keep);
    else rlHits.delete(ip);
  }
}, RL_WINDOW_MS).unref();

// ── App ───────────────────────────────────────────────────────────────────--
const app = express();
app.set('trust proxy', 1); // derrière le proxy Render/Fly → vraie IP client
app.use(express.json({ limit: '16kb' }));

// CORS minimal, restreint aux origines de la landing.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── POST /api/v1/waitlist ─────────────────────────────────────────────────---
app.post('/api/v1/waitlist', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Trop de tentatives.' } });
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const source = typeof body.source === 'string' ? body.source.slice(0, 64) : null;
  const ref_code = typeof body.ref_code === 'string' ? body.ref_code.slice(0, 64) : null;
  const company = typeof body.company === 'string' ? body.company : '';
  const ts = typeof body.ts === 'number' ? body.ts : null;

  // Validation email → 400 (seule réponse non uniforme, comme le vrai backend)
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Email invalide.',
        details: [{ field: 'email', issue: 'format' }],
      },
    });
  }

  // Anti-spam silencieux → 200 { accepted:true } sans signal au bot
  if (company && company.length > 0) return res.status(200).json({ accepted: true });
  if (ts !== null && Date.now() - ts < MIN_FORM_FILL_MS) return res.status(200).json({ accepted: true });
  if (isDisposableDomain(email)) return res.status(200).json({ accepted: true });

  try {
    const inserted = await pool.query(
      `INSERT INTO waitlist_emails (email, source, ref_code, position)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), 0) + 1 FROM waitlist_emails))
       ON CONFLICT (email) DO NOTHING
       RETURNING id::text, position, unsub_token::text`,
      [email, source, ref_code],
    );
    if (inserted.rows.length > 0) {
      const row = inserted.rows[0];
      try {
        await sendConfirmation(email, row.unsub_token);
      } catch (err) {
        console.warn('Échec envoi confirmation (ignoré):', err?.message || err);
      }
    }
    // Nouvel inscrit OU déjà présent → même réponse (anti-énumération).
    return res.status(200).json({ accepted: true });
  } catch (err) {
    console.error('waitlist signup: erreur non gérée', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erreur interne du serveur.' } });
  }
});

// ── GET /api/v1/waitlist/unsubscribe?token=<uuid> ─────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get('/api/v1/waitlist/unsubscribe', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!UUID_RE.test(token)) {
    return res.status(400).type('html').send(unsubPage(false));
  }
  try {
    const r = await pool.query(
      `UPDATE waitlist_emails
       SET unsubscribed_at = COALESCE(unsubscribed_at, now())
       WHERE unsub_token = $1::uuid
       RETURNING id::text`,
      [token],
    );
    return res.status(r.rows.length ? 200 : 404).type('html').send(unsubPage(r.rows.length > 0));
  } catch (err) {
    console.error('unsubscribe: erreur non gérée', err);
    return res.status(500).type('html').send(unsubPage(false));
  }
});

function unsubPage(ok) {
  const heading = ok ? 'Bien noté.' : 'Lien invalide.';
  const body = ok
    ? "On retire ton adresse de la waitlist. On ne t'écrira plus."
    : "Ce lien de désinscription n'est plus valide. Si tu reçois encore des emails, écris-nous.";
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${ok ? 'Désinscription confirmée' : 'Lien invalide'} — une.</title>
<style>body{font-family:ui-serif,Georgia,serif;max-width:36em;margin:4em auto;padding:0 1em;color:#161412;background:#f1ece4;line-height:1.55}h1{font-weight:400;font-style:italic}a{color:#161412}</style>
</head><body><h1>${heading}</h1><p>${body}</p>
<p><a href="https://une-app.fr">Revenir sur une-app.fr</a></p></body></html>`;
}

// ── Démarrage ─────────────────────────────────────────────────────────────---
migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`une-waitlist-temp à l'écoute sur :${PORT}`));
  })
  .catch((err) => {
    console.error('FATAL: migration impossible', err);
    process.exit(1);
  });
