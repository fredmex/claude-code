// Faux registre, Resend et D1 (demandes pour Dolibarr) pour les tests.

export function fakeBackends() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const u = String(url);
    if (u.endsWith("/api/login")) return new Response("{}", { headers: { "set-cookie": "nrj_session=abc; HttpOnly" } });
    if (u.endsWith("/api/clients")) return Response.json({});
    if (u.endsWith("/api/quotes")) return Response.json({ id: 42, number: "S-2026-0042", revision: 1 });
    if (u === "https://api.resend.com/emails") return Response.json({ id: "email_1" });
    throw new Error("unexpected " + u);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

export const quoteEnv = { QUOTE_REGISTER_URL: "https://registre.test", QUOTE_REGISTER_PASSWORD: "x", QUOTE_WRITES_ENABLED: "true", QUOTATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "re_x" };

/** Fausse D1 : garde chaque INSERT (requête et valeurs) ; fail = true fait échouer l'écriture. */
export function fakeLeadsDb(opts: { fail?: boolean } = {}) {
  const inserts: { sql: string; values: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (opts.fail) throw new Error("D1_ERROR");
              inserts.push({ sql, values });
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, inserts };
}

/** Colonnes de messenger_leads, dans l'ordre de l'INSERT de crm.ts. */
export const LEAD_COLUMNS = ["created_at", "event", "psid", "full_name", "email", "phone", "company", "address", "power_kw", "model_key", "model_label", "price_ht", "quote_ref", "details"];
export const leadRow = (values: unknown[]) => Object.fromEntries(LEAD_COLUMNS.map((c, i) => [c, values[i]]));
