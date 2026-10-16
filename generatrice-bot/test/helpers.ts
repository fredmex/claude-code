// Faux registre, HubSpot et Resend pour les tests.

export function fakeBackends(opts: { existingContact?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const u = String(url);
    if (u.endsWith("/account-info/v3/details")) return Response.json({ portalId: 247524614 });
    if (u.endsWith("/crm/v3/objects/contacts/search")) return Response.json(opts.existingContact ? { total: 1, results: [{ id: "77" }] } : { total: 0, results: [] });
    if (u.endsWith("/crm/v3/objects/contacts")) return Response.json({ id: "501" });
    if (u.endsWith("/crm/v3/pipelines/deals")) return Response.json({ results: [{ id: "default", stages: [{ id: "qualifiedtobuy" }, { id: "presentationscheduled" }] }] });
    if (u.endsWith("/crm/v3/objects/deals")) return Response.json({ id: "901" });
    if (/\/crm\/v3\/objects\/deals\/\d+$/.test(u)) return Response.json({ id: "901" });
    if (u.endsWith("/crm/v3/objects/notes")) return Response.json({ id: "n1" });
    if (u.endsWith("/files/v3/files")) return Response.json({ id: "f1", access: "PRIVATE" });
    if (u.endsWith("/api/login")) return new Response("{}", { headers: { "set-cookie": "nrj_session=abc; HttpOnly" } });
    if (u.endsWith("/api/clients")) return Response.json({});
    if (u.endsWith("/api/quotes")) return Response.json({ id: 42, number: "S-2026-0042", revision: 1 });
    if (u === "https://api.resend.com/emails") return Response.json({ id: "email_1" });
    throw new Error("unexpected " + u);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

export const quoteEnv = { QUOTE_REGISTER_URL: "https://registre.test", QUOTE_REGISTER_PASSWORD: "x", QUOTE_WRITES_ENABLED: "true", QUOTATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "re_x", HUBSPOT_ACCESS_TOKEN: "pat", HUBSPOT_WRITES_ENABLED: "true" };
