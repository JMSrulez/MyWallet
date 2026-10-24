import test from "node:test";
import assert from "node:assert/strict";
import ccxt from "ccxt";
import { createProviders } from "../server/providers.js";
import { createCollector } from "../server/collector.js";
import { createStore, buildPortfolio } from "../server/store.js";

const account = { id: "okx", name: "OKX", provider: "okx", credentials: "encrypted", created_at: "2026-01-01T00:00:00Z" };
const vault = { decrypt: () => ({ apiKey: "key", secret: "secret", password: "passphrase" }) };

function mockPrices(t) {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url));
    const body = new URL(url).pathname.endsWith("/coins/list") ? [] : { "usd-coin": { eur: 0.9 } };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
  return urls;
}

test("LYUSDC uses USDC/EUR only on OKX and shares its price cache with USDC", async (t) => {
  const urls = mockPrices(t);
  const adapters = createProviders(vault);
  assert.equal(await adapters.getPrice("LYUSDC", "okx"), 0.9);
  assert.equal(await adapters.getPrice("USDC", "okx"), 0.9);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("ids"), "usd-coin");
  await assert.rejects(adapters.getPrice("LYUSDC", "kraken"), /Unsupported asset/);
  await assert.rejects(adapters.getPrice("XXUSDC", "okx"), /Unsupported asset/);
});

test("OKX LYUSDC totals reconcile whether Earn overlaps, excludes the receipt or has a valuation difference", async (t) => {
  mockPrices(t);
  t.mock.method(ccxt.okx.prototype, "loadMarkets", async function () { this.markets = {}; return {}; });
  let report;
  t.mock.method(ccxt.okx.prototype, "fetch", async (url) => {
    switch (new URL(url).pathname) {
      case "/api/v5/account/balance": return { code: "0", data: [{ details: [
        { ccy: "LYUSDC", cashBal: "100", availBal: "100", frozenBal: "0" },
        { ccy: "USDC", cashBal: "50", availBal: "50", frozenBal: "0" },
      ] }] };
      case "/api/v5/asset/balances": return { code: "0", data: [
        { ccy: "LYUSDC", bal: "20", availBal: "20", frozenBal: "0" },
        { ccy: "EUR", bal: "10", availBal: "10", frozenBal: "0" },
      ] };
      case "/api/v5/asset/asset-valuation": return { code: "0", data: [report] };
      default: assert.fail(`Unexpected request ${new URL(url).pathname}`);
    }
  });
  const store = createStore();
  try {
    store.addAccount(account);
    const adapters = createProviders(vault);
    const collector = createCollector({ store, ...adapters });
    for (const [earn, total, adjustment] of [["138", "193", -108], ["30", "193", 0], ["30", "200", 7]]) {
      report = { details: { earn }, totalBal: total };
      assert.equal((await collector.collect()).results[0].ok, true);
      const portfolio = buildPortfolio(store);
      assert.ok(Math.abs(portfolio.total - Number(total)) < 1e-8);
      const holdings = portfolio.accounts[0].snapshot.holdings;
      assert.deepEqual(holdings.find((h) => h.asset === "LYUSDC"), { asset: "LYUSDC", quantity: 120, price: 0.9 });
      const actual = holdings.find((h) => h.asset === "OKX_RECONCILIATION")?.value ?? 0;
      assert.ok(Math.abs(actual - adjustment) < 1e-8);
      assert.equal(holdings.find((h) => h.asset === "OKX_EARN").value, Number(earn));
    }
    const snapshots = store.snapshots().length;
    for (const totalBal of [undefined, "", "NaN", "-1", "Infinity"]) {
      report = { details: { earn: "138" }, totalBal };
      assert.equal((await collector.collect()).results[0].ok, false);
      assert.equal(store.snapshots().length, snapshots);
      assert.equal(buildPortfolio(store).total, 200);
    }
  } finally { store.close(); }
});

test("price caching in one collection never applies an OKX-only alias to Kraken", async () => {
  const store = createStore();
  try {
    store.addAccount({ ...account, id: "a" });
    store.addAccount({ ...account, id: "b", provider: "kraken" });
    const collector = createCollector({ store, readBalances: async () => ({ LYUSDC: 1 }),
      getPrice: async (asset, provider) => {
        assert.equal(asset, "LYUSDC");
        if (provider !== "okx") throw new Error("Unsupported asset");
        return 0.9;
      },
    });
    assert.deepEqual((await collector.collect()).results.map((r) => r.ok), [true, false]);
    assert.equal(store.snapshots().length, 1);
  } finally { store.close(); }
});
