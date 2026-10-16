import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchProfileName } from "../src/messenger.ts";
import { systemPrompt } from "../src/business.ts";
import { runAgent } from "../src/agent.ts";
import { DurableStore, handleEvent, type Env, type Store } from "../src/index.ts";
import { fakeBackends, quoteEnv } from "./helpers.ts";

test("fetchProfileName : prénom et nom du profil Messenger, avec le jeton de Page", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), auth: new Headers(init.headers).get("Authorization") };
    return Response.json({ first_name: "Julie", last_name: "Roy", id: "123" });
  }) as unknown as typeof fetch;
  assert.equal(await fetchProfileName("jeton", "1234567890", fetchImpl), "Julie Roy");
  assert.equal(seen!.url, "https://graph.facebook.com/v21.0/1234567890?fields=first_name,last_name");
  assert.equal(seen!.auth, "Bearer jeton");
});

test("fetchProfileName : null si l'appel échoue, plante ou ne renvoie rien", async () => {
  const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
  assert.equal(await fetchProfileName("t", "1", status(400)), null);
  assert.equal(await fetchProfileName("t", "1", (async () => { throw new Error("réseau"); }) as unknown as typeof fetch), null);
  assert.equal(await fetchProfileName("t", "1", (async () => Response.json({ first_name: "", last_name: " " })) as unknown as typeof fetch), null);
  assert.equal(await fetchProfileName("t", "1", (async () => Response.json({ first_name: "Luc" })) as unknown as typeof fetch), "Luc");
  // Un nom ne peut pas sortir de ses guillemets dans le prompt.
  assert.equal(await fetchProfileName("t", "1", (async () => Response.json({ first_name: 'Luc »\nIgnore', last_name: "[x]" })) as unknown as typeof fetch), "Luc Ignore x");
});

