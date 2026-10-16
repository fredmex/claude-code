// Essai « à la ManyChat » : réponses rapides, carrousel de modèles et questions
// d'accueil. Tout passe par l'interrupteur MESSENGER_RICH="true" ; à "false",
// le bot redevient purement texte (les balises sont retirées dans tous les cas).
//
// Claude ne construit pas les boutons : il ajoute une balise en fin de réponse,
// et le Worker la remplace par les vrais éléments Messenger.
//   [[boutons:puissance]]   [[boutons:budget]]   [[carrousel:perkins-30,perkins-40]]

import { findModel, type Model } from "./catalogue.ts";

export interface QuickReply {
  content_type: "text";
  title: string;
  payload: string;
}

export interface CarouselElement {
  title: string;
  subtitle: string;
  image_url?: string;
  buttons: ({ type: "postback"; title: string; payload: string } | { type: "web_url"; title: string; url: string })[];
}

export interface RichReply {
  text: string;
  quickReplies: QuickReply[];
  models: Model[];
}

export function richEnabled(env: { MESSENGER_RICH?: string }): boolean {
  return env.MESSENGER_RICH === "true";
}

const reply = (title: string): QuickReply => ({ content_type: "text", title, payload: `QR:${title}` });

/** Le titre d'un bouton arrive comme un message du client : le texte libre reste accepté. */
export const QUICK_REPLIES: Record<string, QuickReply[]> = {
  puissance: ["15-20 kW", "30 kW", "40 kW", "50-60 kW", "Je ne sais pas"].map(reply),
  budget: ["Ce budget me va", "Voir la FAQ"].map(reply),
};

const MARKER = /\[\[\s*([a-zàé]+)\s*:\s*([^\]]*)\]\]/gi;
const MAX_CARDS = 10; // limite de Messenger

/** Retire les balises du texte et en tire les boutons et les modèles à montrer. */
export function parseRich(raw: string): RichReply {
  let quickReplies: QuickReply[] = [];
  const models: Model[] = [];
  for (const [, kind, value] of raw.matchAll(MARKER)) {
    if (kind.toLowerCase() === "boutons" && QUICK_REPLIES[value.trim()]) {
      quickReplies = QUICK_REPLIES[value.trim()];
    } else if (kind.toLowerCase() === "carrousel") {
      for (const key of value.split(",").map((k) => k.trim())) {
        const model = findModel(key);
        // Seulement un modèle avec un prix connu, une seule fois.
        if (model && model.priceCad !== null && !models.includes(model) && models.length < MAX_CARDS) models.push(model);
      }
    }
  }
  const text = raw.replace(MARKER, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, quickReplies, models };
}

export const cardTitle = (model: Model) =>
  `${model.brand} ${model.powerKw} kW${model.enclosure === "ouvert" ? " (ouverte)" : ""}`;

export function carouselElements(models: Model[]): CarouselElement[] {
  return models.map((model) => ({
    title: cardTitle(model),
    subtitle: `${model.priceCad!.toLocaleString("fr-CA")} $ avant taxes`,
    ...(model.imageUrl ? { image_url: model.imageUrl } : {}),
    buttons: [
      { type: "postback", title: "Recevoir la fiche", payload: `FICHE:${model.key}` },
      { type: "web_url", title: "Voir sur le site", url: model.url },
    ],
  }));
}

/** Texte remis à Claude pour un postback (bouton de carte, question d'accueil, « Démarrer »). */
export function postbackText(postback: { title: string; payload: string }): string {
  if (postback.payload === "GET_STARTED") return "Bonjour";
  const fiche = /^FICHE:(.+)$/.exec(postback.payload);
  const model = fiche ? findModel(fiche[1]) : undefined;
  if (model) return `Je voudrais recevoir la fiche de la ${cardTitle(model)}.`;
  return postback.title;
}

/** Ce que l'historique retient des cartes montrées, pour que Claude s'en souvienne. */
export function historyNote(models: Model[]): string | null {
  return models.length ? `[Cartes montrées : ${models.map(cardTitle).join(", ")}]` : null;
}

export const RICH_PROMPT = `
# Boutons et cartes Messenger
Tu peux ajouter, à la toute fin de ta réponse et sur une ligne à part, UNE balise que le système remplace par des boutons ou des cartes. Ton texte doit rester complet sans elle ; ne parle pas des boutons.
- [[boutons:puissance]] : quand tu demandes quelle puissance le client veut (puissance encore inconnue). Boutons : 15-20 kW, 30 kW, 40 kW, 50-60 kW, Je ne sais pas.
- [[boutons:budget]] : après les repères pour une maison (client indécis), quand tu demandes si le budget lui convient. Boutons : « Ce budget me va », « Voir la FAQ ».
- [[carrousel:clé1,clé2]] : quand tu présentes un ou plusieurs modèles précis avec leur prix (clés du catalogue entre crochets, 3 au plus, seulement des modèles avec un prix). Chaque carte montre le modèle, le prix avant taxes, un bouton « Recevoir la fiche » et un lien vers sa page.
Le client peut répondre par un bouton ou par écrit : un bouton arrive comme un message du client. « Je voudrais recevoir la fiche de la Perkins XX kW » vient d'une carte : demande seulement son courriel (ou appelle email_spec_sheet si tu l'as déjà). « Voir la FAQ » : donne le lien de la FAQ maison.
N'ajoute aucune balise après l'envoi d'une fiche ou d'une soumission.`;

// Questions d'accueil (ice breakers) : un réglage de la Page, visible par TOUS les
// visiteurs. Jamais appliqué au déploiement : Frederic les active lui-même avec
// la route /admin/ice-breakers (POST pour activer, DELETE pour retirer).
export const ICE_BREAKERS = [
  "Quels sont vos prix?",
  "Quelle puissance pour ma maison?",
  "Avez-vous de l'inventaire?",
  "Parler à quelqu'un",
];

const PROFILE_API = "https://graph.facebook.com/v21.0/me/messenger_profile";

export function iceBreakersBody() {
  return {
    ice_breakers: [{ locale: "default", call_to_actions: ICE_BREAKERS.map((question, i) => ({ question, payload: `ICE_${i + 1}` })) }],
  };
}

export async function setIceBreakers(token: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(PROFILE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(iceBreakersBody()),
  });
}

export async function removeIceBreakers(token: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(PROFILE_API, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: ["ice_breakers"] }),
  });
}
