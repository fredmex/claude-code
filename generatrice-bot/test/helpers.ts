// Faux registre et Resend pour les tests.

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

