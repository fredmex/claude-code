import { test } from "node:test";
import assert from "node:assert/strict";
import { DurableStore, handleEvent, type Env, type Store } from "../src/index.ts";
import { carouselElements, iceBreakersBody, parseRich, postbackText, QUICK_REPLIES } from "../src/rich.ts";
import { findModel } from "../src/catalogue.ts";
import { systemPrompt } from "../src/business.ts";

test("parseRich retire les balises et en tire les boutons", () => {
  const r = parseRich("Quelle puissance vous faut-il?\n[[boutons:puissance]]");
  assert.equal(r.text, "Quelle puissance vous faut-il?");
  assert.deepEqual(r.quickReplies.map((q) => q.title), ["15-20 kW", "30 kW", "40 kW", "50-60 kW", "Je ne sais pas"]);
  assert.deepEqual(parseRich("Ce budget vous convient-il? [[boutons:budget]]").quickReplies.map((q) => q.title), ["Ce budget me va", "Voir la FAQ"]);
  // Titres de 20 caractères au plus (limite de Messenger).
  for (const q of Object.values(QUICK_REPLIES).flat()) assert.ok(q.title.length <= 20, q.title);
  // Balise inconnue : retirée, sans bouton.
  const unknown = parseRich("Bonjour [[boutons:rien]]");
  assert.equal(unknown.text, "Bonjour");
  assert.deepEqual(unknown.quickReplies, []);
});

test("parseRich ne garde que des modèles du catalogue avec un prix, sans doublon", () => {
  const r = parseRich("Voici deux options.\n[[carrousel:perkins-30, perkins-40, perkins-40, inventé-99, perkins-200]]");
  assert.equal(r.text, "Voici deux options.");
  assert.deepEqual(r.models.map((m) => m.key), ["perkins-30", "perkins-40"]);
});

test("carte du carrousel : modèle, prix, fiche en postback et lien réel du site", () => {
  const [card] = carouselElements([findModel("perkins-40")!]);
  assert.equal(card.title, "Perkins 40 kW");
  assert.equal(card.subtitle.replace(/\s/g, " "), "29 000 $ avant taxes");
  assert.deepEqual(card.buttons, [
    { type: "postback", title: "Recevoir la fiche", payload: "FICHE:perkins-40" },
    { type: "web_url", title: "Voir sur le site", url: "https://generatricediesel.com/product/generatrice-diesel-40kw/" },
  ]);
  // Pas d'URL de photo inventée : sans photo connue, la carte n'en a pas.
  assert.equal("image_url" in card, false);
});

test("postbackText : bouton de carte, démarrer et questions d'accueil", () => {
  assert.equal(postbackText({ title: "Recevoir la fiche", payload: "FICHE:perkins-40" }), "Je voudrais recevoir la fiche de la Perkins 40 kW.");
  assert.equal(postbackText({ title: "Démarrer", payload: "GET_STARTED" }), "Bonjour");
  assert.equal(postbackText({ title: "Quels sont vos prix?", payload: "ICE_1" }), "Quels sont vos prix?");
  assert.equal(postbackText({ title: "Recevoir la fiche", payload: "FICHE:inconnu" }), "Recevoir la fiche");
});

test("questions d'accueil : 4 questions, format de l'API Messenger Profile", () => {
  const body = iceBreakersBody();
  assert.equal(body.ice_breakers[0].locale, "default");
  assert.deepEqual(body.ice_breakers[0].call_to_actions.map((c) => c.question), ["Quels sont vos prix?", "Quelle puissance pour ma maison?", "Avez-vous de l'inventaire?", "Parler à quelqu'un"]);
});

test("la section des boutons n'est dans le prompt que si l'essai est activé", () => {
  assert.doesNotMatch(systemPrompt(), /\[\[boutons:puissance\]\]/);
  assert.match(systemPrompt(true), /\[\[boutons:puissance\]\]/);
  assert.match(systemPrompt(true), /\[\[carrousel:/);
});

// --- Parcours complet dans handleEvent ---

function fakeStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return map.get(key) as T | undefined; },
    async put(key: string, value: unknown) { map.set(key, structuredClone(value)); },
    async delete(key: string) { return map.delete(key); },
  };
}

