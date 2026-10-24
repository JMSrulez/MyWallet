import test from "node:test";
import assert from "node:assert/strict";
import ccxt from "ccxt";
import { createProviders } from "../server/providers.js";

test("OKX signs balance requests for the configured regional domain", async (t) => {
  t.mock.method(ccxt.okx.prototype, "loadMarkets", async function () {
    this.markets = {};
    return this.markets;
  });
  const requests = [];
  t.mock.method(ccxt.okx.prototype, "fetch", async (url, method, headers) => {
    requests.push({ url, method, headers });
    return { code: "0", data: [{ details: [{ ccy: "EUR", cashBal: "42", availBal: "40", frozenBal: "2" }] }] };
  });
  const vault = { decrypt: () => ({ apiKey: "test-key", secret: "test-secret", password: "test-passphrase" }) };
  for (const hostname of ["eea.okx.com", "us.okx.com", "www.okx.com"]) {
    const adapters = createProviders(vault, { okxHostname: hostname });
    const balances = await adapters.readBalances({ provider: "okx", name: "test", credentials: "encrypted" });
    assert.equal(balances.EUR, 42);
    const request = requests.at(-1);
    assert.equal(new URL(request.url).hostname, hostname);
    assert.equal(new URL(request.url).pathname, "/api/v5/account/balance");
    assert.equal(request.headers["OK-ACCESS-KEY"], "test-key");
    assert.ok(request.headers["OK-ACCESS-SIGN"]);
  }
});

test("OKX domain uses the environment and rejects arbitrary hosts", () => {
  const previous = process.env.OKX_HOSTNAME;
  try {
    process.env.OKX_HOSTNAME = "eea.okx.com";
    assert.doesNotThrow(() => createProviders({}));
    process.env.OKX_HOSTNAME = "untrusted.example";
    assert.throws(() => createProviders({}), /OKX_HOSTNAME/);
    assert.doesNotThrow(() => createProviders({}, { okxHostname: "www.okx.com" }));
    delete process.env.OKX_HOSTNAME;
    assert.doesNotThrow(() => createProviders({}));
  } finally {
    if (previous === undefined) delete process.env.OKX_HOSTNAME;
    else process.env.OKX_HOSTNAME = previous;
  }
});
