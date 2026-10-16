import { test } from "node:test";
import assert from "node:assert/strict";
import { customerGate, stopRequested } from "../src/guards.ts";

const now = Date.parse("2026-10-20T15:00:00Z");
const activated = "2026-10-20T12:00:00Z";
const baseline = JSON.stringify({ complete: true, pageId: "123", capturedAtUTC: "2026-10-20T11:59:30Z", excludedPsids: ["999"] });
const env = { MESSENGER_ENABLED: "true", MESSENGER_NEW_ONLY: "true", MESSENGER_EXISTING_BASELINE: baseline, MESSENGER_ACTIVATED_AT: activated, META_PAGE_ID: "123", MESSENGER_OWNER_TEST_PSID: "42" };

test("le bot ne répond qu'aux nouveaux clients, dans la fenêtre de 24 h", () => {
  assert.deepEqual(customerGate(env, "555", now - 1000, now), { allowed: true });
  assert.equal(customerGate(env, "999", now - 1000, now).allowed, false); // client existant
  assert.equal(customerGate(env, "555", Date.parse("2026-10-20T11:00:00Z"), now).allowed, false); // avant l'activation
  assert.equal(customerGate(env, "555", now - 25 * 3600e3, now).allowed, false); // fenêtre dépassée
  assert.equal(customerGate({ ...env, MESSENGER_ENABLED: "false" }, "555", now, now).allowed, false); // interrupteur
  assert.equal(customerGate({ ...env, MESSENGER_EXISTING_BASELINE: "" }, "555", now, now).allowed, false); // liste absente
  assert.equal(customerGate(env, "42", now, now).allowed, true); // test du propriétaire
  const ownerOnly = { ...env, MESSENGER_OWNER_ONLY: "true" };
  assert.equal(customerGate(ownerOnly, "42", now, now).allowed, true);
  assert.equal(customerGate(ownerOnly, "555", now - 1000, now).allowed, false); // nouveau client, mais phase de test
});

test("demande d'arrêt", () => {
  assert.equal(stopRequested("Non merci"), true);
  assert.equal(stopRequested("STOP"), true);
  assert.equal(stopRequested("Ne me contactez plus svp"), true);
  assert.equal(stopRequested("Quel est le prix du 40 kW?"), false);
});
