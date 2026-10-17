import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, findModel, phasesFor } from "../src/catalogue.ts";
import { addMonths, buildQuotePdf, computeTotals, descriptionRows, formatMoney } from "../src/quote-pdf.ts";
import { sendOfficialQuote, sendSpecSheet } from "../src/quote-service.ts";
import { PDFDocument } from "pdf-lib";
import { fakeBackends, quoteEnv } from "./helpers.ts";

test("taxes, total et dépôt au cent près", () => {
  assert.deepEqual(computeTotals(35000, 1), { subtotal: 35000, tps: 1750, tvq: 3491.25, total: 40241.25, deposit: 12072.38 });
  assert.equal(computeTotals(12500, 2).total, 28743.75);
  assert.equal(formatMoney(40241.25), "40 241,25 $");
  assert.equal(formatMoney(1750), "1 750,00 $");
});

test("validité de 3 mois, fin de mois incluse", () => {
  assert.equal(addMonths("2026-10-16"), "2027-01-16");
  assert.equal(addMonths("2026-11-30"), "2027-02-28");
});

test("phases déduites de la tension", () => {
  assert.equal(phasesFor("120/240 V"), "Monophasé");
  assert.equal(phasesFor("600 V"), "Triphasé");
  assert.equal(phasesFor("347/600 V"), "Triphasé");
  assert.equal(phasesFor("480 V"), "Triphasé");
  assert.equal(phasesFor("550 V"), "Triphasé"); // même réseau que le 600 V
  assert.equal(phasesFor("575 V"), "Triphasé");
  assert.equal(phasesFor(null), "À confirmer");
});

test("description : 11 lignes dans l'ordre du PRD, règles respectées", () => {
  const rows = descriptionRows(findModel("perkins-20-ouverte")!, null);
  assert.deepEqual(rows.map(([k]) => k), ["Moteur", "Puissance", "Tension", "Alternateur", "Phases", "Boîtier", "Réservoir", "Chauffe-moteur", "Chargeur de batterie", "Contrôleur", "Certifications"]);
  assert.equal(rows[3][1], "Stamford d'origine");
  assert.equal(rows[6][1], "200 litres"); // modèle ouvert
  assert.equal(rows[4][1], "Monophasé · 60 Hz");
  assert.equal(rows[10][1], "CSA · EPA");
  const all = JSON.stringify(CATALOGUE) + JSON.stringify(rows);
  assert.doesNotMatch(all, /cummins|transport|inverseur/i);
});

test("chaque modèle avec prix produit un PDF d'une page", async () => {
  assert.equal(findModel("kubota-40")?.quotable, false);
  assert.equal(findModel("perkins-25")?.quotable, false);
  for (const model of CATALOGUE.filter((m) => m.quotable)) {
    const pdf = await buildQuotePdf({ number: "S-2026-0099", revision: 1, issuedOn: "2026-10-16", validUntil: "2027-01-16", client: { fullName: "Test", company: null, email: "t@example.com", phone: null, address: null }, model, quantity: 1, voltage: null });
    assert.equal(new TextDecoder("latin1").decode(pdf.slice(0, 5)), "%PDF-");
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1, model.key);
  }
  await assert.rejects(buildQuotePdf({ number: "S-2026-0099", revision: 1, issuedOn: "2026-10-16", validUntil: "2027-01-16", client: { fullName: "T", company: null, email: null, phone: null, address: null }, model: findModel("perkins-25")!, quantity: 1, voltage: null }), /price_on_request/);
});

const request = { psid: "u1", model: findModel("perkins-60")!, quantity: 1, voltage: null, issuedOn: "2026-10-16", client: { fullName: "Luc Tremblay", company: null, email: "luc@example.com", phone: "8195551234", address: null } };

