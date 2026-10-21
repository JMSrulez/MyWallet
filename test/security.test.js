import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createVault, passwordsMatch } from "../server/security.js";

test("credentials are encrypted with unique nonces and authenticated", () => {
  const vault = createVault(randomBytes(32).toString("base64"));
  const credentials = { apiKey: "my-key", secret: "my-secret" };
  const encrypted = vault.encrypt(credentials);
  assert.deepEqual(vault.decrypt(encrypted), credentials);
  assert.notEqual(vault.encrypt(credentials), encrypted);
  assert.equal(encrypted.includes("my-secret"), false);
  const parts = encrypted.split(".");
  parts[1] = randomBytes(16).toString("base64");
  assert.throws(() => vault.decrypt(parts.join(".")));
  assert.throws(() => createVault("invalid"));
});

test("password comparison rejects incorrect and missing passwords", () => {
  assert.equal(passwordsMatch("correct", "correct"), true);
  assert.equal(passwordsMatch("wrong", "correct"), false);
  assert.equal(passwordsMatch(undefined, "correct"), false);
});
