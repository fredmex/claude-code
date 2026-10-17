// Soumission officielle : numéro réservé dans l'application « solution-nrj-soumissions »,
// PDF au format approuvé, envoi par Resend depuis ventes@solutionnrj.com.
import { QUOTE_CONDITIONS, type Model } from "./catalogue.ts";
import { addMonths, buildQuotePdf, computeTotals, formatMoney, SUPPLIER, type QuoteClient } from "./quote-pdf.ts";


export interface QuoteEnv {
  /** Mémoire du bot : reçoit aussi une copie des PDF envoyés (clés « pdf:… »). */
  BOT_STATE?: KVNamespace;
  QUOTE_REGISTER_URL: string;
  /**
   * Liaison de service vers le Worker « solution-nrj-soumissions ». Obligatoire en
   * production : Cloudflare refuse un fetch() public vers un autre Worker du même
   * domaine workers.dev (erreur 1042).
   */
  QUOTE_REGISTER?: { fetch: typeof fetch };
  QUOTE_REGISTER_PASSWORD?: string;
  QUOTE_WRITES_ENABLED?: string;
  QUOTATION_EMAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
}

export interface QuoteRequest {
  psid: string;
  model: Model;
  client: QuoteClient & { email: string };
  quantity: number;
  voltage: string | null;
  issuedOn: string;
}

export interface QuoteResult {
  number: string;
  revision: number;
  emailId: string;
  total: number;
  deposit: number;
}

// Signature courriel approuvée (reprise du service Messenger existant).
export const SIGNATURE_HTML =
  '<table lang="fr-CA" dir="ltr" role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;color:#263e55;max-width:320px;width:100%;"><tr><td style="padding-top:20px;padding-bottom:8px;"><a href="https://generatricediesel.com/"><img src="https://generatricediesel.com/images/signature/signature-solution-nrj.jpg" alt="Solution NRJ — Generatricediesel.com — 438-350-6979" width="300" style="display:block;width:300px;max-width:100%;height:auto;border:0;"></a></td></tr><tr><td style="font-family:Arial,sans-serif;font-size:12px;line-height:18px;"><strong>Solution NRJ</strong><br><a href="https://generatricediesel.com/" style="color:#07599b;">generatricediesel.com</a><br><a href="tel:+14383506979" style="color:#263e55;text-decoration:none;">438-350-6979</a><br><a href="mailto:ventes@solutionnrj.com" style="color:#07599b;">ventes@solutionnrj.com</a></td></tr></table>';

const FROM = "Solution NRJ <ventes@solutionnrj.com>";
const TEAM = "ventes@solutionnrj.com";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const isEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function quoteSendingEnabled(env: QuoteEnv): boolean {
  return (
    env.QUOTATION_EMAIL_ENABLED === "true" &&
    env.QUOTE_WRITES_ENABLED === "true" &&
    Boolean(env.RESEND_API_KEY) &&
    Boolean(env.QUOTE_REGISTER_PASSWORD)
  );
}

