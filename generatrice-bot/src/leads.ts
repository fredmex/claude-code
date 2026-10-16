// Fiches prospects : enregistrement dans KV, export CSV et notification de l'équipe.

export interface Lead {
  psid: string;
  name: string | null;
  company: string | null;
  usage: string | null;
  power_kw: number | null;
  city: string | null;
  voltage: string | null;
  enclosure: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  transferred: boolean;
  created_at: string;
  updated_at: string;
}

export type LeadUpdate = Partial<Pick<Lead, "name" | "company" | "usage" | "power_kw" | "city" | "voltage" | "enclosure" | "phone" | "email" | "notes">>;

const LEAD_TTL_SECONDS = 60 * 60 * 24 * 365;
const FIELDS = ["name", "company", "usage", "power_kw", "city", "voltage", "enclosure", "phone", "email", "notes"] as const;

export function emptyLead(psid: string, now: string): Lead {
  return {
    psid,
    name: null,
    company: null,
    usage: null,
    power_kw: null,
    city: null,
    voltage: null,
    enclosure: null,
    phone: null,
    email: null,
    notes: null,
    transferred: false,
    created_at: now,
    updated_at: now,
  };
}

/** Garde les valeurs déjà connues quand la mise à jour contient null ou une chaîne vide. */
export function mergeLead(lead: Lead, update: LeadUpdate, now: string): Lead {
  const merged: Lead = { ...lead, updated_at: now };
  for (const field of FIELDS) {
    const value = update[field];
    if (value === null || value === undefined || value === "") continue;
    (merged as unknown as Record<string, unknown>)[field] = typeof value === "string" ? value.trim() : value;
  }
  return merged;
}

/** Normalise un numéro de téléphone ; renvoie null s'il ne ressemble pas à un numéro. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function missingFields(lead: Lead): string[] {
  const missing: string[] = [];
  if (!lead.usage) missing.push("usage");
  if (lead.power_kw === null) missing.push("power_kw");
  if (!lead.phone && !lead.email) missing.push("phone");
  return missing;
}

export async function getLead(kv: KVNamespace, psid: string): Promise<Lead | null> {
  return kv.get<Lead>(`lead:${psid}`, "json");
}

export async function putLead(kv: KVNamespace, lead: Lead): Promise<void> {
  await kv.put(`lead:${lead.psid}`, JSON.stringify(lead), { expirationTtl: LEAD_TTL_SECONDS });
}

export async function listLeads(kv: KVNamespace): Promise<Lead[]> {
  const leads: Lead[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "lead:", cursor });
    const batch = await Promise.all(page.keys.map((key) => kv.get<Lead>(key.name, "json")));
    for (const lead of batch) if (lead) leads.push(lead);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return leads.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function leadsToCsv(leads: Lead[]): string {
  const columns = ["updated_at", "name", "company", "phone", "email", "city", "power_kw", "usage", "voltage", "enclosure", "notes", "transferred", "psid"] as const;
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    // Le préfixe ' empêche Excel d'interpréter une valeur comme une formule.
    const safe = /^[=+\-@]/.test(text) && !/^\+\d+$/.test(text) ? `'${text}` : text;
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = leads.map((lead) => columns.map((column) => escape(lead[column])).join(","));
  // L'indicateur BOM fait ouvrir les accents correctement dans Excel.
  return "﻿" + [columns.join(","), ...lines].join("\n");
}

export function describeLead(lead: Lead): string {
  return [
    `Nom : ${lead.name ?? "?"}`,
    lead.company ? `Entreprise : ${lead.company}` : null,
    `Téléphone : ${lead.phone ?? "?"}`,
    lead.email ? `Courriel : ${lead.email}` : null,
    lead.city ? `Ville : ${lead.city}` : null,
    `Puissance : ${lead.power_kw !== null ? `${lead.power_kw} kW` : "?"}`,
    `Usage : ${lead.usage ?? "?"}`,
    lead.voltage ? `Tension : ${lead.voltage}` : null,
    lead.enclosure ? `Boîtier : ${lead.enclosure}` : null,
    lead.notes ? `Notes : ${lead.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface NotifyConfig {
  webhookUrl?: string;
  resendApiKey?: string;
  emailEnabled?: boolean;
}

/**
 * Prévient l'équipe : par courriel à ventes@solutionnrj.com (Resend) et, si configuré,
 * par un webhook entrant (Slack, Discord, Google Chat, Make, Zapier…).
 */
export async function notifyTeam(config: NotifyConfig, title: string, lead: Lead, idempotencyKey: string): Promise<void> {
  const text = `${title}\n${describeLead(lead)}`;
  const jobs: Promise<void>[] = [];
  if (config.resendApiKey && config.emailEnabled) {
    jobs.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          from: "Solution NRJ <ventes@solutionnrj.com>",
          to: ["ventes@solutionnrj.com"],
          ...(lead.email ? { reply_to: lead.email } : {}),
          subject: `Messenger — ${title.replace(/^\S+\s/, "")}`,
          text: `${text}\n\nRépondez au client dans Meta Business Suite (boîte de réception Messenger).`,
        }),
      }).then((res) => {
        if (!res.ok) console.error(`Courriel à l'équipe échoué (${res.status})`);
      }),
    );
  }
  if (config.webhookUrl) {
    jobs.push(
      fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text.slice(0, 2000), lead }),
      }).then((res) => {
        if (!res.ok) console.error(`Webhook de l'équipe échoué (${res.status})`);
      }),
    );
  }
  await Promise.all(jobs);
}
