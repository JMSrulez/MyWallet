import test from "node:test";
import assert from "node:assert/strict";
import ccxt from "ccxt";
import { createProviders } from "../server/providers.js";
import { createCollector } from "../server/collector.js";
import { createStore, buildPortfolio } from "../server/store.js";

const vault = { decrypt: () => ({}) };
const account = { id: "kraken-test", name: "Kraken", provider: "kraken", credentials: "encrypted", created_at: "2026-01-01T00:00:00Z" };

test("Kraken BalanceEx staking and spot ADA collect at the Cardano price", async (t) => {
  t.mock.method(ccxt.kraken.prototype, "loadMarkets", async function () {
    this.markets = {};
    return this.markets;
  });
  t.mock.method(ccxt.kraken.prototype, "privatePostBalanceEx", async () => ({
    error: [],
    result: {
      ADA: { balance: "10", hold_trade: "2" },
      "ADA.S": { balance: "20", hold_trade: "0" },
      "ADA.F": { balance: "5", hold_trade: "0" },
    },
  }));
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ cardano: { eur: 0.5 } }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const store = createStore();
  try {
    store.addAccount(account);
    const adapters = createProviders(vault);
    const collector = createCollector({ store, ...adapters });
    assert.equal((await collector.collect()).results[0].ok, true);
    const portfolio = buildPortfolio(store);
    assert.equal(portfolio.total, 17.5);
    assert.deepEqual(portfolio.accounts[0].snapshot.holdings, [
      { asset: "ADA", quantity: 35, price: 0.5 },
    ]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, "/api/v3/simple/price");
    assert.equal(urls[0].searchParams.get("ids"), "cardano");
  } finally {
    store.close();
  }
});

test("only Kraken documented balance suffixes are folded, preserving other assets", async (t) => {
  const totals = {
    ADA: 10, "ADA.S": 20, "ADA.M": 3, "ADA.B": 4, "ADA.F": 5,
    DOT: 1, "DOT.P": 2, "ADA.T": 7, "ADA.UNKNOWN": 8,
  };
  t.mock.method(ccxt.kraken.prototype, "fetchBalance", async () => ({ total: totals }));
  t.mock.method(ccxt.coinbase.prototype, "fetchBalance", async () => ({ total: totals }));
  const adapters = createProviders(vault);
  assert.deepEqual(await adapters.readBalances(account), {
    ADA: 42, DOT: 3, "ADA.T": 7, "ADA.UNKNOWN": 8,
  });
  assert.deepEqual(await adapters.readBalances({ ...account, provider: "coinbase" }), totals);
});

test("invalid Kraken quantities cannot disappear during aggregation", async (t) => {
  t.mock.method(ccxt.kraken.prototype, "fetchBalance", async () => ({
    total: { ADA: 10, "ADA.S": NaN },
  }));
  await assert.rejects(createProviders(vault).readBalances(account), /Solde invalide/);
});
