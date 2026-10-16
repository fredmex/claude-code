// Garde-fous repris du service Messenger précédent : qui le bot a le droit
// de servir, et quand il doit se taire.

export interface GuardEnv {
  /** "true" pour que le bot réponde ; tout autre valeur = bot muet (interrupteur général). */
  MESSENGER_ENABLED?: string;
  /** "true" : ne répondre qu'aux nouveaux clients (voir MESSENGER_EXISTING_BASELINE). */
  MESSENGER_NEW_ONLY?: string;
  /** JSON { complete, pageId, capturedAtUTC, excludedPsids[] } : clients existants à laisser à l'équipe. */
  MESSENGER_EXISTING_BASELINE?: string;
  /** Date ISO d'activation : seuls les messages reçus après comptent. */
  MESSENGER_ACTIVATED_AT?: string;
  /** "true" : le bot ne répond qu'à MESSENGER_OWNER_TEST_PSID (phase de test). */
  MESSENGER_OWNER_ONLY?: string;
  /** PSID de Frederic : toujours servi, pour tester le bot. */
  MESSENGER_OWNER_TEST_PSID?: string;
  META_PAGE_ID?: string;
}

/** Message d'accueil des publicités « Clic vers Messenger » : envoyé par Meta, pas par un humain. */
export const AD_GREETING =
  "Bonjour! Bienvenue chez Solution NRJ. Quelle puissance de génératrice recherchez-vous, en kW? Si vous ne le savez pas, décrivez votre projet.";

/** Messenger n'autorise une réponse que dans les 24 h suivant le dernier message du client. */
export const RESPONSE_WINDOW_MS = 23 * 3600 * 1000;
export const DAILY_REPLY_LIMIT = 30;

export function stopRequested(text: string): boolean {
  return /\b(non merci|ne me (contactez|contacte|recontactez|recontacte)(z)? plus|ne plus me contacter|arr[eê]tez de|d[eé]sabonn\w*|unsubscribe|stop|no thanks|do not contact|don't contact)\b/i.test(
    text,
  );
}

export type GateResult = { allowed: true; reason?: string } | { allowed: false; reason: string };

/** Le bot peut-il répondre à ce client ? */
export function customerGate(env: GuardEnv, psid: string, timestamp: number, now = Date.now()): GateResult {
  if (env.MESSENGER_ENABLED !== "true") return { allowed: false, reason: "disabled" };
  if (!Number.isFinite(timestamp) || timestamp > now + 60_000 || now - timestamp > RESPONSE_WINDOW_MS) {
    return { allowed: false, reason: "outside_response_window" };
  }
  if (env.MESSENGER_OWNER_TEST_PSID && psid === env.MESSENGER_OWNER_TEST_PSID) return { allowed: true, reason: "owner_test" };
  if (env.MESSENGER_OWNER_ONLY === "true") return { allowed: false, reason: "owner_only_test_phase" };
  if (env.MESSENGER_NEW_ONLY !== "true") return { allowed: true };

  let baseline: { complete?: boolean; pageId?: string; capturedAtUTC?: string; excludedPsids?: unknown };
  try {
    baseline = JSON.parse(env.MESSENGER_EXISTING_BASELINE || "");
  } catch {
    return { allowed: false, reason: "baseline_missing" };
  }
  const cutoff = Date.parse(env.MESSENGER_ACTIVATED_AT || "");
  const captured = Date.parse(baseline.capturedAtUTC || "");
  if (
    baseline.complete !== true ||
    String(baseline.pageId) !== String(env.META_PAGE_ID) ||
    !Array.isArray(baseline.excludedPsids) ||
    !Number.isFinite(cutoff) ||
    !Number.isFinite(captured) ||
    captured > cutoff ||
    cutoff - captured > 60_000
  ) {
    return { allowed: false, reason: "baseline_invalid" };
  }
  if (baseline.excludedPsids.map(String).includes(psid)) return { allowed: false, reason: "existing_customer" };
  if (timestamp < cutoff) return { allowed: false, reason: "before_activation" };
  return { allowed: true };
}
