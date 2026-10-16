// La conversation avec Claude : un tour de parole du client → une réponse,
// avec les outils pour enregistrer le prospect, envoyer fiche et soumission,
// et transférer à un humain.

import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt } from "./business.ts";
import { findModel, MODEL_KEYS, QUOTABLE_KEYS } from "./catalogue.ts";
import { emptyLead, mergeLead, missingFields, normalizePhone, type Lead, type LeadUpdate } from "./leads.ts";
import { descriptionRows, formatMoney } from "./quote-pdf.ts";
import { isEmail, quoteSendingEnabled, recordSpecSheetContact, sendOfficialQuote, sendSpecSheet, type QuoteEnv, type QuoteResult } from "./quote-service.ts";

/** Historique conservé entre deux messages : uniquement le texte échangé. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface AgentInput {
  apiKey: string;
  model: string;
  history: Turn[];
  userContent: Anthropic.Beta.BetaContentBlockParam[];
  lead: Lead | null;
  psid: string;
  now: string;
  quoteEnv?: QuoteEnv;
  // Essai : boutons et cartes Messenger (MESSENGER_RICH).
  rich?: boolean;
  // Pour les tests : remplace les appels réseau (Claude, registre, Resend).
  fetch?: typeof fetch;
}

export interface AgentResult {
  reply: string;
  lead: Lead | null;
  // Vrai si cette réponse a rendu la fiche complète (téléphone ou courriel obtenu).
  leadQualified: boolean;
  transferReason: string | null;
  quote: (QuoteResult & { modelName: string; email: string }) | null;
}

const MAX_TOOL_ROUNDS = 6;

const REFUSAL_REPLY =
  "Désolé, je ne peux pas répondre à ça. Voulez-vous qu'un membre de notre équipe vous contacte directement?";

const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

// L'API refuse plus de 16 champs « type: [x, null] » (unions) au total dans les outils
// stricts : seuls ceux de save_lead en utilisent ; ailleurs, chaîne vide = inconnu.
export const MAX_UNION_PARAMS = 16;
const optionalText = (description: string) => ({ type: "string", description: `${description} Chaîne vide si inconnu.` });

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "save_lead",
    description:
      "Enregistre ce que tu sais du besoin du client dans sa fiche prospect. Appelle-le dès que tu apprends une nouvelle information (usage, puissance, nom, entreprise, courriel, téléphone…). Mets null pour ce que tu ne sais pas : les valeurs déjà enregistrées sont conservées. Le résultat indique la fiche à jour et ce qu'il manque.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: nullable("string", "Nom du client."),
        company: nullable("string", "Entreprise du client, s'il y a lieu."),
        usage: nullable("string", "Usage prévu, en quelques mots : secours maison, chalet, ferme, chantier, commerce, industriel, hors réseau…"),
        power_kw: nullable("number", "Puissance souhaitée ou estimée, en kW."),
        city: nullable("string", "Ville, seulement si le client l'a donnée de lui-même (ne la demande jamais)."),
        voltage: nullable("string", "Tension et phases, ex. « 120/240 V monophasé », « 600 V triphasé »."),
        enclosure: nullable("string", "« fermé insonorisé » ou « ouvert »."),
        phone: nullable("string", "Numéro de téléphone donné par le client, tel quel."),
        email: nullable("string", "Courriel du client."),
        notes: nullable("string", "Autres détails utiles pour le conseiller : modèle qui l'intéresse, équipements à alimenter, autonomie souhaitée, secours ou principal, échéance…"),
      },
      required: ["name", "company", "usage", "power_kw", "city", "voltage", "enclosure", "phone", "email", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "send_quote",
    description:
      `Génère la soumission officielle en PDF (numéro S-AAAA-NNNN), l'inscrit dans HubSpot et l'envoie par courriel au client, avec copie à l'équipe. À appeler UNIQUEMENT après avoir récapitulé la soumission au client et obtenu son accord explicite. Modèles permis : ${QUOTABLE_KEYS.join(", ")}.`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        model_key: { type: "string", enum: QUOTABLE_KEYS, description: "Clé du modèle, entre crochets dans le catalogue." },
        full_name: { type: "string", description: "Nom complet du client." },
        company: optionalText("Nom de l'entreprise si la soumission est au nom d'une entreprise ; vide si elle est à titre personnel."),
        email: { type: "string", description: "Courriel où envoyer la soumission, confirmé par le client." },
        phone: optionalText("Téléphone du client."),
        address: optionalText("Adresse si le client l'a donnée, même incomplète."),
        voltage: optionalText("Tension demandée par le client, ex. « 600 V » ; vide pour celle du catalogue."),
        quantity: { type: "integer", description: "Nombre d'unités : 1, sauf si le client a lui-même demandé plusieurs unités. Ne pose jamais la question." },
        client_confirmed: { type: "boolean", description: "true seulement si le client vient de confirmer explicitement le récapitulatif." },
      },
      required: ["model_key", "full_name", "company", "email", "phone", "address", "voltage", "quantity", "client_confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "email_spec_sheet",
    description: "Envoie par courriel la fiche détaillée d'un modèle (caractéristiques, prix avant taxes, lien photos) et enregistre le contact dans HubSpot. Aucun numéro de soumission.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        model_key: { type: "string", enum: MODEL_KEYS, description: "Clé du modèle." },
        email: { type: "string", description: "Courriel du client." },
        name: optionalText("Nom du client."),
        company: optionalText("Entreprise du client, s'il y a lieu."),
        phone: optionalText("Téléphone du client."),
      },
      required: ["model_key", "email", "name", "company", "phone"],
      additionalProperties: false,
    },
  },
  {
    name: "transfer_to_human",
    description:
      "Transfère la conversation à un membre de l'équipe et met le bot en pause pour ce client. À utiliser quand le client demande à parler à une personne, est mécontent, ou a une demande que tu ne peux pas traiter.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Pourquoi le client est transféré, en une phrase, pour l'équipe." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

interface ToolState {
  lead: Lead | null;
  transferReason: string | null;
  quote: AgentResult["quote"];
}

type ToolOutcome = { content: string; isError?: boolean };

async function runTool(toolUse: Anthropic.Beta.BetaToolUseBlock, input: AgentInput, state: ToolState): Promise<ToolOutcome> {
  const args = toolUse.input as Record<string, unknown>;
  const quoteEnv = input.quoteEnv;
  const doFetch = input.fetch ?? fetch;

  switch (toolUse.name) {
    case "save_lead": {
      const update = args as LeadUpdate;
      if (update.phone) {
        const phone = normalizePhone(update.phone);
        if (!phone) {
          return {
            isError: true,
            content: `« ${update.phone} » ne ressemble pas à un numéro de téléphone. Rien n'a été enregistré : redemande poliment le numéro, puis rappelle save_lead.`,
          };
        }
        update.phone = phone;
      }
      if (update.email && !isEmail(update.email)) {
        return { isError: true, content: `« ${update.email} » n'est pas un courriel valide. Rien n'a été enregistré : redemande-le.` };
      }
      state.lead = mergeLead(state.lead ?? emptyLead(input.psid, input.now), update, input.now);
      const l = state.lead;
      return {
        content: JSON.stringify({
          saved: true,
          lead: { name: l.name, company: l.company, usage: l.usage, power_kw: l.power_kw, city: l.city, voltage: l.voltage, enclosure: l.enclosure, phone: l.phone, email: l.email },
          missing: missingFields(l),
        }),
      };
    }

    case "send_quote": {
      const model = findModel(String(args.model_key));
      if (!model) return { isError: true, content: "Modèle inconnu." };
      if (args.client_confirmed !== true) {
        return { isError: true, content: "Le client n'a pas confirmé. Récapitule la soumission et attends son accord explicite avant de rappeler send_quote." };
      }
      if (model.priceCad === null || !model.quotable) {
        return { isError: true, content: "Pas de soumission automatique pour ce modèle. Enregistre le client avec save_lead et dis-lui qu'un conseiller lui prépare la soumission." };
      }
      const email = String(args.email).trim().toLowerCase();
      const fullName = String(args.full_name).trim();
      if (!isEmail(email) || !fullName) return { isError: true, content: "Nom complet ou courriel invalide : redemande-les au client." };
      const address = typeof args.address === "string" && args.address.trim() ? args.address.trim() : null;
      const quantity = Math.max(1, Math.min(20, Math.floor(Number(args.quantity) || 1)));
      const phone = typeof args.phone === "string" ? normalizePhone(args.phone) : null;
      state.lead = mergeLead(state.lead ?? emptyLead(input.psid, input.now), { name: fullName, email, phone, company: (args.company as string) || null }, input.now);

      if (!quoteEnv || !quoteSendingEnabled(quoteEnv)) {
        state.lead = { ...state.lead, notes: [state.lead.notes, `Soumission demandée : ${model.name} × ${quantity} (envoi automatique désactivé)`].filter(Boolean).join(" — ") };
        return {
          isError: true,
          content: "L'envoi automatique des soumissions n'est pas activé. Dis au client qu'un conseiller lui envoie la soumission officielle par courriel dès que possible (lundi au vendredi, 9 h à 16 h). Ses coordonnées sont enregistrées.",
        };
      }
      try {
        const result = await sendOfficialQuote(
          quoteEnv,
          {
            psid: input.psid,
            model,
            quantity,
            voltage: typeof args.voltage === "string" && args.voltage.trim() ? args.voltage.trim() : null,
            issuedOn: input.now.slice(0, 10),
            client: {
              fullName,
              company: (args.company as string | null) || null,
              email,
              phone,
              address,
            },
          },
          doFetch,
        );
        state.quote = { ...result, modelName: model.name, email };
        state.lead = { ...state.lead, notes: [state.lead.notes, `Soumission ${result.number} envoyée (${model.name} × ${quantity})`].filter(Boolean).join(" — ") };
        return {
          content: JSON.stringify({
            sent: true,
            number: result.number,
            total_taxes_incluses: formatMoney(result.total),
            depot_requis: formatMoney(result.deposit),
            email,
            note: "Le courriel est accepté par le service d'envoi ; sa réception n'est pas garantie (indésirables).",
          }),
        };
      } catch (error) {
        console.error("send_quote", error);
        const reason = error instanceof Error ? error.message.slice(0, 80) : "inconnue";
        state.lead = { ...state.lead, notes: [state.lead.notes, `Échec d'envoi automatique de soumission (${model.name}) : ${reason}`].filter(Boolean).join(" — ") };
        state.transferReason = `Envoi automatique de la soumission ${model.name} échoué (${reason}) : à envoyer par l'équipe`;
        return {
          isError: true,
          content: "L'envoi a échoué pour une raison technique. Ne réessaie pas. Dis au client qu'un conseiller lui envoie la soumission officielle par courriel rapidement et lui répond ici ; ses coordonnées sont enregistrées.",
        };
      }
    }

    case "email_spec_sheet": {
      const model = findModel(String(args.model_key));
      if (!model) return { isError: true, content: "Modèle inconnu." };
      const email = String(args.email).trim().toLowerCase();
      if (!isEmail(email)) return { isError: true, content: "Courriel invalide : redemande-le." };
      const specPhone = typeof args.phone === "string" ? normalizePhone(args.phone) : null;
      state.lead = mergeLead(state.lead ?? emptyLead(input.psid, input.now), { email, name: (args.name as string) || null, company: (args.company as string) || null, phone: specPhone }, input.now);
      if (!quoteEnv?.RESEND_API_KEY || quoteEnv.QUOTATION_EMAIL_ENABLED !== "true") {
        return { isError: true, content: `L'envoi de courriels n'est pas activé. Donne plutôt au client le lien de la fiche : ${model.url}` };
      }
      try {
        await sendSpecSheet(quoteEnv, { psid: input.psid, model, email, name: (args.name as string) || null, rows: descriptionRows(model, null) }, doFetch);
        // Contact HubSpot : une erreur ici n'empêche pas l'envoi déjà fait.
        await recordSpecSheetContact(quoteEnv, { model, email, name: (args.name as string) || null, company: (args.company as string | null) || null, phone: specPhone }, doFetch).catch((error) =>
          console.error("hubspot_fiche", error),
        );
        return { content: JSON.stringify({ sent: true, email }) };
      } catch (error) {
        console.error("email_spec_sheet", error);
        return { isError: true, content: `L'envoi a échoué. Donne au client le lien de la fiche : ${model.url}` };
      }
    }

    case "transfer_to_human":
      state.transferReason = String(args.reason);
      return {
        content: "Transfert fait : l'équipe est prévenue et le bot est en pause. Dis au client qu'un membre de l'équipe va lui répondre ici.",
      };

    default:
      return { isError: true, content: `Outil inconnu : ${toolUse.name}` };
  }
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: input.apiKey, fetch: input.fetch });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...input.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: "user", content: input.userContent },
  ];

  const state: ToolState = { lead: input.lead, transferReason: null, quote: null };
  const hadContact = Boolean(input.lead?.phone || input.lead?.email);
  const replyParts: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: input.model,
      max_tokens: 2048,
      system: systemPrompt(input.rich),
      tools: TOOLS,
      // Une conversation de vente reste simple : l'effort « low » répond plus vite.
      output_config: { effort: "low" },
      // Si un filtre de sécurité refuse la demande, l'API la relance sur un modèle de repli.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });

    if (response.stop_reason === "refusal") {
      replyParts.push(REFUSAL_REPLY);
      break;
    }

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) replyParts.push(block.text.trim());
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // On renvoie la réponse telle quelle (blocs de réflexion compris), puis tous les résultats d'outils.
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const outcome = await runTool(toolUse, input, state);
      results.push({ type: "tool_result", tool_use_id: toolUse.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }

  const reply = replyParts.join("\n\n").trim();
  return {
    reply: reply || "Je vérifie ça avec notre équipe technique. Quelle puissance ou quels équipements voulez-vous alimenter?",
    lead: state.lead,
    leadQualified: !hadContact && Boolean(state.lead?.phone || state.lead?.email),
    transferReason: state.transferReason,
    quote: state.quote,
  };
}
