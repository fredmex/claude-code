import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { splitMessage, verifySignature } from "../src/messenger.ts";

test("verifySignature accepte une signature valide et refuse le reste", async () => {
  const body = '{"object":"page"}';
  const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(await verifySignature(body, sig, "secret"), true);
  assert.equal(await verifySignature(body + " ", sig, "secret"), false);
  assert.equal(await verifySignature(body, sig, "autre"), false);
  assert.equal(await verifySignature(body, null, "secret"), false);
  assert.equal(await verifySignature(body, "sha256=zz", "secret"), false);
});

test("splitMessage respecte la limite de 2000 caractères sans perdre de texte", () => {
  const text = Array.from({ length: 300 }, (_, i) => `Phrase numéro ${i}.`).join(" ");
  const parts = splitMessage(text);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 2000);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text);
  assert.deepEqual(splitMessage("Bonjour"), ["Bonjour"]);
});
