// Demandes Messenger pour Dolibarr : une ligne par fiche ou soumission envoyée, en
// ajout seulement, dans la table messenger_leads de la D1 « solution-nrj-contacts ».
// L'ordinateur de Solution NRJ relit cette table chaque heure et crée le prospect
// et la relance dans Dolibarr (CRM local, à la place de HubSpot).

import type { Model } from "./catalogue.ts";

export interface LeadsEnv {
  /** Liaison D1 vers « solution-nrj-contacts » (table messenger_leads). */
  LEADS_DB?: D1Database;
}

export interface MessengerLeadRow {
  event: "fiche" | "soumission";
  psid: string;
  fullName: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  address: string | null;
  model: Model;
  /** Numéro S-AAAA-NNNN de la soumission ; null pour une fiche. */
  quoteRef: string | null;
  /** Tension, quantité, usage… en texte libre. */
  details: string | null;
}

/** Ajoute la demande dans messenger_leads. Renvoie false si la liaison D1 manque. */
export async function recordMessengerLead(env: LeadsEnv, row: MessengerLeadRow, now: string): Promise<boolean> {
  if (!env.LEADS_DB) return false;
  const m = row.model;
  await env.LEADS_DB.prepare(
    `INSERT INTO messenger_leads
      (created_at, event, psid, full_name, email, phone, company, address, power_kw, model_key, model_label, price_ht, quote_ref, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now,
      row.event,
      row.psid,
      row.fullName || null,
      row.email,
      row.phone || null,
      row.company || null,
      row.address || null,
      m.powerKw,
      m.key,
      m.name,
      m.priceCad,
      row.quoteRef,
      row.details || null,
    )
    .run();
  return true;
}
