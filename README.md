# une-waitlist-temp — backend waitlist temporaire

Petit service Express qui **réplique le contrat** de `apps/backend/src/domains/marketing/waitlist` du monorepo `une.`, le temps que le backend NAS de prod soit accessible publiquement en HTTPS sur `une-app.fr`.

Il existe pour une seule raison : **capturer de vrais emails dès la mise en ligne de la landing**, sans attendre INFRA-1/2 (provisionnement NAS).

## Ce qu'il expose

| Méthode | Route                                       | Comportement                                                                                                                                                                                                                   |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST`  | `/api/v1/waitlist`                          | Body `{ email, source?, ref_code?, company?, ts? }`. Réponse uniforme `200 { accepted: true }` (anti-énumération). `400` si email malformé, `429` si rate-limit. Honeypot / timing < 2 s / domaine jetable → `200` silencieux. |
| `GET`   | `/api/v1/waitlist/unsubscribe?token=<uuid>` | Désinscription one-click idempotente, page HTML FR.                                                                                                                                                                            |
| `GET`   | `/api/v1/waitlist/admin?key=<ADMIN_KEY>`    | **Vue interne** des inscrits (tableau, recherche, compteurs, **position éditable**, export CSV). Protégée par `ADMIN_KEY`. `401` si clé absente/incorrecte, `503` si `ADMIN_KEY` non définie. Voir [§ Voir les inscrits](#voir-les-inscrits--page-dadmin). |
| `POST`  | `/api/v1/waitlist/admin/position`           | Met à jour la `position` (rang waitlist) d'un inscrit. Corps JSON `{ key, id, position }`. Protégée par `ADMIN_KEY` (clé dans le corps). `400` id/position invalide, `401` clé fausse, `404` introuvable, `503` admin désactivée. Appelée par la page d'admin. |
| `GET`   | `/health`                                   | `{ ok: true }` (healthcheck).                                                                                                                                                                                                  |

Contrat **identique** à celui de la landing → aucune modification du formulaire au moment de bascule vers la prod.

## Variables d'environnement

Voir [`.env.example`](.env.example). Les essentielles : `DATABASE_URL` (Postgres), `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL`, `PUBLIC_BACKEND_URL` (URL publique de ce service, pour le lien d'unsub), `ALLOWED_ORIGINS` (CORS).

## Voir les inscrits — page d'admin

Vue interne (non publique) qui liste les inscriptions dans un tableau — recherche, compteurs (actifs / désinscrits / total), bascule « afficher les désinscrits », **position (rang) éditable en place**, export CSV — **sans passer par SQL**.

1. Définis la clé d'accès sur le service : variable `ADMIN_KEY` = une longue chaîne aléatoire (≥ 32 caractères). Génère-la avec :
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   - **Render** : service `une-waitlist-temp` → onglet **Environment** → ajoute `ADMIN_KEY` → Save (redeploy auto).
   - **Fly** : `fly secrets set ADMIN_KEY="…"`.
2. Ouvre dans ton navigateur :
   ```
   https://une-waitlist-temp.onrender.com/api/v1/waitlist/admin?key=TA_CLE
   ```

**Modifier la position (rang).** La colonne `#` est éditable : change la valeur, puis Entrée ou clic ailleurs → la page appelle `POST /api/v1/waitlist/admin/position` (même clé) et ré-ordonne le tableau. Les positions ne sont pas forcées uniques (à toi de garder un ordre cohérent). L'`id` (clé technique) n'est volontairement pas modifiable. Tu peux toujours réordonner en masse via SQL (voir ci-dessous).

Sécurité : page `noindex`, comparaison de clé à temps constant, clé envoyée dans le corps JSON pour l'écriture. `ADMIN_KEY` vide → désactivée (`503`) ; clé absente/fausse → `401`. **Garde cette URL privée** (la clé y figure) et ne la mets jamais sur la landing publique.

## Base de données

Crée une base **Neon** gratuite et persistante : https://neon.tech → nouveau projet → copie le _connection string_ (`postgresql://…?sslmode=require`) dans `DATABASE_URL`. Le schéma (`schema.sql`) est appliqué automatiquement au démarrage (idempotent) — rien à migrer à la main.

> Pourquoi Neon plutôt que la base Render : le free tier Render Postgres expire après 30 jours, Neon non.

## Déploiement — option A : Render (le plus simple)

1. Pousse ce dossier dans un repo Git (peut rester **privé**).
2. Render → **New → Blueprint** → sélectionne le repo (le [`render.yaml`](render.yaml) est détecté).
3. Renseigne `DATABASE_URL` (Neon) et `SENDGRID_API_KEY`.
4. Après le 1er déploiement, copie l'URL `https://une-waitlist-temp.onrender.com` attribuée → mets-la dans `PUBLIC_BACKEND_URL` → redeploy.

> Note free tier Render : l'instance s'endort après 15 min d'inactivité (1ère requête ~30 s à réveiller). Acceptable en pre-launch.

## Déploiement — option B : Fly.io (région Paris)

```bash
fly launch --no-deploy
fly secrets set DATABASE_URL="postgresql://…" SENDGRID_API_KEY="SG.…" PUBLIC_BACKEND_URL="https://une-waitlist-temp.fly.dev"
fly deploy
```

## Brancher la landing

Dans `deploy/une-landing/index.html`, le bloc de config (dans `<head>`) :

```html
<script>
  window.UNE_API_BASE_URL = 'https://REMPLACE-PAR-TON-BACKEND.onrender.com';
</script>
```

Remplace l'URL par celle de ton service déployé, commit, push → GitHub Pages se met à jour.

## Test local

```bash
cp .env.example .env   # renseigne DATABASE_URL (Neon suffit)
npm install
npm start
# POST de test :
curl -i -X POST http://localhost:3000/api/v1/waitlist \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@exemple.fr","source":"local","ts": 0}'
# → HTTP/1.1 200  {"accepted":true}
```

## Récupérer les emails capturés (avant bascule prod)

```sql
SELECT email, source, ref_code, position, created_at
FROM waitlist_emails
WHERE unsubscribed_at IS NULL
ORDER BY position;
```

Exporte ce résultat et réimporte-le dans la table `waitlist_emails` du backend de prod quand il est en ligne.

## Démantèlement (quand le NAS prod est public)

1. Supprime le bloc `window.UNE_API_BASE_URL` de la landing → le formulaire repasse en same-origin sur `une-app.fr/api/v1/waitlist`.
2. Exporte les emails (requête ci-dessus) et importe-les en prod.
3. Supprime le service Render/Fly et la base Neon.