const OWNER = "1234569082";
const baseEnv = {
  MESSENGER_ENABLED: "true",
  MESSENGER_OWNER_ONLY: "true",
  MESSENGER_OWNER_TEST_PSID: OWNER,
  ANTHROPIC_API_KEY: "test",
  CLAUDE_MODEL: "claude-opus-5-5",
  META_PAGE_ACCESS_TOKEN: "t",
  HUMAN_PAUSE_HOURS: "24",
  QUOTE_REGISTER_URL: "https://registre.test",
  BOT_STATE: { put: async () => {}, get: async () => null },
};

/** Claude répond `reply` ; on garde ses requêtes et les messages envoyés à Messenger. */
function stubNetwork(reply: string) {
  const claude: any[] = [];
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("anthropic")) {
      claude.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: reply }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    const body = JSON.parse(String(init?.body));
    if (body.message) sent.push(body.message);
    return Response.json({ message_id: "x" });
  }) as typeof fetch;
  return { claude, sent, restore: () => (globalThis.fetch = original) };
}

const msg = (mid: string, text: string, quickReply?: string) => ({
  sender: { id: OWNER }, recipient: { id: "page" }, timestamp: Date.now(),
  message: { mid, text, ...(quickReply ? { quick_reply: { payload: quickReply } } : {}) },
});

test("essai activé : réponses rapides sur le message, balise invisible au client", async () => {
  const net = stubNetwork("Quelle puissance vous faut-il?\n[[boutons:puissance]]");
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m1", "Bonjour"), { ...baseEnv, MESSENGER_RICH: "true" } as unknown as Env, store);
    assert.equal(net.sent.length, 1);
    assert.equal(net.sent[0].text, "Quelle puissance vous faut-il?");
    assert.equal(net.sent[0].quick_replies.length, 5);
    assert.match(net.claude[0].system, /\[\[boutons:puissance\]\]/);
    // Le titre d'un bouton cliqué arrive comme un message du client.
    await handleEvent(msg("m2", "40 kW", "QR:40 kW"), { ...baseEnv, MESSENGER_RICH: "true" } as unknown as Env, store);
    assert.match(JSON.stringify(net.claude[1].messages.at(-1)), /40 kW/);
  } finally {
    net.restore();
  }
});

test("essai activé : carrousel envoyé après le texte, mémorisé dans l'historique", async () => {
  const net = stubNetwork("La Perkins 40 kW est à 29 000 $ avant taxes.\n[[carrousel:perkins-40]]");
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m1", "40 kW"), { ...baseEnv, MESSENGER_RICH: "true" } as unknown as Env, store);
    assert.equal(net.sent.length, 2);
    assert.equal(net.sent[0].text, "La Perkins 40 kW est à 29 000 $ avant taxes.");
    const payload = net.sent[1].attachment.payload;
    assert.equal(payload.template_type, "generic");
    assert.equal(payload.elements[0].buttons[0].payload, "FICHE:perkins-40");
    assert.equal(net.sent[1].metadata, "solution-nrj-ai");
    const history = (await store.get<{ text: string }[]>("history")) ?? [];
    assert.equal(history[1].text, "La Perkins 40 kW est à 29 000 $ avant taxes.\n[Cartes montrées : Perkins 40 kW]");
  } finally {
    net.restore();
  }
});

test("bouton « Recevoir la fiche » : le postback devient une demande de fiche pour Claude", async () => {
  const net = stubNetwork("Avec plaisir! À quel courriel puis-je vous l'envoyer?");
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    const postback = { sender: { id: OWNER }, recipient: { id: "page" }, timestamp: Date.now(), postback: { title: "Recevoir la fiche", payload: "FICHE:perkins-40" } };
    await handleEvent(postback, { ...baseEnv, MESSENGER_RICH: "true" } as unknown as Env, store);
    assert.match(JSON.stringify(net.claude[0].messages.at(-1)), /Je voudrais recevoir la fiche de la Perkins 40 kW/);
  } finally {
    net.restore();
  }
});

test("essai désactivé : texte seul, sans bouton ni carte, balises retirées", async () => {
  const net = stubNetwork("La Perkins 40 kW est à 29 000 $.\n[[carrousel:perkins-40]] [[boutons:puissance]]");
  try {
    const store: Store = new DurableStore(fakeStorage() as unknown as DurableObjectStorage);
    await handleEvent(msg("m1", "40 kW"), { ...baseEnv, MESSENGER_RICH: "false" } as unknown as Env, store);
    assert.deepEqual(net.sent, [{ text: "La Perkins 40 kW est à 29 000 $.", metadata: "solution-nrj-ai" }]);
    assert.doesNotMatch(net.claude[0].system, /\[\[boutons/);
  } finally {
    net.restore();
  }
});
