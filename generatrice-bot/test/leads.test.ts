import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLead, leadsToCsv, mergeLead, missingFields, normalizePhone } from "../src/leads.ts";

test("mergeLead conserve les valeurs connues", () => {
  const a = mergeLead(emptyLead("u1", "t0"), { city: "Québec", power_kw: 30 }, "t1");
  const b = mergeLead(a, { city: null, power_kw: null, usage: "chalet" }, "t2");
  assert.equal(b.city, "Québec");
  assert.equal(b.power_kw, 30);
  assert.equal(b.usage, "chalet");
  assert.deepEqual(missingFields(b), ["phone"]);
});

test("normalizePhone", () => {
  assert.equal(normalizePhone("(438) 350-6979"), "4383506979");
  assert.equal(normalizePhone("+1 438 350 6979"), "+14383506979");
  assert.equal(normalizePhone("non merci"), null);
});

test("leadsToCsv échappe les virgules et neutralise les formules Excel", () => {
  const lead = { ...emptyLead("u1", "t0"), name: "=HYPERLINK(1)", notes: "triphasé, insonorisée", phone: "+14383506979" };
  const csv = leadsToCsv([lead]);
  assert.match(csv, /'=HYPERLINK\(1\)/);
  assert.match(csv, /"triphasé, insonorisée"/);
  assert.match(csv, /,\+14383506979,/);
});
