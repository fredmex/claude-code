// HubSpot (portail 247524614), repris du service Messenger précédent :
// un contact existant n'est jamais modifié, le PDF est archivé en privé.

const HUB = "https://api.hubapi.com";
export const HUBSPOT_PORTAL_ID = 247524614;

export interface HubSpotEnv {
  HUBSPOT_ACCESS_TOKEN?: string;
  /** "true" pour autoriser les écritures (contacts, affaires, notes, fichiers). */
  HUBSPOT_WRITES_ENABLED?: string;
}

export interface HubSpotLead {
  fullName: string;
  email: string;
  phone: string | null;
  company: string | null;
  powerKw: number | null;
}

/** Le courriel du client correspond à un contact déjà dans HubSpot : l'équipe vérifie. */
export class ExistingContactError extends Error {
  contactId: string;
  constructor(contactId: string) {
    super("existing_contact_review");
    this.contactId = contactId;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function hubspotEnabled(env: HubSpotEnv): boolean {
  return Boolean(env.HUBSPOT_ACCESS_TOKEN) && env.HUBSPOT_WRITES_ENABLED === "true";
}

export class HubSpot {
  private env: HubSpotEnv;
  private fetchImpl: typeof fetch;

  constructor(env: HubSpotEnv, fetchImpl: typeof fetch = fetch) {
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async request<T = any>(path: string, { method = "GET", body, form }: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
    if (!this.env.HUBSPOT_ACCESS_TOKEN) throw new Error("hubspot_missing");
    const isSearch = path.endsWith("/search");
    if (method !== "GET" && !isSearch && this.env.HUBSPOT_WRITES_ENABLED !== "true") throw new Error("hubspot_writes_disabled");
    // Seuls PATCH autorisé : faire avancer l'étape d'une affaire.
    if (method === "PATCH" && !/^\/crm\/v3\/objects\/deals\/\d+$/.test(path)) throw new Error("hubspot_method_forbidden");
    if (!/^\/(account-info\/v3\/details|crm\/v3\/(objects\/(contacts|deals|notes)|pipelines\/deals)|files\/v3\/files)(\/|$)/.test(path)) {
      throw new Error("hubspot_path_forbidden");
    }
    const res = await this.fetchImpl(HUB + path, {
      method,
      headers: { Authorization: `Bearer ${this.env.HUBSPOT_ACCESS_TOKEN}`, ...(form ? {} : { "Content-Type": "application/json" }) },
      body: form ?? (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`hubspot_${res.status}`);
    return (await res.json()) as T;
  }

  /** Refuse d'écrire ailleurs que dans le portail de Solution NRJ. */
  async verifyPortal(): Promise<void> {
    const details = await this.request<{ portalId: number }>("/account-info/v3/details");
    if (Number(details.portalId) !== HUBSPOT_PORTAL_ID) throw new Error("hubspot_wrong_account");
  }

  /** Crée le contact ; si le courriel existe déjà, ne touche à rien et lève ExistingContactError. */
  async createNewContact(lead: HubSpotLead): Promise<string> {
    await this.verifyPortal();
    const found = await this.request<{ total: number; results: { id: string }[] }>("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: lead.email.toLowerCase() }] }], properties: ["email"], limit: 2 },
    });
    if (found.total) throw new ExistingContactError(found.results[0].id);
    const [firstname, ...rest] = lead.fullName.trim().split(/\s+/);
    const properties: Record<string, string> = { email: lead.email.toLowerCase(), firstname };
    if (rest.length) properties.lastname = rest.join(" ");
    if (lead.phone) properties.phone = lead.phone;
    if (lead.company) properties.company = lead.company.slice(0, 254);
    const contact = await this.request<{ id: string }>("/crm/v3/objects/contacts", { method: "POST", body: { properties } });
    return contact.id;
  }

  async createDeal(contactId: string, lead: HubSpotLead, stage = "qualifiedtobuy"): Promise<string> {
    const pipelines = await this.request<{ results: { id: string; stages: { id: string }[] }[] }>("/crm/v3/pipelines/deals");
    const pipeline = pipelines.results?.find((p) => p.id === "default");
    if (!pipeline?.stages?.some((s) => s.id === stage)) throw new Error("hubspot_stage_unverified");
    const deal = await this.request<{ id: string }>("/crm/v3/objects/deals", {
      method: "POST",
      body: {
        properties: { dealname: `Messenger — ${lead.fullName} — ${lead.powerKw ?? "à qualifier"} kW`, pipeline: "default", dealstage: stage },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
      },
    });
    return deal.id;
  }

  async setDealStage(dealId: string, stage: string): Promise<void> {
    await this.request(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: { properties: { dealstage: stage } } });
  }

  async note(contactId: string, text: string, fileId: string | null = null): Promise<string> {
    const properties: Record<string, string> = { hs_timestamp: new Date().toISOString(), hs_note_body: escapeHtml(text).replace(/\n/g, "<br>") };
    if (fileId) properties.hs_attachment_ids = fileId;
    const note = await this.request<{ id: string }>("/crm/v3/objects/notes", {
      method: "POST",
      body: { properties, associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] },
    });
    return note.id;
  }

  /** Archive le PDF en privé dans /Solution-NRJ/Soumissions-Messenger. */
  async archivePdf(contactId: string, pdf: Uint8Array, number: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), `${number}.pdf`);
    form.append("folderPath", "/Solution-NRJ/Soumissions-Messenger");
    form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false, duplicateValidationStrategy: "RETURN_EXISTING", duplicateValidationScope: "EXACT_FOLDER" }));
    const file = await this.request<{ id: string; access: string }>("/files/v3/files", { method: "POST", form });
    if (!file.id || file.access !== "PRIVATE") throw new Error("pdf_private_archive_unconfirmed");
    return file.id;
  }
}
