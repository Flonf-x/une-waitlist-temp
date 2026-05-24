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
import { timingSafeEqual } from 'node:crypto';
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
// Clé d'accès à la page d'admin (vue interne des inscrits). Vide = admin désactivée.
const ADMIN_KEY = process.env.ADMIN_KEY || '';

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
  const text = `une.

On t'a bien ajouté·e à la waitlist.

On t'écrit dès qu'on ouvre — dans les prochaines semaines.
Si tu fais partie des 100 premiers, ta première pellicule est à -50 %.

—

Une pellicule.
Une pose.
Une promesse.
Une surprise.
Une révélation.
Une trace.

ca restera unique.

—

À très vite,
L'équipe une.

—
Tu reçois ce mail parce que tu t'es inscrit·e sur une-app.fr.
Te désinscrire : ${unsubLink}`;
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;background:#F1ECE4;color:#161412;padding:40px 24px;max-width:560px;margin:0 auto">
<div style="text-align:center;margin-bottom:32px">
<img src="https://une-app.fr/assets/une-logo-email.png" alt="une." width="200" style="width:200px;max-width:60%;height:auto;display:inline-block">
</div>
<p style="font-size:16px;line-height:1.6;margin:0 0 16px">On t'a bien ajouté·e à la waitlist.</p>
<p style="font-size:16px;line-height:1.6;margin:0 0 24px">On t'écrit dès qu'on ouvre — dans les prochaines semaines.<br>
Si tu fais partie des 100 premiers, ta première pellicule est à -50 %.</p>
<div style="text-align:center;margin:36px 0;font-size:18px;line-height:1.9">
Une pellicule.<br>Une pose.<br>Une promesse.<br>Une surprise.<br>Une révélation.<br>Une trace.<br><br>
<span style="font-style:italic">ca restera unique.</span>
</div>
<p style="font-size:16px;line-height:1.6;margin:24px 0 0">À très vite,<br>L'équipe une.</p>
<hr style="border:none;border-top:1px solid #d8d0c4;margin:32px 0 16px">
<p style="font-size:12px;color:#8a8276;line-height:1.5;margin:0">Tu reçois ce mail parce que tu t'es inscrit·e sur une-app.fr.<br>
<a href="${unsubLink}" style="color:#8a8276">Te désinscrire</a></p>
</div>`;
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
    return res
      .status(429)
      .json({ error: { code: 'RATE_LIMITED', message: 'Trop de tentatives.' } });
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
  if (ts !== null && Date.now() - ts < MIN_FORM_FILL_MS)
    return res.status(200).json({ accepted: true });
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
    return res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Erreur interne du serveur.' } });
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
    return res
      .status(r.rows.length ? 200 : 404)
      .type('html')
      .send(unsubPage(r.rows.length > 0));
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

// ── GET /api/v1/waitlist/admin?key=<ADMIN_KEY> ────────────────────────────────
// Vue interne (non publique) de la liste des inscrits. Protégée par ADMIN_KEY.
// Comparaison à temps constant pour éviter les attaques par timing.
function adminKeyOk(provided) {
  if (!ADMIN_KEY) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

app.get('/api/v1/waitlist/admin', async (req, res) => {
  if (!ADMIN_KEY) {
    return res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('Admin désactivée : définis la variable ADMIN_KEY sur le service, puis redéploie.');
  }
  if (!adminKeyOk(req.query.key)) {
    return res.status(401).type('text/plain; charset=utf-8').send('Clé invalide.');
  }
  try {
    const r = await pool.query(
      `SELECT id::text, position, email, source, ref_code, created_at, unsubscribed_at
       FROM waitlist_emails
       ORDER BY position`,
    );
    return res.status(200).type('html').send(adminPage(r.rows));
  } catch (err) {
    console.error('admin: erreur non gérée', err);
    return res.status(500).type('text/plain; charset=utf-8').send('Erreur interne.');
  }
});

// ── POST /api/v1/waitlist/admin/position ──────────────────────────────────────
// Met à jour la position (rang waitlist) d'un inscrit. Protégé par ADMIN_KEY
// (clé passée dans le corps JSON). N'impose pas l'unicité des positions.
app.post('/api/v1/waitlist/admin/position', async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin_disabled' });
  const body = req.body || {};
  if (!adminKeyOk(body.key)) return res.status(401).json({ error: 'unauthorized' });
  const id = Number.parseInt(body.id, 10);
  const position = Number.parseInt(body.position, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id' });
  if (!Number.isInteger(position) || position < 0 || position > 2147483647) {
    return res.status(400).json({ error: 'bad_position' });
  }
  try {
    const r = await pool.query(
      `UPDATE waitlist_emails SET position = $1 WHERE id = $2 RETURNING id::text, position`,
      [position, id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json({ ok: true, id: r.rows[0].id, position: r.rows[0].position });
  } catch (err) {
    console.error('admin position: erreur non gérée', err);
    return res.status(500).json({ error: 'internal' });
  }
});

function adminPage(rows) {
  // `<` neutralisé pour éviter toute fermeture prématurée de <script>.
  const data = JSON.stringify(rows).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>waitlist une. — admin</title>
<style>
  :root{--paper:#f1ece4;--ink:#161412;--mut:#8a8276;--line:#d8d0c4}
  *{box-sizing:border-box}
  body{font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;margin:0;background:var(--paper);color:var(--ink);line-height:1.5}
  .wrap{max-width:1000px;margin:0 auto;padding:32px 20px 64px}
  h1{font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 4px}
  .sub{color:var(--mut);font-size:13px;margin:0 0 24px}
  .stats{display:flex;gap:28px;flex-wrap:wrap;margin:0 0 20px;font-size:13px;color:var(--mut)}
  .stats b{font-size:24px;display:block;font-family:Georgia,serif;color:var(--ink)}
  .bar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 16px}
  input[type=search]{flex:1;min-width:220px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:14px;color:var(--ink)}
  label.tog{font-size:13px;color:var(--mut);display:flex;align-items:center;gap:6px;cursor:pointer}
  button{padding:9px 14px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);border-radius:8px;font-size:13px;cursor:pointer}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
  th{background:#faf7f1;font-weight:600;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  td.email{font-family:ui-monospace,'SF Mono',monospace}
  tr.unsub td{color:var(--mut);text-decoration:line-through}
  input.pos{width:62px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:13px;background:#fff;color:var(--ink)}
  input.pos:focus{outline:2px solid var(--ink);outline-offset:1px}
  input.pos:disabled{opacity:.5}
  tr.saved td{background:#e6efe0;transition:background .1s}
  .hint{color:var(--mut);font-size:12px;margin:0 0 16px}
  .empty{color:var(--mut);padding:40px;text-align:center;background:#fff;border:1px solid var(--line);border-radius:10px}
</style></head>
<body><div class="wrap">
  <h1>une. — waitlist</h1>
  <p class="sub">vue interne · ne partage pas cette url (elle contient ta clé d'accès)</p>
  <div class="stats" id="stats"></div>
  <div class="bar">
    <input type="search" id="q" placeholder="rechercher un email, une source, un code…" autocomplete="off">
    <label class="tog"><input type="checkbox" id="showUnsub"> afficher les désinscrits</label>
    <button id="csv">exporter le CSV</button>
  </div>
  <p class="hint">la colonne <strong>#</strong> (position / rang dans la waitlist) est modifiable : change la valeur puis Entrée ou clique ailleurs pour enregistrer. Les positions ne sont pas forcées uniques.</p>
  <div id="tablewrap"></div>
<script>
var ROWS = ${data};
var NL = String.fromCharCode(10);
var KEY = new URLSearchParams(location.search).get('key') || '';
var q = document.getElementById('q');
var showUnsub = document.getElementById('showUnsub');
function isActive(r){ return !r.unsubscribed_at; }
function fmtDate(s){ if(!s) return ''; var d = new Date(s); if(isNaN(d.getTime())) return String(s);
  return d.toLocaleString('fr-FR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function visible(){
  var term = q.value.trim().toLowerCase();
  return ROWS.filter(function(r){
    if(!showUnsub.checked && r.unsubscribed_at) return false;
    if(!term) return true;
    return [r.email, r.source, r.ref_code].some(function(v){ return v && String(v).toLowerCase().indexOf(term) >= 0; });
  }).sort(function(a,b){ return (a.position - b.position) || (a.email < b.email ? -1 : 1); });
}
function render(){
  var rows = visible();
  var total = ROWS.length, act = ROWS.filter(isActive).length, uns = total - act;
  document.getElementById('stats').innerHTML =
    '<div><b>'+act+'</b>inscrits actifs</div>'+
    '<div><b>'+uns+'</b>désinscrits</div>'+
    '<div><b>'+total+'</b>total</div>';
  var wrap = document.getElementById('tablewrap');
  if(!rows.length){ wrap.innerHTML = '<div class="empty">aucun inscrit pour le moment.</div>'; return; }
  var t = document.createElement('table');
  var thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>#</th><th>email</th><th>source</th><th>code</th><th>inscrit le</th><th>statut</th></tr>';
  t.appendChild(thead);
  var tb = document.createElement('tbody');
  rows.forEach(function(r){
    var tr = document.createElement('tr');
    if(r.unsubscribed_at) tr.className = 'unsub';
    function td(text, cls){ var d = document.createElement('td'); if(cls) d.className = cls; d.textContent = (text==null?'':String(text)); return d; }
    var posTd = document.createElement('td');
    var inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'pos'; inp.min = '0'; inp.step = '1'; inp.value = r.position;
    inp.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); inp.blur(); } });
    inp.addEventListener('change', function(){ savePos(r, inp); });
    posTd.appendChild(inp);
    tr.appendChild(posTd);
    tr.appendChild(td(r.email,'email'));
    tr.appendChild(td(r.source || '—'));
    tr.appendChild(td(r.ref_code || '—'));
    tr.appendChild(td(fmtDate(r.created_at)));
    tr.appendChild(td(r.unsubscribed_at ? 'désinscrit' : 'actif'));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  wrap.innerHTML = '';
  wrap.appendChild(t);
}
function savePos(r, inp){
  var v = parseInt(inp.value, 10);
  if(isNaN(v) || v < 0){ inp.value = r.position; return; }
  if(v === r.position) return;
  inp.disabled = true;
  fetch('/api/v1/waitlist/admin/position', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, id: r.id, position: v })
  }).then(function(res){
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function(){
    r.position = v;
    render();
  }).catch(function(err){
    alert('Échec de la mise à jour de la position : ' + err.message);
    inp.value = r.position;
    inp.disabled = false;
  });
}
function csvCell(v){
  v = (v==null ? '' : String(v));
  if(v.indexOf(',')>=0 || v.indexOf('"')>=0 || v.indexOf(';')>=0 || v.indexOf(NL)>=0){
    v = '"' + v.split('"').join('""') + '"';
  }
  return v;
}
document.getElementById('csv').addEventListener('click', function(){
  var rows = visible();
  var lines = [['position','email','source','ref_code','created_at','unsubscribed_at'].join(',')];
  rows.forEach(function(r){
    lines.push([r.position, r.email, r.source, r.ref_code, r.created_at, r.unsubscribed_at].map(csvCell).join(','));
  });
  var blob = new Blob([lines.join(NL)], {type:'text/csv;charset=utf-8'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'waitlist-une-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
});
q.addEventListener('input', render);
showUnsub.addEventListener('change', render);
render();
</script>
</div></body></html>`;
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
