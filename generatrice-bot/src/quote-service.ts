// Soumission officielle : numéro réservé dans l'application « solution-nrj-soumissions »,
// PDF au format approuvé, envoi par Resend depuis ventes@solutionnrj.com.
import { QUOTE_CONDITIONS, type Model } from "./catalogue.ts";
import { HubSpot, hubspotEnabled, type HubSpotEnv } from "./hubspot.ts";
import { addMonths, buildQuotePdf, computeTotals, formatMoney, SUPPLIER, type QuoteClient } from "./quote-pdf.ts";


export interface QuoteEnv extends HubSpotEnv {
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
  /** Contact HubSpot du client (requis, comme pour le générateur officiel). */
  contactId?: string;
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
  '<table lang="fr-CA" dir="ltr" role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;color:#263e55;max-width:320px;width:100%;"><tr><td style="padding-top:20px;padding-bottom:8px;"><a href="https://generatricediesel.com/"><img src="https://247524614.fs1.hubspotusercontent-na2.net/hubfs/247524614/2-Photo-2.jpg" alt="Solution NRJ — Generatricediesel.com — 438-350-6979" width="300" style="display:block;width:300px;max-width:100%;height:auto;border:0;"></a></td></tr><tr><td style="font-family:Arial,sans-serif;font-size:12px;line-height:18px;"><strong>Solution NRJ</strong><br><a href="https://generatricediesel.com/" style="color:#07599b;">generatricediesel.com</a><br><a href="tel:+14383506979" style="color:#263e55;text-decoration:none;">438-350-6979</a><br><a href="mailto:ventes@solutionnrj.com" style="color:#07599b;">ventes@solutionnrj.com</a></td></tr></table>';

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
    Boolean(env.QUOTE_REGISTER_PASSWORD) &&
    hubspotEnabled(env)
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
    id: req.contactId ? `hubspot-${req.contactId}` : `messenger-${req.psid}`,
    name: c.fullName,
    company: c.company ?? "",
    email: c.email,
    phone: c.phone ?? "",
    address: c.address ?? "",
    notes: req.contactId ? `Contact HubSpot ${req.contactId}` : "Client Messenger",
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

export interface QuoteResultWithCrm extends QuoteResult {
  contactId: string;
  dealId: string;
  fileId: string;
}

/**
 * Parcours complet, dans l'ordre de l'ancien service Messenger :
 * contact HubSpot (retrouvé ou créé, jamais écrasé) → affaire → numéro du registre → PDF →
 * archive privée HubSpot → courriel Resend → étape de l'affaire + note.
 * Un contact existant est réutilisé sans être modifié.
 */
export async function sendOfficialQuote(env: QuoteEnv, req: QuoteRequest, fetchImpl: typeof fetch = fetch): Promise<QuoteResultWithCrm> {
  if (req.model.priceCad === null || !req.model.quotable) throw new Error("not_quotable");
  if (!isEmail(req.client.email) || !req.client.fullName.trim()) throw new Error("client_identity_required");

  const hub = new HubSpot(env, fetchImpl);
  const crmLead = { fullName: req.client.fullName, email: req.client.email, phone: req.client.phone, company: req.client.company, address: req.client.address, powerKw: req.model.powerKw };
  const contact = await hub.findOrCreateContact(crmLead);
  const contactId = contact.id;
  if (contact.existing) {
    // Contact déjà connu : ses champs restent tels quels, les infos données dans Messenger vont en note.
    await hub.note(
      contactId,
      ["Demande Messenger (contact existant, champs non modifiés). Informations données par le client :",
        `Nom : ${req.client.fullName}`,
        req.client.company ? `Entreprise : ${req.client.company}` : "À titre personnel",
        req.client.address ? `Adresse : ${req.client.address}` : null,
        req.client.phone ? `Téléphone : ${req.client.phone}` : null,
      ].filter(Boolean).join("\n"),
    );
  }
  const dealId = await hub.createDeal(contactId, crmLead, "qualifiedtobuy");

  // Même soumission (mêmes données, même jour) → même numéro ; une donnée change → nouvelle soumission.
  const fingerprint = await sha256Hex(
    JSON.stringify([req.psid, req.model.key, req.quantity, req.voltage, req.issuedOn, req.client.fullName, req.client.company, req.client.email, req.client.phone, req.client.address]),
  );
  const requestId = `messenger-${req.psid}-${req.model.key}-${fingerprint.slice(0, 16)}`;
  const quote = await reserveQuoteNumber(env, { ...req, contactId }, requestId, fetchImpl);
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
  const fileId = await hub.archivePdf(contactId, pdf, quote.number);
  await hub.note(contactId, `Soumission ${quote.number} générée. Envoi non confirmé.`, fileId);

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
  await hub.setDealStage(dealId, "presentationscheduled");
  await hub.note(contactId, `Soumission ${quote.number}. Courriel accepté par Resend : ${emailId}. Destinataire : ${req.client.email}. Livraison en boîte non confirmée.`, fileId);
  return { number: quote.number, revision, emailId, total: totals.total, deposit: totals.deposit, contactId, dealId, fileId };
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
  return sendEmail(
    env,
    { from: FROM, to: [args.email], reply_to: TEAM, subject: `Fiche — ${title}`, text: lines.join("\n"), html: html(lines) },
    `messenger-fiche-${args.psid}-${m.key}`,
    fetchImpl,
  );
}