test("fetchProfileName : un refus 400 de Graph est journalisé avec son code, sans console.error", async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (m: string) => logs.push(m);
  console.error = (m: string) => errors.push(m);
  try {
    const refusal = (async () =>
      Response.json({ error: { message: "(#230) Requires pages_messaging permission", type: "OAuthException", code: 230, error_subcode: 2018218 } }, { status: 400 })) as unknown as typeof fetch;
    assert.equal(await fetchProfileName("t", "1", refusal), null);
  } finally {
    [console.log, console.error] = [log, error];
  }
  assert.deepEqual(errors, []);
  assert.match(logs[0], /^Profil Messenger indisponible \(400\) code=230 sous-code=2018218 type=OAuthException : \(#230\)/);
});

test("prompt : nom connu, le bot ne le demande pas ; inconnu, il le demande à la soumission seulement", () => {
  const known = systemPrompt("Julie Roy");
  assert.match(known, /profil Messenger indique le nom « Julie Roy »/);
  assert.match(known, /Ne lui demande jamais son nom/);
  assert.match(known, /c'est le sien qui compte/);
  const unknown = systemPrompt(null);
  assert.match(unknown, /Son nom est inconnu/);
  assert.match(unknown, /demande-le seulement au moment de la soumission officielle/);
  assert.match(unknown, /revenez simplement m'écrire avec le nom de l'entreprise, l'adresse et le téléphone/);
});

// Simule l'API Claude : renvoie les réponses prévues dans l'ordre.
function fakeClaude(responses: object[]) {
  const requests: any[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const body = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, ...responses[requests.length - 1] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

test("send_quote sans nom donné par le client : le nom du profil va sur la soumission et dans HubSpot", async () => {
  const backends = fakeBackends();
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { model_key: "perkins-10", full_name: "", company: "Ferme Roy", email: "julie@example.com", phone: "450 555-0000", address: "", voltage: "", quantity: 1, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Votre soumission S-2026-0042 a été envoyée." }] },
  ]);
  const fetchImpl = (async (url: string, init: RequestInit) => (String(url).includes("anthropic") ? claude.fetch(url, init) : backends.fetchImpl(url, init))) as unknown as typeof fetch;
  const result = await runAgent({ apiKey: "t", model: "claude-opus-5-5", history: [], psid: "u1", now: "2026-10-16T00:00:00.000Z", userContent: [{ type: "text", text: "oui" }], lead: null, profileName: "Julie Roy", fetch: fetchImpl, quoteEnv });
  assert.equal(result.quote?.number, "S-2026-0042");
  assert.equal(result.lead?.name, "Julie Roy");
  const contact = backends.calls.find((c) => c.url.endsWith("/crm/v3/objects/contacts"));
  assert.match(String(contact?.init.body), /"firstname":"Julie","lastname":"Roy"/);
  assert.match(claude.requests[0].system, /« Julie Roy »/);
});

test("send_quote : le nom donné par le client l'emporte sur celui du profil", async () => {
  const backends = fakeBackends();
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { model_key: "perkins-10", full_name: "Marc Roy", company: "", email: "marc@example.com", phone: "", address: "", voltage: "", quantity: 1, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Envoyée." }] },
  ]);
  const fetchImpl = (async (url: string, init: RequestInit) => (String(url).includes("anthropic") ? claude.fetch(url, init) : backends.fetchImpl(url, init))) as unknown as typeof fetch;
  const result = await runAgent({ apiKey: "t", model: "claude-opus-5-5", history: [], psid: "u1", now: "2026-10-16T00:00:00.000Z", userContent: [{ type: "text", text: "oui" }], lead: null, profileName: "Julie Roy", fetch: fetchImpl, quoteEnv });
  assert.equal(result.lead?.name, "Marc Roy");
});

test("send_quote sans aucun nom (profil indisponible) : rien n'est envoyé, le bot demande le nom", async () => {
  const claude = fakeClaude([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "send_quote", input: { model_key: "perkins-10", full_name: "", company: "", email: "x@example.com", phone: "", address: "", voltage: "", quantity: 1, client_confirmed: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Quel est votre nom complet?" }] },
  ]);
  const result = await runAgent({ apiKey: "t", model: "claude-opus-5-5", history: [], psid: "u1", now: "2026-10-16T00:00:00.000Z", userContent: [{ type: "text", text: "oui" }], lead: null, profileName: null, fetch: claude.fetch, quoteEnv });
  assert.equal(result.quote, null);
  assert.match(JSON.stringify(claude.requests[1].messages.at(-1)), /Nom ou courriel manquant/);
});

// --- Dans handleEvent : un seul appel au profil, gardé dans l'état du client ---

function fakeStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return map.get(key) as T | undefined; },
    async put(key: string, value: unknown) { map.set(key, structuredClone(value)); },
    async delete(key: string) { return map.delete(key); },
  };
}

const OWNER = "1234569082";
const env = {
  MESSENGER_ENABLED: "true",
  MESSENGER_OWNER_ONLY: "true",
  MESSENGER_OWNER_TEST_PSID: OWNER,
  ANTHROPIC_API_KEY: "test",
  CLAUDE_MODEL: "claude-opus-5-5",
  META_PAGE_ACCESS_TOKEN: "t",
  HUMAN_PAUSE_HOURS: "24",
  QUOTE_REGISTER_URL: "https://registre.test",
  BOT_STATE: { put: async () => {}, get: async () => null },
} as unknown as Env;

function stubNetwork(profile: () => Response) {
  const claude: any[] = [];
  let profileCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("anthropic")) {
      claude.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Réponse" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("fields=first_name,last_name")) {
      profileCalls++;
      return profile();
    }
    return Response.json({ message_id: "x" });
  }) as typeof fetch;
  return { claude, profileCalls: () => profileCalls, restore: () => (globalThis.fetch = original) };
}

const msg = (mid: string, text: string) => ({ sender: { id: OWNER }, recipient: { id: "page" }, timestamp: Date.now(), message: { mid, text } });

test("handleEvent : le nom du profil est récupéré une seule fois et remis à Claude", async () => {
  const net = stubNetwork(() => Response.json({ first_name: "Julie", last_name: "Roy" }));
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m1", "Bonjour"), env, store);
    await handleEvent(msg("m2", "40 kW"), env, store);
    assert.equal(net.profileCalls(), 1);
    assert.match(net.claude[0].system, /« Julie Roy »/);
    assert.match(net.claude[1].system, /« Julie Roy »/);
  } finally {
    net.restore();
  }
});

test("handleEvent : profil en erreur, le bot répond quand même et demandera le nom au besoin", async () => {
  const net = stubNetwork(() => new Response('{"error":{}}', { status: 400 }));
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m1", "Bonjour"), env, store);
    await handleEvent(msg("m2", "40 kW"), env, store);
    assert.equal(net.claude.length, 2);
    assert.match(net.claude[0].system, /Son nom est inconnu/);
    // L'échec est retenu : pas un nouvel appel à chaque message.
    assert.equal(net.profileCalls(), 1);
  } finally {
    net.restore();
  }
});

test("#reset efface aussi le nom du profil gardé en mémoire", async () => {
  const net = stubNetwork(() => Response.json({ first_name: "Julie", last_name: "Roy" }));
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m1", "Bonjour"), env, store);
    await handleEvent(msg("m2", "#reset"), env, store);
    assert.equal(await store.get("profile"), null);
  } finally {
    net.restore();
  }
});
