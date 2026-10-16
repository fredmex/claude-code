import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, findModel, phasesFor } from "../src/catalogue.ts";
import { addMonths, buildQuotePdf, computeTotals, descriptionRows, formatMoney } from "../src/quote-pdf.ts";
import { sendOfficialQuote } from "../src/quote-service.ts";
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

test("sendOfficialQuote : HubSpot, numéro du registre, PDF archivé et envoyé, étape de l'affaire", async () => {
  const { calls, fetchImpl } = fakeBackends();
  const result = await sendOfficialQuote(quoteEnv, request, fetchImpl);

  assert.equal(result.number, "S-2026-0042");
  assert.equal(result.total, 40241.25);
  assert.equal(result.contactId, "501");
  const order = calls.map((c) => new URL(c.url).pathname);
  // Contact et affaire avant le numéro ; archive avant le courriel ; étape après le courriel.
  assert.ok(order.indexOf("/crm/v3/objects/contacts") < order.indexOf("/api/quotes"));
  assert.ok(order.indexOf("/files/v3/files") < order.indexOf("/emails"));
  assert.ok(order.indexOf("/emails") < order.indexOf("/crm/v3/objects/deals/901"));

  const contact = JSON.parse(String(calls.find((c) => c.url.endsWith("/crm/v3/objects/contacts"))!.init.body));
  assert.deepEqual(contact.properties, { email: "luc@example.com", firstname: "Luc", lastname: "Tremblay", phone: "8195551234" });
  const quoteBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/quotes"))!.init.body));
  assert.match(quoteBody.requestId, /^messenger-u1-perkins-60-[0-9a-f]{16}$/);
  assert.equal(quoteBody.clientId, "hubspot-501");
  const stage = JSON.parse(String(calls.find((c) => c.url.endsWith("/deals/901"))!.init.body));
  assert.equal(stage.properties.dealstage, "presentationscheduled");

  const mailCall = calls.find((c) => c.url === "https://api.resend.com/emails")!;
  const mail = JSON.parse(String(mailCall.init.body));
  assert.deepEqual(mail.to, ["luc@example.com"]);
  assert.deepEqual(mail.bcc, ["ventes@solutionnrj.com"]);
  assert.equal(mail.from, "Solution NRJ <ventes@solutionnrj.com>");
  assert.equal(mail.attachments[0].filename, "S-2026-0042.pdf");
  assert.ok(atob(mail.attachments[0].content).startsWith("%PDF-"));
  assert.match((mailCall.init.headers as Record<string, string>)["Idempotency-Key"], /^messenger-quote-S-2026-0042-R1-[0-9a-f]{16}$/);
});

test("contact HubSpot existant : réutilisé sans être modifié, soumission envoyée quand même", async () => {
  const { calls, fetchImpl } = fakeBackends({ existingContact: true });
  const result = await sendOfficialQuote(quoteEnv, request, fetchImpl);
  assert.equal(result.contactId, "77");
  assert.equal(result.number, "S-2026-0042");
  const paths = calls.map((c) => new URL(c.url).pathname);
  assert.ok(!paths.includes("/crm/v3/objects/contacts"), "aucun contact créé ni modifié");
  assert.ok(!calls.some((c) => c.init.method === "PATCH" && c.url.includes("/contacts/")), "aucun champ du contact écrasé");
  assert.ok(paths.includes("/emails"));
  const firstNote = JSON.parse(String(calls.find((c) => c.url.endsWith("/crm/v3/objects/notes"))!.init.body));
  assert.match(firstNote.properties.hs_note_body, /contact existant/);
  assert.equal(firstNote.associations[0].to.id, "77");
  const quoteBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/quotes"))!.init.body));
  assert.equal(quoteBody.clientId, "hubspot-77");
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
  assert.match(systemPrompt(), /n'insiste jamais pour le code postal/);
  assert.doesNotMatch(systemPrompt(), /conseiller le rappelle/);
  assert.match(systemPrompt(), /continue avec CE modèle/);
  assert.match(systemPrompt(), /Perkins 40 kW \[perkins-40\] par défaut/);
  assert.match(systemPrompt(), /ne dis jamais qu'elle est envoyée/);
  assert.match(systemPrompt(), /courrier indésirable/);
  assert.match(systemPrompt(), /ARRÊTE les questions de qualification/);
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
