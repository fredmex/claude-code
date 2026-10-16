import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversation, DurableStore, handleEvent, type Env, type Store } from "../src/index.ts";
import { AD_GREETING } from "../src/guards.ts";
import { BOT_METADATA } from "../src/messenger.ts";

/** Stockage de Durable Object en mémoire (lecture immédiatement cohérente, comme le vrai). */
function fakeStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) { return map.get(key) as T | undefined; },
    async put(key: string, value: unknown) { map.set(key, structuredClone(value)); },
    async delete(key: string) { return map.delete(key); },
    async setAlarm() {},
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

/** Remplace fetch : Claude répond « Réponse N » et garde ses requêtes ; Messenger répond ok. */
function stubNetwork() {
  const claudeRequests: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("anthropic")) {
      claudeRequests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: `Réponse ${claudeRequests.length}` }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return Response.json({ message_id: "x" });
  }) as typeof fetch;
  return { claudeRequests, restore: () => (globalThis.fetch = original) };
}

const msg = (mid: string, text: string) => ({ sender: { id: OWNER }, recipient: { id: "page" }, timestamp: Date.now(), message: { mid, text } });

test("deux messages rapides après #reset gardent le contexte", async () => {
  const net = stubNetwork();
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m0", "#reset"), env, store);
    await handleEvent(msg("m1", "je veux une 40 kW"), env, store);
    await handleEvent(msg("m2", "moi@example.com"), env, store);
    assert.equal(net.claudeRequests.length, 2);
    const second = JSON.stringify(net.claudeRequests[1].messages);
    assert.match(second, /je veux une 40 kW/);
    assert.match(second, /Réponse 1/);
    assert.equal(((await store.get<unknown[]>("history")) ?? []).length, 4);
  } finally {
    net.restore();
  }
});

test("la file du Durable Object traite les messages un à un, dans l'ordre", async () => {
  const net = stubNetwork();
  try {
    const storage = fakeStorage();
    const conversation = new Conversation({ storage } as unknown as DurableObjectState, env);
    for (const [mid, text] of [["a", "je veux une 60 kW"], ["b", "moi@example.com"]]) {
      const res = await conversation.fetch(new Request("https://conversation/event", { method: "POST", body: JSON.stringify(msg(mid, text)) }));
      assert.equal(res.status, 200);
    }
    await conversation.alarm();
    assert.equal(net.claudeRequests.length, 2);
    assert.match(JSON.stringify(net.claudeRequests[1].messages), /je veux une 60 kW/);
    assert.deepEqual(storage.map.get("queue"), []);
  } finally {
    net.restore();
  }
});

test("expiration des données du Durable Object", async () => {
  const store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
  await store.put("pause", "transfert", -1);
  assert.equal(await store.get("pause"), null);
  await store.put("history", [1, 2]);
  assert.deepEqual(await store.get("history"), [1, 2]);
});

// Ouverture au public : OWNER_ONLY à "false" (NEW_ONLY est vérifié dans guards.test.ts).
const publicEnv = { ...env, MESSENGER_OWNER_ONLY: "false" } as unknown as Env;
const CLIENT = "777000111";
const clientMsg = (mid: string, text: string) => ({ sender: { id: CLIENT }, recipient: { id: "page" }, timestamp: Date.now(), message: { mid, text } });
const pageEcho = (mid: string, text: string, metadata?: string) => ({
  sender: { id: "page" },
  recipient: { id: CLIENT },
  timestamp: Date.now(),
  message: { mid, text, is_echo: true, ...(metadata ? { metadata } : {}) },
});

test("ouvert au public : un client parle au bot, mais #reset n'est pas une commande pour lui", async () => {
  const net = stubNetwork();
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(clientMsg("c1", "je veux une 40 kW"), publicEnv, store);
    await store.put("lead", { psid: CLIENT });
    await handleEvent(clientMsg("c2", "#reset"), publicEnv, store);
    assert.equal(net.claudeRequests.length, 2); // #reset traité comme un message ordinaire
    assert.deepEqual(await store.get("lead"), { psid: CLIENT }); // rien n'est effacé
  } finally {
    net.restore();
  }
});

test("message d'accueil de la pub : pas de pause ; réponse d'un humain : pause du bot", async () => {
  const net = stubNetwork();
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(pageEcho("e1", AD_GREETING), publicEnv, store);
    await handleEvent(pageEcho("e2", "Réponse du bot", BOT_METADATA), publicEnv, store);
    assert.equal(await store.get("pause"), null);
    await handleEvent(clientMsg("c1", "je veux une 40 kW"), publicEnv, store);
    assert.equal(net.claudeRequests.length, 1);

    await handleEvent(pageEcho("e3", "Bonjour, ici Frederic de Solution NRJ"), publicEnv, store);
    assert.equal(await store.get("pause"), "humain");
    await handleEvent(clientMsg("c2", "merci"), publicEnv, store);
    assert.equal(net.claudeRequests.length, 1); // le bot se tait
  } finally {
    net.restore();
  }
});
