import Anthropic from "@anthropic-ai/sdk";
import { runAgent, type Turn } from "./agent.ts";
import { emptyLead, getLead, leadsToCsv, listLeads, notifyTeam, putLead } from "./leads.ts";
import { AD_GREETING, customerGate, DAILY_REPLY_LIMIT, stopRequested, type GuardEnv } from "./guards.ts";
import { BOT_METADATA, sendAction, sendText, verifySignature, type MessagingEvent, type WebhookBody } from "./messenger.ts";

export interface Env extends GuardEnv {
  BOT_STATE: KVNamespace;
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
  HUBSPOT_ACCESS_TOKEN?: string;
  HUBSPOT_WRITES_ENABLED?: string;
}

/**
 * Classes Durable Object de l'ancien service Messenger (ChatGPT). Le Worker
 * garde le même nom ; ces coquilles vides évitent une migration qui
 * effacerait leurs données. Elles ne sont plus utilisées.
 */
export class Conversation {
  async fetch(): Promise<Response> {
    return new Response("Gone", { status: 410 });
  }
}
export class MailGate {
  async fetch(): Promise<Response> {
    return new Response("Gone", { status: 410 });
  }
}

// Nombre de messages gardés par conversation, et durée de cette mémoire.
const MAX_HISTORY_TURNS = 30;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 30;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") return new Response("Bot Messenger actif.", { status: 200 });
    if (url.pathname === "/leads") return exportLeads(request, url, env);
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

    // Meta attend un 200 rapidement, sinon il renvoie l'événement : on traite en arrière-plan.
    // Seulement la Page Solution NRJ, si son identifiant est configuré.
    const events = (body.entry ?? [])
      .filter((entry) => !env.META_PAGE_ID || String(entry.id) === env.META_PAGE_ID)
      .flatMap((entry) => entry.messaging ?? []);
    ctx.waitUntil(Promise.all(events.map((event) => handleEvent(event, env).catch(logError))));
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

async function handleEvent(event: MessagingEvent, env: Env): Promise<void> {
  const message = event.message;

  // Un message envoyé par la Page sans la balise du bot, c'est un humain qui
  // répond depuis Meta Business Suite : le bot se met en pause pour ce client.
  // Le message d'accueil des publicités Messenger est envoyé par Meta : il ne compte pas.
  if (message?.is_echo) {
    if (!String(message.metadata ?? "").startsWith(BOT_METADATA) && message.text !== AD_GREETING) {
      await env.BOT_STATE.put(`pause:${event.recipient.id}`, "humain", { expirationTtl: pauseSeconds(env) });
    }
    return;
  }

  const psid = event.sender.id;
  const token = env.META_PAGE_ACCESS_TOKEN;

  if (message) {
    // Meta peut livrer deux fois le même message : on ignore les doublons.
    const seenKey = `seen:${message.mid}`;
    if (await env.BOT_STATE.get(seenKey)) return;
    await env.BOT_STATE.put(seenKey, "1", { expirationTtl: 60 * 60 });
  } else if (!event.postback) {
    return;
  }

  // Le bot n'est pas activé, le client est un client existant, ou la fenêtre de 24 h est passée.
  const gate = customerGate(env, psid, Number(event.timestamp));
  if (!gate.allowed) {
    console.log(`Pas de réponse à ${psid} : ${gate.reason}`);
    return;
  }

  // Le client a demandé qu'on ne le contacte plus.
  if (await env.BOT_STATE.get(`stopped:${psid}`)) return;
  if (message?.text && stopRequested(message.text)) {
    await env.BOT_STATE.put(`stopped:${psid}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
    return;
  }

  // Un membre de l'équipe a la main : le bot ne répond pas.
  if (await env.BOT_STATE.get(`pause:${psid}`)) return;

  // Au-delà de 30 réponses dans la journée, on laisse la conversation à l'équipe.
  const countKey = `count:${psid}:${new Date().toISOString().slice(0, 10)}`;
  const count = Number((await env.BOT_STATE.get(countKey)) ?? 0);
  if (count >= DAILY_REPLY_LIMIT) {
    await env.BOT_STATE.put(`pause:${psid}`, "limite", { expirationTtl: pauseSeconds(env) });
    return;
  }
  await env.BOT_STATE.put(countKey, String(count + 1), { expirationTtl: 60 * 60 * 48 });

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

  await sendAction(token, psid, "mark_seen");
  await sendAction(token, psid, "typing_on");

  const historyKey = `history:${psid}`;
  const history = (await env.BOT_STATE.get<Turn[]>(historyKey, "json")) ?? [];
  const now = new Date().toISOString();

  let result;
  try {
    result = await runAgent({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.CLAUDE_MODEL,
      history,
      userContent: content,
      lead: await getLead(env.BOT_STATE, psid),
      psid,
      now,
      quoteEnv: env,
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
    await env.BOT_STATE.put(`pause:${psid}`, "transfert", { expirationTtl: pauseSeconds(env) });
    const base = lead ?? emptyLead(psid, now);
    lead = { ...base, transferred: true, notes: [base.notes, `Transfert : ${result.transferReason}`].filter(Boolean).join(" — ") };
  }
  if (lead) await putLead(env.BOT_STATE, lead);

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
  await env.BOT_STATE.put(historyKey, JSON.stringify(trimmed), { expirationTtl: HISTORY_TTL_SECONDS });
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