test("sendOfficialQuote : numéro du registre, PDF envoyé par courriel, aucun appel HubSpot", async () => {
  const { calls, fetchImpl } = fakeBackends(); // tout appel inattendu (HubSpot compris) lève une erreur
  const result = await sendOfficialQuote(quoteEnv, request, fetchImpl);

  assert.equal(result.number, "S-2026-0042");
  assert.equal(result.total, 40241.25);
  const order = calls.map((c) => new URL(c.url).pathname);
  assert.ok(order.indexOf("/api/quotes") < order.indexOf("/emails"));
  assert.ok(!calls.some((c) => c.url.includes("hubapi")));

  const quoteBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/quotes"))!.init.body));
  assert.match(quoteBody.requestId, /^messenger-u1-perkins-60-[0-9a-f]{16}$/);
  assert.equal(quoteBody.clientId, "messenger-u1");

  const mailCall = calls.find((c) => c.url === "https://api.resend.com/emails")!;
  const mail = JSON.parse(String(mailCall.init.body));
  assert.deepEqual(mail.to, ["luc@example.com"]);
  assert.deepEqual(mail.bcc, ["ventes@solutionnrj.com"]);
  assert.equal(mail.from, "Solution NRJ <ventes@solutionnrj.com>");
  assert.equal(mail.attachments[0].filename, "S-2026-0042.pdf");
  // Signature : image hébergée sur le site, plus rien chez HubSpot.
  assert.match(mail.html, /https:\/\/generatricediesel\.com\/images\/signature\/signature-solution-nrj\.jpg/);
  assert.doesNotMatch(mail.html, /hubspot/i);
  assert.ok(atob(mail.attachments[0].content).startsWith("%PDF-"));
  assert.match((mailCall.init.headers as Record<string, string>)["Idempotency-Key"], /^messenger-quote-S-2026-0042-R1-[0-9a-f]{16}$/);
});

test("pas de soumission automatique pour le Kubota", async () => {
  const { calls, fetchImpl } = fakeBackends();
  await assert.rejects(sendOfficialQuote(quoteEnv, { ...request, model: findModel("kubota-40")! }, fetchImpl), /not_quotable/);
  assert.equal(calls.length, 0);
});

test("le registre des soumissions passe par la liaison de service quand elle existe", async () => {
  const { calls, fetchImpl } = fakeBackends();
  const viaBinding: string[] = [];
  const env = { ...quoteEnv, QUOTE_REGISTER: { fetch: ((url: string, init: RequestInit) => { viaBinding.push(new URL(url).pathname); return fetchImpl(url, init); }) as unknown as typeof fetch } };
  const result = await sendOfficialQuote(env, request, fetchImpl);
  assert.equal(result.number, "S-2026-0042");
  assert.deepEqual(viaBinding, ["/api/login", "/api/clients", "/api/quotes"]);
  assert.ok(calls.some((c) => c.url === "https://api.resend.com/emails"));
});

