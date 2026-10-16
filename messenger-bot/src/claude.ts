import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt } from "./business";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

const FALLBACK_REPLY =
  "Désolé, je ne peux pas répondre à cette demande. Écrivez « humain » pour parler à un membre de l'équipe.";

export async function generateReply(apiKey: string, model: string, history: Turn[]): Promise<string> {
  const client = new Anthropic({ apiKey });

  const response = await client.beta.messages.create({
    model,
    max_tokens: 2048,
    system: systemPrompt(),
    // Les réponses de service client sont simples : un effort « low » suffit et répond plus vite.
    output_config: { effort: "low" },
    // Si un filtre de sécurité refuse la demande, l'API la relance sur un modèle de repli.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: history.map((turn) => ({ role: turn.role, content: turn.text })),
  });

  if (response.stop_reason === "refusal") return FALLBACK_REPLY;

  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return text || FALLBACK_REPLY;
}
