import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, findModel, phasesFor } from "../src/catalogue.ts";
import { addMonths, buildQuotePdf, computeTotals, descriptionRows } from "../src/quote-pdf.ts";
import { sendOfficialQuote } from "../src/quote-service.ts";
import { PDFDocument } from "pdf-lib";

test("taxes, total et dépôt au cent près", () => {
  assert.deepEqual(computeTotals(35000, 1), { subtotal: 35000, tps: 1750, tvq: 3491.25, total: 40241.25, deposit: 12072.38 });
  assert.equal(computeTotals(12500, 2).total, 28743.75);
});

test("validité de 3 mois, fin de mois incluse", () => {
  assert.equal(addMonths("2026-10-16"), "2027-01-16");
  assert.equal(addMonths("2026-11-30"), "2027-02-28");
});

test("phases déduites de la tension", () => {
  assert.equal(phasesFor("120/240 V"), "Monophasé");
  assert.equal(phasesFor("600 V"), "Triphasé");
  assert.equal(phasesFor("347/600 V"), "Triphasé");
  assert.equal(phasesFor(null), "À confirmer");
});

test("description : 11 lignes dans l'ordre du PRD, règles respectées", () => {
  const rows = descriptionRows(findModel("perkins-20-ouverte")!, null);
  assert.deepEqual(rows.map(([k]) => k), ["Moteur", "Puissance", "Tension", "Alternateur", "Phases", "Boîtier", "Réservoir", "Chauffe-moteur", "Chargeur de batterie", "Contrôleur", "Certifications"]);
  assert.equal(rows[3][1], "Stamford d'origine");
  assert.equal(rows[6][1], "200 L"); // modèle ouvert
  assert.equal(rows[10][1], "CSA · EPA");
  const all = JSON.stringify(CATALOGUE) + JSON.stringify(rows);
  assert.doesNotMatch(all, /cummins|transport|inverseur/i);
});

test("chaque modèle avec prix produit un PDF d'une page", async () => {
  for (const model of CATALOGUE.filter((m) => m.priceCad !== null)) {
    const pdf = await buildQuotePdf({ number: "S-2026-0099", revision: 1, issuedOn: "2026-10-16", validUntil: "2027-01-16", client: { fullName: "Test", company: null, email: "t@example.com", phone: null, address: null }, model, quantity: 1, voltage: null });
    assert.equal(new TextDecoder("latin1").decode(pdf.slice(0, 5)), "%PDF-");
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1, model.key);
  }
  await assert.rejects(buildQuotePdf({ number: "S-2026-0099", revision: 1, issuedOn: "2026-10-16", validUntil: "2027-01-16", client: { fullName: "T", company: null, email: null, phone: null, address: null }, model: findModel("perkins-25")!, quantity: 1, voltage: null }), /price_on_request/);
});

test("sendOfficialQuote : numéro du registre, PDF joint, copie à l'équipe", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/login")) return new Response("{}", { headers: { "set-cookie": "nrj_session=abc; HttpOnly" } });
    if (url.endsWith("/api/clients")) return Response.json({ id: "messenger-u1" });
    if (url.endsWith("/api/quotes")) return Response.json({ id: 42, number: "S-2026-0042", revision: 1 });
    if (url === "https://api.resend.com/emails") return Response.json({ id: "email_1" });
    throw new Error("unexpected " + url);
  }) as unknown as typeof fetch;

  const env = { QUOTE_REGISTER_URL: "https://registre.test", QUOTE_REGISTER_PASSWORD: "x", QUOTE_WRITES_ENABLED: "true", QUOTATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "re_x" };
  const result = await sendOfficialQuote(env, { psid: "u1", model: findModel("perkins-60")!, quantity: 1, voltage: null, issuedOn: "2026-10-16", client: { fullName: "Luc Tremblay", company: null, email: "luc@example.com", phone: "8195551234", address: null } }, fakeFetch);

  assert.equal(result.number, "S-2026-0042");
  assert.equal(result.total, 40241.25);
  const quoteBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/api/quotes"))!.init.body));
  assert.equal(quoteBody.requestId, "messenger-u1-perkins-60-1");
  assert.equal((calls[1].init.headers as Record<string, string>).Cookie, "nrj_session=abc");
  const mail = JSON.parse(String(calls.at(-1)!.init.body));
  assert.deepEqual(mail.to, ["luc@example.com"]);
  assert.deepEqual(mail.bcc, ["ventes@solutionnrj.com"]);
  assert.equal(mail.from, "Solution NRJ <ventes@solutionnrj.com>");
  assert.equal(mail.attachments[0].filename, "S-2026-0042.pdf");
  assert.ok(atob(mail.attachments[0].content).startsWith("%PDF-"));
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>)["Idempotency-Key"], "messenger-quote-S-2026-0042-R1");
});
