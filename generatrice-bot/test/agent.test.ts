import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.ts";
import { findModel } from "../src/catalogue.ts";
import { fakeBackends, quoteEnv } from "./helpers.ts";

// Simule l'API Claude : renvoie les réponses prévues dans l'ordre et garde les requêtes reçues.
function fakeClaude(responses: object[]) {
  const requests: any[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const body = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, ...responses[requests.length - 1] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const base = { apiKey: "test", model: "claude-opus-5-5", history: [], psid: "u1", now: "2026-10-16T00:00:00.000Z" };

test("enregistre le prospect via save_lead et signale qu'il est qualifié", async () => {
  const claude = fakeClaude([
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "tu_1", name: "save_lead", input: { name: "Luc", company: null, usage: "secours maison", power_kw: 20, city: "Sherbrooke", voltage: "120/240 V", enclosure: null, phone: "819 555-1234", email: null, notes: null } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Merci Luc, un conseiller vous rappelle." }] },
  ]);
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "819 555-1234" }], lead: null, fetch: claude.fetch });

  assert.equal(result.reply, "Merci Luc, un conseiller vous rappelle.");
  assert.equal(result.lead?.phone, "8195551234");
  assert.equal(result.lead?.city, "Sherbrooke");
  assert.equal(result.leadQualified, true);
  assert.equal(result.transferReason, null);

  // Le 2e appel renvoie la réponse intacte (réflexion comprise) puis le résultat de l'outil.
  const second = claude.requests[1];
  assert.equal(second.model, "claude-opus-5-5");
  assert.equal(second.fallbacks, "default");
  assert.deepEqual(second.messages.at(-2).content[0], { type: "thinking", thinking: "", signature: "sig" });
  const toolResult = second.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.deepEqual(JSON.parse(toolResult.content).missing, []);
});

test("refuse un faux numéro sans rien enregistrer", async () => {
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "save_lead", input: { name: null, company: null, usage: null, power_kw: null, city: "Laval", voltage: null, enclosure: null, phone: "pas de tel", email: null, notes: null } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Pouvez-vous me redonner votre numéro ?" }] },
  ]);
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "pas de tel" }], lead: null, fetch: claude.fetch });
  assert.equal(result.lead, null);
  assert.equal(result.leadQualified, false);
  assert.equal(claude.requests[1].messages.at(-1).content[0].is_error, true);
});

test("transfert à un humain", async () => {
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "transfer_to_human", input: { reason: "Veut parler à un vendeur" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Un membre de l'équipe vous répond ici." }] },
  ]);
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "je veux un humain" }], lead: null, fetch: claude.fetch });
  assert.equal(result.transferReason, "Veut parler à un vendeur");
  assert.equal(result.reply, "Un membre de l'équipe vous répond ici.");
});

test("refus de sécurité : message poli, pas d'exception", async () => {
  const claude = fakeClaude([{ stop_reason: "refusal", content: [] }]);
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "..." }], lead: null, fetch: claude.fetch });
  assert.match(result.reply, /équipe/);
});

test("send_quote refusé sans confirmation explicite, puis envoyé après", async () => {
  const input = { model_key: "perkins-40", full_name: "Julie Roy", company: "Ferme Roy", email: "julie@example.com", phone: "450 555-0000", address: "123 rang Saint-Paul, Saint-Hyacinthe, J2S 1A1", voltage: null, quantity: 1 };
  const claudeResponses = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { ...input, client_confirmed: false } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "send_quote", input: { ...input, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "C'est envoyé! Voulez-vous aussi la fiche du 50 kW pour comparer?" }] },
  ];
  const claudeRequests: any[] = [];
  const backends = fakeBackends();
  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("anthropic")) {
      claudeRequests.push(JSON.parse(String(init.body)));
      const body = { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, ...claudeResponses[claudeRequests.length - 1] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    return backends.fetchImpl(url, init);
  }) as unknown as typeof fetch;

  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "oui, envoyez" }], lead: null, fetch: fakeFetch, quoteEnv });
  assert.equal(claudeRequests[1].messages.at(-1).content[0].is_error, true);
  assert.equal(result.quote?.number, "S-2026-0042");
  assert.equal(result.quote?.total, 33342.75);
  assert.equal(result.lead?.email, "julie@example.com");
  assert.match(result.lead?.notes ?? "", /S-2026-0042/);
  assert.equal(findModel("perkins-40")?.priceCad, 29000);
});

