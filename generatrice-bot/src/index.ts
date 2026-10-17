import Anthropic from "@anthropic-ai/sdk";
import { runAgent, type Turn } from "./agent.ts";
import { emptyLead, leadsToCsv, listLeads, notifyTeam, putLead, type Lead } from "./leads.ts";
import { AD_GREETING, customerGate, DAILY_REPLY_LIMIT, stopRequested, type GuardEnv } from "./guards.ts";
import { BOT_METADATA, fetchProfileName, sendAction, sendText, verifySignature, type MessagingEvent, type WebhookBody } from "./messenger.ts";

export interface Env extends GuardEnv {
  BOT_STATE: KVNamespace;
  CONVERSATIONS: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  META_APP_SECRET: string;
  META_PAGE_ACCESS_TOKEN: string;
  META_VERIFY_TOKEN: string;
  ADMIN_TOKEN: string;
  CLAUDE_MODEL: string;
  HUMAN_PAUSE_HOURS: string;
  NOTIFY_WEBHOOK_URL?: string;
  // Soumissions officielles (voir README).
  QUOTE_REGISTER_URL: string;
  QUOTE_REGISTER_PASSWORD?: string;
  QUOTE_WRITES_ENABLED?: string;
  QUOTATION_EMAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
}

/** État d'une conversation : lecture et écriture immédiatement cohérentes. */
export interface Store {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Stockage du Durable Object, avec expiration gérée à la lecture. */
export class DurableStore implements Store {
  private storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }
  async get<T>(key: string): Promise<T | null> {
    const record = await this.storage.get<{ v: T; exp: number | null }>(key);
    if (!record) return null;
    if (record.exp !== null && record.exp < Date.now()) {
      await this.storage.delete(key);
      return null;
    }
    return record.v;
  }
  async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.storage.put(key, { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }
  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}

/**
 * Une instance par client (nom « claude:<psid> ») : les messages d'un même client
 * sont traités un à un, dans l'ordre, avec une mémoire toujours à jour. Le
 * traitement se fait dans alarm(), sans la limite de 30 s de waitUntil().
 * Le nom de classe est repris de l'ancien bot ; ses anciennes instances
 * (« <page>:<psid> ») ne sont jamais lues ni modifiées.
 */
export class Conversation {
  private ctx: DurableObjectState;
  private env: Env;
  private store: DurableStore;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.store = new DurableStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/event") {
      const event = (await request.json()) as MessagingEvent;
      const queue = ((await this.ctx.storage.get<MessagingEvent[]>("queue")) ?? []).concat(event);
      await this.ctx.storage.put("queue", queue);
      await this.ctx.storage.setAlarm(Date.now());
      return new Response("queued");
    }
    if (url.pathname === "/clear") {
      await clearClientState(this.store, url.searchParams.get("reset") === "1");
      return new Response("cleared");
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    for (;;) {
      const queue = (await this.ctx.storage.get<MessagingEvent[]>("queue")) ?? [];
      const event = queue.shift();
      if (!event) return;
      await this.ctx.storage.put("queue", queue);
      // Une erreur ne doit pas relancer l'alarme : le client recevrait deux réponses.
      await handleEvent(event, this.env, this.store).catch(logError);
    }
  }
}

export function conversationFor(env: Env, psid: string): DurableObjectStub {
  return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`claude:${psid}`));
}

/** Ancienne classe de l'ancien bot, conservée vide pour ne pas migrer ses données. */
export class MailGate {
  async fetch(): Promise<Response> {
    return new Response("Gone", { status: 410 });
  }
}

