// Appels à l'API Messenger (Graph API) et vérification des webhooks Meta.

const GRAPH_API = "https://graph.facebook.com/v21.0";

// Messenger refuse les messages texte de plus de 2000 caractères.
export const MAX_MESSAGE_LENGTH = 2000;

export interface Attachment {
  type: "image" | "audio" | "video" | "file" | "location" | "fallback" | string;
  payload?: { url?: string; sticker_id?: number };
}

/** Provenance d'une conversation (publicité « Clic vers Messenger », lien m.me…). */
export interface Referral {
  source?: string;
  type?: string;
  ref?: string;
  ad_id?: string;
  ads_context_data?: { ad_title?: string };
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
    referral?: Referral;
  };
  postback?: { title: string; payload: string; referral?: Referral };
  // Événement messaging_referrals (client déjà en conversation qui clique une pub).
  referral?: Referral;
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

export async function sendText(pageAccessToken: string, recipientId: string, text: string): Promise<void> {
  for (const part of splitMessage(text)) {
    await callSendApi(pageAccessToken, {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      message: { text: part, metadata: BOT_METADATA },
    });
  }
}

/**
 * Prénom et nom du client, tirés de son profil Messenger (API User Profile, jeton de Page).
 * Renvoie null si l'appel échoue ou ne renvoie rien : le bot demandera alors le nom.
 */
export async function fetchProfileName(pageAccessToken: string, psid: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${GRAPH_API}/${encodeURIComponent(psid)}?fields=first_name,last_name`, {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Code et sous-code Graph pour le diagnostic. Un refus 4xx (permission ou fonctionnalité
      // de la Page manquante) est attendu tant que l'accès au profil n'est pas accordé : simple log.
      const err = ((await res.json().catch(() => null)) as { error?: { code?: unknown; error_subcode?: unknown; type?: unknown; message?: unknown } } | null)?.error;
      const detail = err
        ? ` code=${err.code ?? "?"} sous-code=${err.error_subcode ?? "?"} type=${err.type ?? "?"} : ${String(err.message ?? "").slice(0, 160)}`
        : "";
      (res.status >= 500 ? console.error : console.log)(`Profil Messenger indisponible (${res.status})${detail}`);
      return null;
    }
    const profile = (await res.json()) as { first_name?: unknown; last_name?: unknown };
    const name = [profile.first_name, profile.last_name]
      .map((part) => (typeof part === "string" ? part.replace(/[\u0000-\u001f"«»<>\[\]{}]/g, " ").replace(/\s+/g, " ").trim() : ""))
      .filter(Boolean)
      .join(" ")
      .slice(0, 80);
    return name || null;
  } catch {
    console.error("Profil Messenger : appel échoué");
    return null;
  }
}

export async function sendAction(
  pageAccessToken: string,
  recipientId: string,
  action: "mark_seen" | "typing_on" | "typing_off",
): Promise<void> {
  await callSendApi(pageAccessToken, { recipient: { id: recipientId }, sender_action: action });
}

export const SOURCE_AD = "Messenger – pub Facebook";
export const SOURCE_PAGE = "Messenger – page Facebook";

/** Provenance du premier contact : pub Facebook (referral ADS ou ad_id) ou message direct à la Page. */
export interface Origin {
  source: string | null;
  ad_id: string | null;
  ad_title: string | null;
}

export function originOf(event: MessagingEvent): Origin {
  const referral = event.referral ?? event.message?.referral ?? event.postback?.referral;
  if (referral && (referral.source === "ADS" || referral.ad_id)) {
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
    return { source: SOURCE_AD, ad_id: clean(referral.ad_id), ad_title: clean(referral.ads_context_data?.ad_title) };
  }
  return { source: SOURCE_PAGE, ad_id: null, ad_title: null };
}
