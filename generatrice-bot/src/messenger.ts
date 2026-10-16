// Appels à l'API Messenger (Graph API) et vérification des webhooks Meta.

const GRAPH_API = "https://graph.facebook.com/v21.0";

// Messenger refuse les messages texte de plus de 2000 caractères.
export const MAX_MESSAGE_LENGTH = 2000;

export interface Attachment {
  type: "image" | "audio" | "video" | "file" | "location" | "fallback" | string;
  payload?: { url?: string; sticker_id?: number };
}

export interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    // Vrai pour les messages envoyés PAR la Page (par le bot ou par un humain).
    is_echo?: boolean;
    // Sur un écho : la balise passée à l'envoi. Les messages du bot portent
    // BOT_METADATA ; un message sans balise vient d'un humain.
    metadata?: string;
    attachments?: Attachment[];
    quick_reply?: { payload: string };
  };
  postback?: { title: string; payload: string };
}

/** Balise ajoutée à chaque message du bot, pour reconnaître ceux d'un humain. */
export const BOT_METADATA = "solution-nrj-ai";

export interface WebhookBody {
  object: string;
  entry?: { id: string; time: number; messaging?: MessagingEvent[] }[];
}

/**
 * Vérifie l'en-tête X-Hub-Signature-256 que Meta ajoute à chaque webhook :
 * un HMAC-SHA256 du corps brut, signé avec la clé secrète de l'application.
 */
export async function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!expected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // crypto.subtle.verify compare en temps constant.
  return crypto.subtle.verify("HMAC", key, expected, new TextEncoder().encode(rawBody));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Découpe un texte en morceaux d'au plus `max` caractères, de préférence entre deux paragraphes ou phrases. */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function callSendApi(pageAccessToken: string, body: object): Promise<void> {
  const res = await fetch(`${GRAPH_API}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${pageAccessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Erreur de l'API Messenger (${res.status}) : ${await res.text()}`);
  }
}

/** Envoie un texte ; les réponses rapides éventuelles vont sur le dernier morceau. */
export async function sendText(pageAccessToken: string, recipientId: string, text: string, quickReplies: object[] = []): Promise<void> {
  const parts = splitMessage(text);
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    await callSendApi(pageAccessToken, {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text: part, metadata: BOT_METADATA, ...(last && quickReplies.length ? { quick_replies: quickReplies } : {}) },
    });
  }
}

/** Carrousel de cartes (modèle générique de Messenger). */
export async function sendCarousel(pageAccessToken: string, recipientId: string, elements: object[], quickReplies: object[] = []): Promise<void> {
  await callSendApi(pageAccessToken, {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachment: { type: "template", payload: { template_type: "generic", elements } },
      metadata: BOT_METADATA,
      ...(quickReplies.length ? { quick_replies: quickReplies } : {}),
    },
  });
}

export async function sendAction(
  pageAccessToken: string,
  recipientId: string,
  action: "mark_seen" | "typing_on" | "typing_off",
): Promise<void> {
  await callSendApi(pageAccessToken, { recipient: { id: recipientId }, sender_action: action });
}
