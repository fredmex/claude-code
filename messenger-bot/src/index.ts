import Anthropic from "@anthropic-ai/sdk";
import { generateReply, type Turn } from "./claude";
import {
  sendAction,
  sendText,
  verifySignature,
  type MessagingEvent,
  type WebhookBody,
} from "./messenger";

export interface Env {
  BOT_STATE: KVNamespace;
  ANTHROPIC_API_KEY: string;
  META_APP_SECRET: string;
  META_PAGE_ACCESS_TOKEN: string;
  META_VERIFY_TOKEN: string;
  CLAUDE_MODEL: string;
}

// Nombre de messages gardés en mémoire par conversation, et durée de cette mémoire.
const MAX_HISTORY_TURNS = 20;
const HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7;
// Après « humain », le bot se tait pendant ce temps : l'équipe répond depuis la boîte de
// réception de Meta Business Suite, où elle voit toute la conversation.
const HANDOFF_TTL_SECONDS = 60 * 60 * 24;

const HANDOFF_WORDS = /^\s*(humain|human|agent|conseiller|conseill[eè]re|une personne)\s*[.!?]*\s*$/i;
const RESUME_WORDS = /^\s*(bot|robot|assistant)\s*[.!?]*\s*$/i;

const WELCOME =
  "Bonjour 👋 Je suis l'assistant virtuel. Posez-moi votre question ! Écrivez « humain » à tout moment pour parler à quelqu'un de l'équipe.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });

    // Vérification initiale du webhook par Meta.
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
    const events = (body.entry ?? []).flatMap((entry) => entry.messaging ?? []);
    ctx.waitUntil(Promise.all(events.map((event) => handleEvent(event, env).catch(logError))));
    return new Response("EVENT_RECEIVED", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function handleEvent(event: MessagingEvent, env: Env): Promise<void> {
  const userId = event.sender.id;
  const token = env.META_PAGE_ACCESS_TOKEN;

  // Bouton « Démarrer » de Messenger.
  if (event.postback?.payload === "GET_STARTED") {
    await sendText(token, userId, WELCOME);
    return;
  }

  const message = event.message;
  if (!message || message.is_echo) return;

  // Meta peut livrer deux fois le même message : on ignore les doublons.
  const seenKey = `seen:${message.mid}`;
  if (await env.BOT_STATE.get(seenKey)) return;
  await env.BOT_STATE.put(seenKey, "1", { expirationTtl: 60 * 60 });

  const text = message.text?.trim();
  const handoffKey = `handoff:${userId}`;

  if (text && RESUME_WORDS.test(text)) {
    await env.BOT_STATE.delete(handoffKey);
    await sendText(token, userId, "Je suis de retour 🙂 Comment puis-je vous aider ?");
    return;
  }

  // Un membre de l'équipe a la main : le bot ne répond pas.
  if (await env.BOT_STATE.get(handoffKey)) return;

  if (text && HANDOFF_WORDS.test(text)) {
    await env.BOT_STATE.put(handoffKey, "1", { expirationTtl: HANDOFF_TTL_SECONDS });
    await sendText(
      token,
      userId,
      "C'est noté, un membre de l'équipe va vous répondre ici dès que possible. Écrivez « bot » pour revenir à l'assistant.",
    );
    return;
  }

  if (!text) {
    await sendText(token, userId, "Merci ! Je ne peux lire que les messages texte. Pouvez-vous décrire votre demande par écrit ?");
    return;
  }

  await sendAction(token, userId, "mark_seen");
  await sendAction(token, userId, "typing_on");

  const historyKey = `history:${userId}`;
  const history = ((await env.BOT_STATE.get<Turn[]>(historyKey, "json")) ?? []).concat({ role: "user", text });

  let reply: string;
  try {
    reply = await generateReply(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL, history);
  } catch (error) {
    logError(error);
    await sendText(token, userId, "Désolé, un problème technique m'empêche de répondre. Réessayez dans un instant ou écrivez « humain ».");
    return;
  }

  await sendText(token, userId, reply);

  // On garde les derniers échanges, en commençant toujours par un message du client.
  let trimmed = history.concat({ role: "assistant", text: reply }).slice(-MAX_HISTORY_TURNS);
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
