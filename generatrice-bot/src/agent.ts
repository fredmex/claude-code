// La conversation avec Claude : un tour de parole du client → une réponse,
// avec les outils pour enregistrer le prospect et transférer à un humain.

import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt } from "./business.ts";
import { emptyLead, mergeLead, missingFields, normalizePhone, type Lead, type LeadUpdate } from "./leads.ts";

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
  // Pour les tests : remplace l'appel réseau à l'API Claude.
  fetch?: typeof fetch;
}

export interface AgentResult {
  reply: string;
  lead: Lead | null;
  // Vrai si cette réponse a rendu la fiche complète (téléphone ou courriel obtenu).
  leadQualified: boolean;
  transferReason: string | null;
}

const MAX_TOOL_ROUNDS = 5;

const REFUSAL_REPLY =
  "Désolé, je ne peux pas répondre à ça. Je peux vous mettre en contact avec un membre de l'équipe si vous le souhaitez.";

const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "save_lead",
    description:
      "Enregistre ce que tu sais du besoin du client dans sa fiche prospect. Appelle-le dès que tu apprends une nouvelle information (usage, puissance, ville, tension, boîtier, nom, téléphone…). Mets null pour ce que tu ne sais pas : les valeurs déjà enregistrées sont conservées. Le résultat indique la fiche à jour et ce qu'il manque.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: nullable("string", "Nom du client."),
        company: nullable("string", "Entreprise du client, s'il y a lieu."),
        usage: nullable("string", "Usage prévu, en quelques mots : secours maison, chalet, ferme, chantier, commerce, industriel, hors réseau…"),
        power_kw: nullable("number", "Puissance souhaitée ou estimée, en kW."),
        city: nullable("string", "Ville ou région d'installation."),
        voltage: nullable("string", "Tension et phases, ex. « 120/240 V monophasé », « 600 V triphasé »."),
        enclosure: nullable("string", "« fermé insonorisé » ou « ouvert »."),
        phone: nullable("string", "Numéro de téléphone donné par le client, tel quel."),
        email: nullable("string", "Courriel, si le client préfère être joint ainsi."),
        notes: nullable("string", "Autres détails utiles pour le conseiller : modèle qui l'intéresse, équipements à alimenter, autonomie souhaitée, secours ou principal, échéance…"),
      },
      required: ["name", "company", "usage", "power_kw", "city", "voltage", "enclosure", "phone", "email", "notes"],
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

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: input.apiKey, fetch: input.fetch });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...input.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: "user", content: input.userContent },
  ];

  let lead = input.lead;
  const hadContact = Boolean(lead?.phone || lead?.email);
  let transferReason: string | null = null;
  const replyParts: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: input.model,
      max_tokens: 2048,
      system: systemPrompt(),
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
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((toolUse) => {
      if (toolUse.name === "save_lead") {
        const update = toolUse.input as LeadUpdate;
        if (update.phone) {
          const phone = normalizePhone(update.phone);
          if (!phone) {
            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              is_error: true,
              content: `« ${update.phone} » ne ressemble pas à un numéro de téléphone. Les autres informations n'ont pas été enregistrées : redemande poliment le numéro au client, puis rappelle save_lead.`,
            };
          }
          update.phone = phone;
        }
        lead = mergeLead(lead ?? emptyLead(input.psid, input.now), update, input.now);
        const missing = missingFields(lead);
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            saved: true,
            lead: { name: lead.name, company: lead.company, usage: lead.usage, power_kw: lead.power_kw, city: lead.city, voltage: lead.voltage, enclosure: lead.enclosure, phone: lead.phone, email: lead.email },
            missing,
          }),
        };
      }
      if (toolUse.name === "transfer_to_human") {
        transferReason = (toolUse.input as { reason: string }).reason;
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Transfert fait : l'équipe est prévenue et le bot est en pause. Dis au client qu'un membre de l'équipe va lui répondre ici, sans lui poser d'autre question.",
        };
      }
      return { type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `Outil inconnu : ${toolUse.name}` };
    });
    messages.push({ role: "user", content: results });
  }

  const reply = replyParts.join("\n\n").trim();
  return {
    reply: reply || "Un instant, je vérifie ça avec l'équipe.",
    lead,
    leadQualified: !hadContact && Boolean(lead?.phone || lead?.email),
    transferReason,
  };
}
