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
    if (new URL(url).pathname === "/api/v5/asset/balances")
      return { code: "0", data: [{ ccy: "EUR", bal: "8", availBal: "6", frozenBal: "2" }] };
    if (new URL(url).pathname === "/api/v5/asset/asset-valuation")
      return { code: "0", data: [{ details: { earn: "12" } }] };
    return { code: "0", data: [{ details: [{ ccy: "EUR", cashBal: "42", availBal: "40", frozenBal: "2" }] }] };
  });
  const vault = { decrypt: () => ({ apiKey: "test-key", secret: "test-secret", password: "test-passphrase" }) };
  for (const hostname of ["eea.okx.com", "us.okx.com", "www.okx.com"]) {
    const adapters = createProviders(vault, { okxHostname: hostname });
    const balances = await adapters.readBalances({ provider: "okx", name: "test", credentials: "encrypted" });
    assert.equal(balances.EUR, 50);
    assert.equal((await adapters.readValuations({ provider: "okx", name: "test", credentials: "encrypted" }))[0].value, 12);
    const batch = requests.slice(-3);
    assert.deepEqual(batch.map((request) => new URL(request.url).pathname), [
      "/api/v5/account/balance", "/api/v5/asset/balances", "/api/v5/asset/asset-valuation",
    ]);
    for (const request of batch) {
      assert.equal(new URL(request.url).hostname, hostname);
      assert.equal(request.method, "GET");
      assert.equal(request.headers["OK-ACCESS-KEY"], "test-key");
      assert.ok(request.headers["OK-ACCESS-SIGN"]);
    }
    assert.equal(new URL(batch[2].url).searchParams.get("ccy"), "EUR");
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