test("le prompt interdit de planifier une installation", async () => {
  const { systemPrompt } = await import("../src/business.ts");
  assert.match(systemPrompt(), /Ne demande jamais de planifier/);
  assert.doesNotMatch(systemPrompt(), /meilleur moment/);
  assert.match(systemPrompt(), /même si un envoi précédent a échoué/);
  assert.match(systemPrompt(), /Ne demande ni la tension, ni les phases, ni le boîtier, ni la quantité/);
  assert.match(systemPrompt(), /UN SEUL message/);
  assert.match(systemPrompt(), /Ne demande jamais la ville/);
  assert.match(systemPrompt(), /demande SEULEMENT son courriel pour lui envoyer la fiche/);
  assert.match(systemPrompt(), /ne demande pas l'usage/);
  assert.doesNotMatch(systemPrompt(), /électricien certifié/);
  assert.match(systemPrompt(), /faq\/#maison-puissance/);
  assert.match(systemPrompt(), /Le DMW est facultatif/);
  assert.match(systemPrompt(), /blogue\/dmw-compteur-generatrice\//);
  assert.match(systemPrompt(), /ne dis jamais « il vous faut X kW »/);
  assert.match(systemPrompt(), /si ce budget lui convient/);
  assert.doesNotMatch(systemPrompt(), /Chauffage électrique ou non/);
  assert.doesNotMatch(systemPrompt(), /plus compacte que la 60 kW/);
  assert.match(systemPrompt(), /revenez simplement m'écrire avec le nom de l'entreprise, l'adresse et le téléphone/);
  assert.doesNotMatch(systemPrompt(), /avec votre nom/);
  assert.match(systemPrompt(), /n'insiste jamais pour le code postal/);
  assert.doesNotMatch(systemPrompt(), /conseiller le rappelle/);
  assert.match(systemPrompt(), /continue avec CE modèle/);
  assert.match(systemPrompt(), /Perkins 40 kW \[perkins-40\] par défaut/);
  assert.match(systemPrompt(), /ne dis jamais qu'elle est envoyée/);
  assert.match(systemPrompt(), /courrier indésirable/);
  assert.match(systemPrompt(), /ARRÊTE les questions de qualification/);
  // 550 V et 575 V : même réseau que le 600 V, ni refus ni transfert.
  assert.match(systemPrompt(), /550 V et 575 V : c'est le même réseau que le 600 V \(347\/600 V triphasé\)/);
  assert.match(systemPrompt(), /550 V ou 575 V = 347\/600 V triphasé/);
});

test("fetch jamais appelé comme méthode d'un objet (règle de Workers : Illegal invocation)", async () => {
  const { fetchImpl } = fakeBackends();
  // Comme le fetch de Workers : refuse un appel dont `this` est un autre objet.
  const strictFetch = function (this: unknown, url: string, init: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return fetchImpl(url, init);
  } as unknown as typeof fetch;
  const result = await sendOfficialQuote(quoteEnv, request, strictFetch);
  assert.equal(result.number, "S-2026-0042");
});

test("même soumission retentée : même PDF, même numéro demandé, même clé Resend ; données changées : nouvelle demande", async () => {
  const pdfInput = { number: "S-2026-0042", revision: 1, issuedOn: "2026-10-16", validUntil: "2027-01-16", client: request.client, model: request.model, quantity: 1, voltage: null };
  const [a, b] = await Promise.all([buildQuotePdf(pdfInput), buildQuotePdf(pdfInput)]);
  assert.deepEqual(a, b, "le PDF doit être identique d'un essai à l'autre");

  const keys = async (req: typeof request) => {
    const { calls, fetchImpl } = fakeBackends();
    await sendOfficialQuote(quoteEnv, req, fetchImpl);
    const requestId = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/quotes"))!.init.body)).requestId;
    const resendKey = (calls.find((c) => c.url === "https://api.resend.com/emails")!.init.headers as Record<string, string>)["Idempotency-Key"];
    return { requestId, resendKey };
  };
  const first = await keys(request);
  const retry = await keys(request);
  assert.deepEqual(retry, first);
  const changed = await keys({ ...request, client: { ...request.client, address: "9 rue Neuve, Québec, G1R 1A1" } });
  assert.notEqual(changed.requestId, first.requestId);
  assert.notEqual(changed.resendKey, first.resendKey);
});

test("fiche renvoyée dans les 24 h avec un contenu différent : nouvelle clé Resend, pas de 409", async () => {
  // Faux Resend qui applique l'idempotence : même clé avec un autre contenu = 409.
  const sent = new Map<string, string>();
  const keys: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
    const key = new Headers(init.headers).get("Idempotency-Key")!;
    keys.push(key);
    const body = String(init.body);
    if (sent.has(key) && sent.get(key) !== body) return new Response("{}", { status: 409 });
    sent.set(key, body);
    return Response.json({ id: `email_${sent.size}` });
  }) as unknown as typeof fetch;
  const model = findModel("perkins-40")!;
  const send = (name: string | null) =>
    sendSpecSheet(quoteEnv, { psid: "p1", model, email: "client@exemple.ca", name, rows: descriptionRows(model, null) }, fetchImpl);

  await send(null);
  await send("Frederic Test"); // nom pris du profil : contenu différent
  await send("Frederic Test"); // même envoi retenté : même clé, rien de plus
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
  assert.equal(sent.size, 2);
});

test("soumission envoyée : copie du PDF dans BOT_STATE (pdf:numéro-Rrévision, 90 jours, métadonnées pour Dolibarr)", async () => {
  const puts: { key: string; value: unknown; options: any }[] = [];
  const BOT_STATE = { put: async (key: string, value: unknown, options: unknown) => void puts.push({ key, value, options }) } as unknown as KVNamespace;
  const { fetchImpl } = fakeBackends();
  await sendOfficialQuote({ ...quoteEnv, BOT_STATE }, request, fetchImpl);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, "pdf:S-2026-0042-R1");
  assert.ok(new TextDecoder().decode((puts[0].value as Uint8Array).slice(0, 5)) === "%PDF-");
  assert.equal(puts[0].options.expirationTtl, 90 * 24 * 3600);
  const { created_at, ...meta } = puts[0].options.metadata;
  assert.deepEqual(meta, { type: "soumission", quote_ref: "S-2026-0042", revision: 1, psid: "u1", email: "luc@example.com", model_key: "perkins-60" });
  assert.match(created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(JSON.stringify(puts[0].options.metadata).length < 1024); // limite des métadonnées KV
});

test("échec de la copie du PDF : la soumission reste envoyée", async () => {
  const BOT_STATE = { put: async () => { throw new Error("KV down"); } } as unknown as KVNamespace;
  const { calls, fetchImpl } = fakeBackends();
  const error = console.error;
  console.error = () => {};
  try {
    const result = await sendOfficialQuote({ ...quoteEnv, BOT_STATE }, request, fetchImpl);
    assert.equal(result.number, "S-2026-0042");
    assert.ok(calls.some((c) => c.url === "https://api.resend.com/emails"));
  } finally {
    console.error = error;
  }
});
