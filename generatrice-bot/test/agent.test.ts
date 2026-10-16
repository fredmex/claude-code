import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agent.ts";

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
  assert.match(result.reply, /membre de l'équipe/);
});
