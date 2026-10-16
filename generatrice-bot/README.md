# Bot Messenger — Solution NRJ (generatricediesel.com)

Un conseiller virtuel pour la Messenger de votre Page Facebook. Il discute
vraiment avec le client grâce à Claude (aucune réponse toute faite), répond aux
questions sur vos génératrices avec les prix et règles de votre PRD, qualifie le
besoin et demande le téléphone, puis passe la main à votre équipe quand le
client le demande.

## Ce que fait le bot

- **Conversation naturelle en français**, une question à la fois, avec le lien
  de la fiche du modèle dont il parle.
- **Infos fiables** : il s'appuie sur `src/business.ts`, repris du PRD (16
  modèles, prix avant taxes, garantie, filtres, règles). Il ne parle jamais du
  transport ni des inverseurs, ne mentionne jamais Cummins, et renvoie à l'équipe
  tout ce qui est « à confirmer ». Les coûts fournisseur n'y sont pas.
- **Qualification** : usage, puissance (ou équipements à alimenter), ville,
  tension et phases, boîtier, nom, téléphone. Chaque info est enregistrée dans
  une fiche prospect.
- **Transfert à un humain** dès que le client le demande (« je veux parler à
  quelqu'un », « appelez-moi »…), s'il est mécontent ou si la demande dépasse le
  bot. Le bot se met en pause 24 h pour ce client.
- **Pause automatique** : dès qu'un membre de l'équipe répond lui-même au client
  dans Meta Business Suite, le bot se tait pour ce client pendant 24 h. Pas de
  bot qui parle par-dessus vous.
- **Alerte** (facultatif) : un message Slack, Discord, Google Chat, Make ou
  Zapier quand un prospect laisse son téléphone ou demande un humain.
- **Liste des prospects** en CSV (Excel) : `https://<votre-worker>/leads?key=<ADMIN_TOKEN>`.
- Lit les photos (ex. plaque signalétique), répond poliment aux messages vocaux
  qu'il ne peut pas écouter, ignore les doublons de Meta, vérifie la signature
  de chaque message reçu.

---

## Guide pas à pas

Comptez environ 45 minutes. Il vous faut : un ordinateur, un compte Facebook
administrateur de la Page, une carte de crédit pour l'API Claude.

Gardez un bloc-notes ouvert : vous allez y copier **7 valeurs** au fil des
étapes.

| Valeur | Où on la trouve | Étape |
|---|---|---|
| `ANTHROPIC_API_KEY` | Console Claude | 1 |
| `META_APP_ID` | App Meta → Paramètres → Général | 3 |
| `META_APP_SECRET` | App Meta → Paramètres → Général | 3 |
| `META_PAGE_ACCESS_TOKEN` | App Meta → Messenger → Paramètres de l'API | 4 |
| `META_VERIFY_TOKEN` | Vous l'inventez | 4 |
| `ADMIN_TOKEN` | Vous l'inventez | 5 |
| `NOTIFY_WEBHOOK_URL` | Slack, Discord… (facultatif) | 5 |

### Étape 1 — Clé API Claude

1. Allez sur [platform.claude.com](https://platform.claude.com) et créez un compte.
2. **Billing** : ajoutez une carte et quelques dollars de crédit. Mettez une
   limite de dépenses mensuelle (ex. 50 $) dans **Limits**.
3. **API Keys → Create Key**, nommez-la « Messenger », copiez la clé (`sk-ant-…`).
   Elle n'est affichée qu'une fois : c'est votre `ANTHROPIC_API_KEY`.

### Étape 2 — Compte Cloudflare

1. Créez un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com).
2. Sur votre ordinateur, installez [Node.js](https://nodejs.org) (version LTS).
3. Ouvrez un terminal dans le dossier `generatrice-bot` et lancez :

   ```bash
   npm install
   npx wrangler login
   ```

   Une page Cloudflare s'ouvre : cliquez sur **Allow**.

### Étape 3 — Créer l'application Meta

1. Allez sur [developers.facebook.com/apps](https://developers.facebook.com/apps)
   et connectez-vous avec le compte Facebook administrateur de la Page. Si on
   vous le demande, acceptez de devenir développeur Meta.
2. **Créer une app**.
   - Nom : « Bot Messenger Solution NRJ ».
   - Cas d'utilisation : **Interagir avec les clients sur Messenger from Meta**.
   - Portefeuille d'entreprise : choisissez celui de Solution NRJ.
3. Une fois l'app créée, menu de gauche **Paramètres de l'app → Général** :
   - copiez l'**ID de l'app** → `META_APP_ID` ;
   - cliquez **Afficher** à côté de la **Clé secrète** → `META_APP_SECRET` ;
   - **URL de la politique de confidentialité** : l'adresse de la page
     « Politique de confidentialité » de generatricediesel.com ;
   - **Catégorie** : Affaires et pages. Enregistrez.

### Étape 4 — Relier la Page et obtenir le jeton

1. Menu de gauche **Cas d'utilisation → Messenger → Personnaliser** (ou
   **Messenger → Paramètres de l'API**).
2. Section **Générer des jetons d'accès** : **Connecter** votre Page Solution NRJ
   et cochez toutes les autorisations proposées.
3. Cliquez **Générer** à côté de la Page, cochez « J'ai compris », copiez le
   jeton → `META_PAGE_ACCESS_TOKEN`. Ce jeton de Page n'expire pas tant que vous
   ne changez pas votre mot de passe Facebook ni vos rôles sur la Page.
4. Inventez une phrase secrète sans espace, par exemple
   `nrj-bot-7f3k9q2m` → `META_VERIFY_TOKEN`.
5. Laissez cette page ouverte : on revient à la section **Webhooks** à l'étape 6.

### Étape 5 — Déployer le bot sur Cloudflare

Dans le terminal, dossier `generatrice-bot` :

```bash
npx wrangler kv namespace create BOT_STATE
```

Copiez l'`id` affiché et collez-le dans `wrangler.toml` à la place de
`REMPLACEZ_PAR_L_ID_DU_NAMESPACE_KV`.

Enregistrez les secrets (chaque commande vous demande de coller la valeur) :

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_PAGE_ACCESS_TOKEN
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Pour `ADMIN_TOKEN`, inventez un long mot de passe : il protège la liste de vos
prospects.

Facultatif, pour être alerté (Slack : *Applications → Incoming Webhooks* ;
Discord : *Paramètres du salon → Intégrations → Webhooks*) :

```bash
npx wrangler secret put NOTIFY_WEBHOOK_URL
```

Puis déployez :

```bash
npm run deploy
```

Wrangler affiche l'adresse du bot, par exemple
`https://generatrice-bot.<vous>.workers.dev`. Ouvrez-la : vous devez voir
« Bot Messenger actif. »

### Étape 6 — Brancher le webhook

De retour dans l'app Meta, **Messenger → Paramètres de l'API → Configurer les
webhooks** :

1. **URL de rappel** : `https://generatrice-bot.<vous>.workers.dev/webhook`
2. **Vérifier le jeton** : votre `META_VERIFY_TOKEN`.
3. **Vérifier et enregistrer**. Si Meta affiche une erreur, vérifiez que le
   jeton est identique des deux côtés.
4. Dans la liste de la Page, **Ajouter des abonnements** et cochez :
   - `messages`
   - `messaging_postbacks`
   - `message_echoes` (indispensable pour que le bot se taise quand vous répondez vous-même)

### Étape 7 — Bouton « Démarrer » et message d'accueil (facultatif)

Dans le terminal (remplacez `JETON` par votre jeton de Page) :

```bash
curl -X POST "https://graph.facebook.com/v21.0/me/messenger_profile" \
  -H "Authorization: Bearer JETON" -H "Content-Type: application/json" \
  -d '{"get_started":{"payload":"GET_STARTED"},"greeting":[{"locale":"default","text":"Bonjour! Questions sur nos génératrices diesel? Écrivez-nous, on vous répond tout de suite."}]}'
```

### Étape 8 — Tester

Tant que l'app est en mode **Développement**, seules les personnes qui ont un
rôle dans l'app (vous) reçoivent des réponses. Écrivez à votre Page depuis votre
compte Facebook :

- « Bonjour, j'ai besoin d'une génératrice pour ma ferme » → le bot pose des
  questions et propose un modèle avec son lien.
- Donnez un numéro de téléphone → vous recevez l'alerte (si configurée) et le
  prospect apparaît dans `/leads?key=<ADMIN_TOKEN>`.
- « Je veux parler à quelqu'un » → le bot annonce le transfert et se tait.
- Répondez vous-même au client depuis Meta Business Suite → le bot reste muet
  pour ce client pendant 24 h.

Pour voir ce qui se passe en direct : `npx wrangler tail`.

### Étape 9 — Ouvrir le bot à tous vos clients

1. **Vérification de l'entreprise** : dans
   [business.facebook.com/settings](https://business.facebook.com/settings) →
   *Centre de sécurité*, vérifiez Solution NRJ (NEQ, adresse, téléphone). Meta
   peut prendre quelques jours.
2. Dans l'app Meta, **Examen de l'app → Autorisations et fonctionnalités** :
   demandez **l'accès avancé** pour `pages_messaging` (et `pages_manage_metadata`
   si proposé). Meta demande une courte vidéo d'écran montrant le bot qui répond
   dans Messenger, et une phrase d'explication, par exemple :
   « Le bot répond aux questions des clients sur nos génératrices diesel,
   recueille leur besoin et leurs coordonnées pour une soumission, et transfère
   à un employé sur demande. »
3. Une fois approuvé, passez l'app en mode **Live** (interrupteur en haut de la
   page de l'app).

---

## Enlever ChatGPT pour éviter les conflits

Ce projet ne contient **aucune trace de ChatGPT ni d'OpenAI** : rien à enlever
dans le code. Les conflits viennent de ce qui est branché **sur votre Page
Facebook** : si un autre outil reçoit aussi les messages, le client obtient deux
réponses, et ses messages automatiques mettraient notre bot en pause. Faites ces
vérifications **avant l'étape 6** :

1. **Applications connectées à la Page.** Facebook (connecté en tant que la
   Page) → *Paramètres et confidentialité → Paramètres → Intégrations
   professionnelles* : supprimez toute app de type ChatGPT, ManyChat, Chatfuel,
   MobileMonkey, Zapier, Make, etc. Faites de même dans
   [business.facebook.com/settings](https://business.facebook.com/settings) →
   *Comptes → Apps* et *Intégrations*.
2. **Automatisations de Meta Business Suite.** *Boîte de réception →
   Automatisations* (icône éclair) : désactivez la **réponse instantanée**, le
   **message d'absence**, les **questions fréquentes** et tout **assistant IA /
   Meta AI pour les entreprises**. Notre bot les remplace.
3. **App principale de la Page.** Page → *Paramètres → Paramètres avancés de
   messagerie → Paramètres de l'application* : si une autre app est « app
   principale », retirez-la (ou choisissez « Bot Messenger Solution NRJ »).
4. **Scénarios Zapier / Make / n8n** qui envoyaient les messages à ChatGPT :
   désactivez-les. Si une clé OpenAI y était utilisée, révoquez-la sur
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
   Votre abonnement ChatGPT personnel ne gêne pas le bot : le garder ou non ne
   change rien.
5. **Vérification finale** : listez les apps abonnées à votre Page (remplacez
   `JETON`) :

   ```bash
   curl "https://graph.facebook.com/v21.0/me/subscribed_apps" -H "Authorization: Bearer JETON"
   ```

   Seule « Bot Messenger Solution NRJ » doit apparaître. Si une autre app est
   listée, retournez au point 1.

---

## Mettre à jour les informations

Prix, stocks ou règles changent : modifiez `src/business.ts`, puis
`npm run deploy`. Ne mettez jamais les coûts fournisseur dans ce fichier : le
bot peut répéter tout ce qui s'y trouve.

| Réglage | Où |
|---|---|
| Infos, prix, règles de réponse | `src/business.ts` |
| Durée de la pause après un humain (heures) | `wrangler.toml` → `HUMAN_PAUSE_HOURS` |
| Modèle Claude | `wrangler.toml` → `CLAUDE_MODEL` (par défaut `claude-opus-5-5`) |
| Questions de qualification, outils | `src/agent.ts` |

Si un filtre de sécurité de Claude refuse un message, l'API le relance
automatiquement sur un modèle de repli ; si celui-ci refuse aussi, le bot
propose de passer à un membre de l'équipe.

## Développement

```bash
cp .dev.vars.example .dev.vars   # renseignez vos valeurs
npm run dev                       # http://localhost:8787
npm run typecheck
npm test
```