// Nombre de messages gardés par conversation, et durée de cette mémoire.
const MAX_HISTORY_TURNS = 30;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") return new Response("Bot Messenger actif.", { status: 200 });
    if (url.pathname === "/leads") return exportLeads(request, url, env);
    if (url.pathname === "/admin/resume") return resumeBot(request, url, env);
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    // Vérification de l'URL de rappel par Meta.
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.META_VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const rawBody = await request.text();
    if (!(await verifySignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.META_APP_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const body = JSON.parse(rawBody) as WebhookBody;
    if (body.object !== "page") return new Response("Not found", { status: 404 });

    // Seulement la Page Solution NRJ, si son identifiant est configuré.
    const entries = body.entry ?? [];
    const events = entries
      .filter((entry) => !env.META_PAGE_ID || String(entry.id) === env.META_PAGE_ID)
      .flatMap((entry) => entry.messaging ?? []);
    if (events.length === 0) {
      console.log(`Webhook sans message traitable : ${JSON.stringify(entries.map((e) => ({ page: String(e.id) === env.META_PAGE_ID ? "ok" : "autre", keys: Object.keys(e) })))}`);
    }
    // Chaque événement va dans la file du client concerné (le destinataire, pour un écho).
    try {
      for (const event of events) {
        const psid = event.message?.is_echo ? event.recipient.id : event.sender.id;
        if (!/^\d{5,30}$/.test(psid ?? "")) continue;
        const res = await conversationFor(env, psid).fetch("https://conversation/event", { method: "POST", body: JSON.stringify(event) });
        if (!res.ok) throw new Error(`queue_${res.status}`);
      }
    } catch (error) {
      logError(error);
      return new Response("Retry later", { status: 503 }); // Meta renverra l'événement
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

/** Liste des prospects en CSV (ouvrable dans Excel) : /leads?key=ADMIN_TOKEN */
async function exportLeads(request: Request, url: URL, env: Env): Promise<Response> {
  const key = url.searchParams.get("key") ?? request.headers.get("Authorization")?.replace(/^Bearer /, "");
  if (!env.ADMIN_TOKEN || !key || !(await timingSafeEqual(key, env.ADMIN_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const leads = await listLeads(env.BOT_STATE);
  if (url.searchParams.get("format") === "json") return Response.json(leads);
  return new Response(leadsToCsv(leads), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="prospects.csv"',
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Relance le bot pour un client (retire pause, arrêt et compteur du jour) :
 * POST /admin/resume?psid=…[&reset=1]  avec  Authorization: Bearer ADMIN_TOKEN.
 * reset=1 efface aussi l'historique de conversation et la fiche du client.
 */
async function resumeBot(request: Request, url: URL, env: Env): Promise<Response> {
  const key = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("key");
  if (!env.ADMIN_TOKEN || !key || !(await timingSafeEqual(key, env.ADMIN_TOKEN))) return new Response("Unauthorized", { status: 401 });
  const psid = url.searchParams.get("psid");
  if (request.method !== "POST" || !psid || !/^\d{5,30}$/.test(psid)) return new Response("Bad request", { status: 400 });
  const reset = url.searchParams.get("reset") === "1";
  await conversationFor(env, psid).fetch(`https://conversation/clear?reset=${reset ? 1 : 0}`, { method: "POST" });
  return Response.json({ resumed: psid, reset });
}

/** Retire pause, arrêt et compteur du jour ; avec reset, efface aussi l'historique et la fiche. */
async function clearClientState(store: Store, reset: boolean): Promise<void> {
  const keys = ["pause", "stopped", `count:${new Date().toISOString().slice(0, 10)}`];
  if (reset) keys.push("history", "lead", "profile");
  await Promise.all(keys.map((k) => store.delete(k)));
}

/**
 * Nom du profil Messenger, gardé dans l'état du client pour ne pas refaire l'appel
 * à chaque message. Un échec est retenu une journée, puis on réessaie.
 */
async function profileNameFor(store: Store, token: string, psid: string): Promise<string | null> {
  const cached = await store.get<{ name: string | null }>("profile");
  if (cached) return cached.name;
  const name = await fetchProfileName(token, psid);
  await store.put("profile", { name }, name ? undefined : 60 * 60 * 24);
  if (!name) console.log(`Nom du profil inconnu pour ${tail(psid)} : le bot le demandera au besoin`);
  return name;
}

/** Les 4 derniers chiffres suffisent pour suivre un client dans les journaux. */
const tail = (psid: string) => `…${psid.slice(-4)}`;

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all(
    [a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))),
  );
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function pauseSeconds(env: Env): number {
  const hours = Number(env.HUMAN_PAUSE_HOURS);
  return Math.max(1, Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600;
}

export async function handleEvent(event: MessagingEvent, env: Env, store: Store): Promise<void> {
  const message = event.message;

  // Un message envoyé par la Page sans la balise du bot, c'est un humain qui
  // répond depuis Meta Business Suite : le bot se met en pause pour ce client.
  // Le message d'accueil des publicités Messenger est envoyé par Meta : il ne compte pas.
  if (message?.is_echo) {
    if (!String(message.metadata ?? "").startsWith(BOT_METADATA) && message.text !== AD_GREETING) {
      await store.put("pause", "humain", pauseSeconds(env));
      console.log(`Pause pour ${tail(event.recipient.id)} : un humain a répondu`);
    }
    return;
  }

  const psid = event.sender.id;
  const token = env.META_PAGE_ACCESS_TOKEN;

  if (message) {
    // Meta peut livrer deux fois le même message : on ignore les doublons.
    const seen = (await store.get<string[]>("seen")) ?? [];
    if (seen.includes(message.mid)) {
      console.log(`Doublon ignoré pour ${tail(psid)}`);
      return;
    }
    await store.put("seen", seen.concat(message.mid).slice(-200));
  } else if (!event.postback) {
    return; // accusés de lecture et de réception
  }

  // Le bot n'est pas activé, le client est un client existant, ou la fenêtre de 24 h est passée.
  const gate = customerGate(env, psid, Number(event.timestamp));
  if (!gate.allowed) {
    console.log(`Pas de réponse à ${tail(psid)} : ${gate.reason}`);
    return;
  }

  // Test : Frederic remet sa conversation à zéro en écrivant « #reset ».
  if (gate.reason === "owner_test" && message?.text?.trim().toLowerCase() === "#reset") {
    await clearClientState(store, true);
    await sendText(env.META_PAGE_ACCESS_TOKEN, psid, "Conversation de test remise à zéro (historique, fiche et pause effacés).");
    console.log(`Remise à zéro du test pour ${tail(psid)}`);
    return;
  }

  // Le client a demandé qu'on ne le contacte plus.
  if (await store.get("stopped")) {
    console.log(`Pas de réponse à ${tail(psid)} : le client a demandé l'arrêt`);
    return;
  }
  if (message?.text && stopRequested(message.text)) {
    await store.put("stopped", "1", 60 * 60 * 24 * 365);
    console.log(`Arrêt demandé par ${tail(psid)}`);
    return;
  }

  // Un membre de l'équipe a la main : le bot ne répond pas.
  const pause = await store.get<string>("pause");
  if (pause) {
    console.log(`Pas de réponse à ${tail(psid)} : en pause (${pause})`);
    return;
  }

  // Au-delà de 30 réponses dans la journée, on laisse la conversation à l'équipe.
  const countKey = `count:${new Date().toISOString().slice(0, 10)}`;
  const count = (await store.get<number>(countKey)) ?? 0;
  // Le compte de test de Frederic n'a pas de limite : elle protège les vrais clients.
  if (count >= DAILY_REPLY_LIMIT && gate.reason !== "owner_test") {
    await store.put("pause", "limite", pauseSeconds(env));
    console.log(`Pause pour ${tail(psid)} : limite de ${DAILY_REPLY_LIMIT} réponses atteinte`);
    return;
  }
  await store.put(countKey, count + 1, 60 * 60 * 48);

  // Ce que le client a envoyé, pour Claude et pour l'historique.
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const historyNotes: string[] = [];
  if (event.postback) {
    const text = event.postback.payload === "GET_STARTED" ? "Bonjour" : event.postback.title;
    content.push({ type: "text", text });
    historyNotes.push(text);
  }
  if (message?.text?.trim()) {
    content.push({ type: "text", text: message.text.trim() });
    historyNotes.push(message.text.trim());
  }
  for (const attachment of message?.attachments ?? []) {
    if (attachment.type === "image" && attachment.payload?.url && !attachment.payload.sticker_id) {
      content.push({ type: "image", source: { type: "url", url: attachment.payload.url } });
      historyNotes.push("[Le client a envoyé une photo]");
    } else if (attachment.type === "audio") {
      content.push({ type: "text", text: "[Le client a envoyé un message vocal, que tu ne peux pas écouter.]" });
      historyNotes.push("[message vocal]");
    } else if (attachment.type !== "image") {
      content.push({ type: "text", text: `[Le client a envoyé une pièce jointe de type ${attachment.type}, que tu ne peux pas ouvrir.]` });
      historyNotes.push(`[pièce jointe : ${attachment.type}]`);
    }
  }
  if (content.length === 0) return; // autocollant « j'aime » seul, etc.
  console.log(`Réponse à ${tail(psid)} (${gate.reason ?? "client"})`);

  await sendAction(token, psid, "mark_seen");
  await sendAction(token, psid, "typing_on");

  const history = (await store.get<Turn[]>("history")) ?? [];
  const profileName = await profileNameFor(store, token, psid);
  const now = new Date().toISOString();

  let result;
  try {
    result = await runAgent({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.CLAUDE_MODEL,
      history,
      userContent: content,
      lead: await store.get<Lead>("lead"),
      psid,
      now,
      quoteEnv: env,
      profileName,
    });
  } catch (error) {
    logError(error);
    await sendText(
      token,
      psid,
      "Désolé, j'ai un petit problème technique. Vous pouvez nous joindre au 438-350-6979 (lun.-ven., 9 h à 16 h) ou réessayer dans un instant.",
    );
    return;
  }

  await sendText(token, psid, result.reply);

  let lead = result.lead;
  if (result.transferReason) {
    await store.put("pause", "transfert", pauseSeconds(env));
    console.log(`Pause pour ${tail(psid)} : transfert (${result.transferReason})`);
    const base = lead ?? emptyLead(psid, now);
    lead = { ...base, transferred: true, notes: [base.notes, `Transfert : ${result.transferReason}`].filter(Boolean).join(" — ") };
  }
  if (lead) {
    await store.put("lead", lead);
    // Copie pour l'export CSV (/leads) : un léger délai d'affichage y est sans importance.
    await putLead(env.BOT_STATE, lead).catch(logError);
  }

  const notify = { webhookUrl: env.NOTIFY_WEBHOOK_URL, resendApiKey: env.RESEND_API_KEY, emailEnabled: env.QUOTATION_EMAIL_ENABLED === "true" };
  const lastMid = message?.mid ?? `postback-${event.timestamp}`;
  if (result.transferReason && lead) {
    await notifyTeam(notify, `🙋 Un client demande un humain (${result.transferReason})`, lead, `messenger-transfer-${lastMid}`);
  } else if (result.quote && lead) {
    await notifyTeam(notify, `📄 Soumission ${result.quote.number} envoyée à ${result.quote.email}`, lead, `messenger-quote-notice-${result.quote.number}`);
  } else if (result.leadQualified && lead) {
    await notifyTeam(notify, "📞 Nouveau prospect Messenger à rappeler", lead, `messenger-lead-${lastMid}`);
  }

  // On garde les derniers échanges (texte seulement), en commençant toujours par un message du client.
  let trimmed: Turn[] = history
    .concat({ role: "user", text: historyNotes.join("\n") }, { role: "assistant", text: result.reply })
    .slice(-MAX_HISTORY_TURNS);
  while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
  await store.put("history", trimmed, HISTORY_TTL_SECONDS);
}

function logError(error: unknown): void {
  if (error instanceof Anthropic.RateLimitError) {
    console.error("Limite de débit de l'API Claude atteinte");
  } else if (error instanceof Anthropic.APIError) {
    console.error(`Erreur de l'API Claude (${error.status}) : ${error.message}`);
  } else {
    console.error(error);
  }
}