test("send_quote avec un courriel déjà dans HubSpot : la soumission part quand même, sans transfert", async () => {
  const backends = fakeBackends({ existingContact: true });
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { model_key: "perkins-10", full_name: "Marc Roy", company: null, email: "marc@example.com", phone: "514 555-1111", address: "45 rue Principale, Laval, H7N 1A1", voltage: null, quantity: 1, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Votre soumission S-2026-0042 est partie. Voulez-vous aussi la fiche du 15 kW?" }] },
  ]);
  const fetchImpl = (async (url: string, init: RequestInit) => (String(url).includes("anthropic") ? claude.fetch(url, init) : backends.fetchImpl(url, init))) as unknown as typeof fetch;
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "oui" }], lead: null, fetch: fetchImpl, quoteEnv });
  assert.equal(result.quote?.number, "S-2026-0042");
  assert.equal(result.transferReason, null);
});

test("send_quote quand l'envoi automatique est désactivé : rien n'est envoyé, le client est enregistré", async () => {
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { model_key: "perkins-10", full_name: "Marc", company: null, email: "marc@example.com", phone: "514 555-1111", address: "45 rue Principale, Laval, H7N 1A1", voltage: null, quantity: 1, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Un conseiller vous l'envoie rapidement. Pour quelle date en auriez-vous besoin?" }] },
  ]);
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "oui" }], lead: null, fetch: claude.fetch, quoteEnv: { QUOTE_REGISTER_URL: "https://registre.test" } });
  assert.equal(result.quote, null);
  assert.equal(result.lead?.email, "marc@example.com");
  assert.equal(claude.requests[1].messages.at(-1).content[0].is_error, true);
});

test("send_quote sans adresse ni téléphone : la soumission part quand même", async () => {
  const backends = fakeBackends();
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { model_key: "perkins-10", full_name: "Marc Roy", company: null, email: "marc@example.com", phone: null, address: null, voltage: null, quantity: 1, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Votre soumission S-2026-0042 a été envoyée par courriel à marc@example.com. Si vous avez d'autres questions, vous pouvez me les poser." }] },
  ]);
  const fetchImpl = (async (url: string, init: RequestInit) => (String(url).includes("anthropic") ? claude.fetch(url, init) : backends.fetchImpl(url, init))) as unknown as typeof fetch;
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "oui" }], lead: null, fetch: fetchImpl, quoteEnv });
  assert.equal(result.quote?.number, "S-2026-0042");
});

test("fiche par courriel : contact enregistré dans HubSpot avec nom, entreprise et téléphone", async () => {
  const backends = fakeBackends();
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "email_spec_sheet", input: { model_key: "perkins-40", email: "julie@example.com", name: "Julie Roy", company: "Ferme Roy", phone: "450 555-0000" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "La fiche est partie. Voulez-vous aussi une soumission officielle?" }] },
  ]);
  const fetchImpl = (async (url: string, init: RequestInit) => (String(url).includes("anthropic") ? claude.fetch(url, init) : backends.fetchImpl(url, init))) as unknown as typeof fetch;
  const result = await runAgent({ ...base, userContent: [{ type: "text", text: "Julie Roy, Ferme Roy, julie@example.com, 450 555-0000" }], lead: null, fetch: fetchImpl, quoteEnv });
  const contact = JSON.parse(String(backends.calls.find((c) => c.url.endsWith("/crm/v3/objects/contacts"))!.init.body));
  assert.deepEqual(contact.properties, { email: "julie@example.com", firstname: "Julie", lastname: "Roy", phone: "4505550000", company: "Ferme Roy" });
  assert.ok(backends.calls.some((c) => c.url === "https://api.resend.com/emails"));
  assert.equal(result.lead?.company, "Ferme Roy");
});