/** Réserve un numéro S-AAAA-NNNN. Le même requestId renvoie toujours le même numéro. */
export async function reserveQuoteNumber(
  env: QuoteEnv,
  req: QuoteRequest,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; number: string; revision: number }> {
  const base = env.QUOTE_REGISTER_URL.replace(/\/$/, "");
  const register: typeof fetch = env.QUOTE_REGISTER ? (input, init) => env.QUOTE_REGISTER!.fetch(input, init) : fetchImpl;
  const login = await register(`${base}/api/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password: env.QUOTE_REGISTER_PASSWORD }),
    signal: AbortSignal.timeout(15000),
  });
  if (!login.ok) throw new Error(`quote_login_${login.status}`);
  const cookie = login.headers.get("set-cookie");
  if (!cookie?.startsWith("nrj_session=")) throw new Error("quote_cookie_missing");
  const headers = { Cookie: cookie.split(";")[0], Origin: base, "Content-Type": "application/json" };

  const c = req.client;
  const client = {
    id: `messenger-${req.psid}`,
    name: c.fullName,
    company: c.company ?? "",
    email: c.email,
    phone: c.phone ?? "",
    address: c.address ?? "",
    notes: "Client Messenger",
  };
  const clientRes = await register(`${base}/api/clients`, { method: "POST", headers, body: JSON.stringify(client), signal: AbortSignal.timeout(15000) });
  if (!clientRes.ok) throw new Error(`quote_client_${clientRes.status}`);

  const m = req.model;
  const quoteRes = await register(`${base}/api/quotes`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      client,
      clientId: client.id,
      requestId,
      title: `Génératrice diesel ${m.brand} ${m.powerKw} kW`,
      date: req.issuedOn,
      validUntil: addMonths(req.issuedOn),
      status: "Envoyée",
      followup: "",
      lines: [{ description: `Génératrice diesel ${m.brand} ${m.powerKw} kW`, qty: req.quantity, price: String(m.priceCad) }],
      conditions: "Pour toute commande, dépôt de 30 % du total avec taxes.\n" + QUOTE_CONDITIONS.join("\n"),
      notes: `Envoyée par le bot Messenger. Tension demandée : ${req.voltage ?? "non précisée"}.`,
    }),
  });
  if (!quoteRes.ok) throw new Error(`quote_create_${quoteRes.status}`);
  const quote = (await quoteRes.json()) as { id: number; number: string; revision: number };
  if (!/^S-\d{4}-\d{4,}$/.test(quote.number ?? "")) throw new Error("quote_number_missing");
  return quote;
}

async function sendEmail(env: QuoteEnv, payload: object, idempotencyKey: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`email_${res.status}`);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("email_acceptance_unconfirmed");
  return body.id;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

const html = (lines: string[]) =>
  '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#172b42">' +
  lines.map((l) => escapeHtml(l)).join("<br>") +
  "<br>" +
  SIGNATURE_HTML +
  "</div>";

/**
 * Parcours complet : numéro du registre → PDF → courriel Resend (copie cachée à l'équipe,
 * qui l'archive dans Dolibarr). Le prospect reste dans BOT_STATE (lead:<psid>).
 */
export async function sendOfficialQuote(env: QuoteEnv, req: QuoteRequest, fetchImpl: typeof fetch = fetch): Promise<QuoteResult> {
  if (req.model.priceCad === null || !req.model.quotable) throw new Error("not_quotable");
  if (!isEmail(req.client.email) || !req.client.fullName.trim()) throw new Error("client_identity_required");

  // Même soumission (mêmes données, même jour) → même numéro ; une donnée change → nouvelle soumission.
  const fingerprint = await sha256Hex(
    JSON.stringify([req.psid, req.model.key, req.quantity, req.voltage, req.issuedOn, req.client.fullName, req.client.company, req.client.email, req.client.phone, req.client.address]),
  );
  const requestId = `messenger-${req.psid}-${req.model.key}-${fingerprint.slice(0, 16)}`;
  const quote = await reserveQuoteNumber(env, req, requestId, fetchImpl);
  const revision = quote.revision || 1;
  const validUntil = addMonths(req.issuedOn);
  const pdf = await buildQuotePdf({
    number: quote.number,
    revision,
    issuedOn: req.issuedOn,
    validUntil,
    client: req.client,
    model: req.model,
    quantity: req.quantity,
    voltage: req.voltage,
  });
  const totals = computeTotals(req.model.priceCad, req.quantity);
  const title = req.model.name.replace(/ \(ouverte\)$/, "");
  const lines = [
    `Bonjour ${req.client.fullName},`,
    "",
    `Veuillez trouver en pièce jointe votre soumission ${quote.number} pour une ${title.toLowerCase()}.`,
    "",
    `Total : ${formatMoney(totals.total)} taxes incluses.`,
    "Validité de la soumission : 3 mois.",
    "Pour toute commande, dépôt de 30 % du total avec taxes.",
    "L'installation, la disponibilité et le délai sont à confirmer avec notre équipe.",
    "",
    `Fiche du modèle : ${req.model.url}`,
    "",
    "Pour accepter, signez la soumission et retournez-la par courriel.",
  ];
  const payload = {
      from: FROM,
      to: [req.client.email],
      bcc: [TEAM],
      reply_to: TEAM,
      subject: `Soumission ${quote.number} — ${title}`,
      text: lines.join("\n") + `\n\nSolution NRJ\nhttps://${SUPPLIER.web}\n${SUPPLIER.phone}`,
      html: html(lines),
      attachments: [{ filename: `${quote.number}.pdf`, content: toBase64(pdf) }],
  };
  // La clé couvre tout le contenu : un nouvel essai identique n'envoie rien de plus,
  // un contenu différent obtient sa propre clé au lieu d'un refus 409 de Resend.
  const contentHash = (await sha256Hex(JSON.stringify(payload))).slice(0, 16);
  const emailId = await sendEmail(env, payload, `messenger-quote-${quote.number}-R${revision}-${contentHash}`, fetchImpl);

  // Le courriel est accepté par Resend : ce n'est pas une preuve de réception.
  // Copie du PDF pour l'archive locale (relevée chaque heure par la tâche Dolibarr) :
  // un échec est seulement journalisé, l'envoi reste valide.
  await archiveQuotePdf(env, { number: quote.number, revision, psid: req.psid, modelKey: req.model.key, email: req.client.email }, pdf).catch((error) =>
    console.error("archive_pdf", error),
  );
  return { number: quote.number, revision, emailId, total: totals.total, deposit: totals.deposit };
}

