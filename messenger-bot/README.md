# Chatbot Messenger (Meta Business) avec Claude

Un assistant de service client pour la Messenger de votre Page Facebook. Il
répond aux questions fréquentes à partir des informations que vous lui donnez,
grâce à Claude, et tourne sur Cloudflare Workers (gratuit pour un petit volume).

## Ce qu'il fait

- Répond automatiquement aux messages reçus sur votre Page, dans la langue du client.
- Ne s'appuie que sur les informations de `src/business.ts` (horaires, prix,
  livraison, FAQ…) et n'invente ni prix ni promesse.
- Se souvient des 20 derniers messages de chaque conversation pendant 7 jours.
- Passe la main à l'équipe quand le client écrit **« humain »** : le bot se tait
  24 h et vous répondez depuis la boîte de réception de Meta Business Suite. Le
  client écrit **« bot »** pour revenir à l'assistant.
- Affiche « vu » et « en train d'écrire », découpe les longues réponses, ignore
  les doublons envoyés par Meta et vérifie la signature de chaque webhook.

## Installation

Prérequis : Node.js 20+, un compte [Cloudflare](https://dash.cloudflare.com),
une clé API [Claude](https://console.anthropic.com), une Page Facebook dont vous
êtes administrateur.

### 1. Personnaliser le bot

Remplissez `src/business.ts` avec le nom et les informations de votre entreprise.

### 2. Créer l'application Meta

1. Sur [developers.facebook.com](https://developers.facebook.com/apps), créez une
   application de type **Business** et ajoutez le produit **Messenger**.
2. Dans **Messenger > Paramètres de l'API**, associez votre Page et générez un
   **jeton d'accès de Page** (`META_PAGE_ACCESS_TOKEN`).
3. Dans **Paramètres de l'app > Général**, copiez la **clé secrète**
   (`META_APP_SECRET`).
4. Choisissez une phrase secrète quelconque pour `META_VERIFY_TOKEN`.

### 3. Déployer sur Cloudflare

```bash
cd messenger-bot
npm install
npx wrangler login
npx wrangler kv namespace create BOT_STATE   # copiez l'id dans wrangler.toml
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_PAGE_ACCESS_TOKEN
npx wrangler secret put META_VERIFY_TOKEN
npm run deploy
```

Wrangler affiche l'adresse du Worker, par exemple
`https://messenger-bot.<vous>.workers.dev`.

### 4. Brancher le webhook

Dans **Messenger > Paramètres de l'API > Webhooks** :

- URL de rappel : `https://messenger-bot.<vous>.workers.dev/webhook`
- Jeton de vérification : votre `META_VERIFY_TOKEN`
- Abonnez la Page aux champs **messages** et **messaging_postbacks**.

Envoyez un message à votre Page : le bot répond.

### 5. Passer en production

Tant que l'application est en mode développement, seules les personnes ayant un
rôle dans l'application reçoivent des réponses. Pour ouvrir le bot à tous les
clients, demandez la permission **pages_messaging** dans **Examen de l'app**,
puis passez l'application en mode **Live**.

## Réglages

| Où | Quoi |
|---|---|
| `src/business.ts` | Informations sur l'entreprise et règles de l'assistant |
| `wrangler.toml` → `CLAUDE_MODEL` | Modèle Claude (par défaut `claude-opus-5-5`) |
| `src/index.ts` | Mots-clés « humain » / « bot », durée de la mémoire et de la pause |
| `src/claude.ts` | Effort de réflexion (`low` par défaut pour des réponses rapides) |

Si un filtre de sécurité de Claude refuse une demande, l'API la relance
automatiquement sur un modèle de repli (`fallbacks: "default"`) ; si celui-ci
refuse aussi, le client est invité à écrire « humain ».

## Développement

```bash
cp .dev.vars.example .dev.vars   # renseignez vos valeurs
npm run dev                       # serveur local sur http://localhost:8787
npm run typecheck
npm test
```

Pour tester avec Meta en local, exposez le port avec un tunnel (par exemple
`npx cloudflared tunnel --url http://localhost:8787`) et utilisez son adresse
comme URL de rappel.