/** Durée de conservation des copies de PDF dans BOT_STATE. */
export const PDF_ARCHIVE_TTL_SECONDS = 90 * 24 * 3600;

/**
 * Dépose le PDF envoyé dans BOT_STATE, clé « pdf:S-AAAA-NNNN-R<révision> », avec ses
 * métadonnées pour l'import Dolibarr ; une révision ne remplace jamais la précédente.
 */
export async function archiveQuotePdf(
  env: QuoteEnv,
  q: { number: string; revision: number; psid: string; modelKey: string; email: string | null },
  pdf: Uint8Array,
  now = new Date().toISOString(),
): Promise<string | null> {
  if (!env.BOT_STATE) return null;
  const key = `pdf:${q.number}-R${q.revision}`;
  await env.BOT_STATE.put(key, pdf, {
    expirationTtl: PDF_ARCHIVE_TTL_SECONDS,
    metadata: { type: "soumission", quote_ref: q.number, revision: q.revision, psid: q.psid, email: q.email, model_key: q.modelKey, created_at: now },
  });
  return key;
}

/** Fiche détaillée par courriel (sans numéro de soumission). */
export async function sendSpecSheet(
  env: QuoteEnv,
  args: { psid: string; model: Model; email: string; name: string | null; rows: [string, string][] },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!isEmail(args.email)) throw new Error("invalid_email");
  const m = args.model;
  const title = `Génératrice diesel ${m.brand} ${m.powerKw} kW`;
  const lines = [
    `Bonjour${args.name ? ` ${args.name}` : ""},`,
    "",
    `Voici la fiche de la ${title.toLowerCase()} :`,
    "",
    ...args.rows.map(([k, v]) => `${k} : ${v}`),
    m.dimensions ? `Dimensions : ${m.dimensions}` : "",
    "Garantie : 1 an ou 1 500 heures, selon la première limite atteinte.",
    m.priceCad !== null ? `Prix : ${formatMoney(m.priceCad)} avant taxes.` : "Prix : sur demande.",
    "",
    `Photos et détails : ${m.url}`,
    "",
    "Pour une soumission officielle, répondez à ce courriel ou écrivez-nous sur Messenger.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  const payload = { from: FROM, to: [args.email], reply_to: TEAM, subject: `Fiche — ${title}`, text: lines.join("\n"), html: html(lines) };
  // Comme pour la soumission : la clé couvre tout le contenu, sinon Resend refuse
  // (409) une fiche renvoyée dans les 24 h avec un texte ou un nom différent.
  const contentHash = (await sha256Hex(JSON.stringify(payload))).slice(0, 16);
  return sendEmail(env, payload, `messenger-fiche-${args.psid}-${m.key}-${contentHash}`, fetchImpl);
}
