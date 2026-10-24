import test from "node:test";
import assert from "node:assert/strict";
import ccxt from "ccxt";
import { createProviders } from "../server/providers.js";
import { createCollector } from "../server/collector.js";
import { createStore, buildPortfolio } from "../server/store.js";

const account = { id: "okx", name: "OKX", provider: "okx", credentials: "encrypted", created_at: "2026-01-01T00:00:00Z" };
const vault = { decrypt: () => ({ apiKey: "key", secret: "secret", password: "passphrase" }) };

test("OKX combines trading and funding quantities plus only the Earn EUR valuation", async (t) => {
  t.mock.method(ccxt.okx.prototype, "loadMarkets", async function () { this.markets = {}; return {}; });
  const paths = [];
  t.mock.method(ccxt.okx.prototype, "fetch", async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    switch (parsed.pathname) {
      case "/api/v5/account/balance": return { code: "0", data: [{ details: [
        { ccy: "BTC", cashBal: "0.1", availBal: "0.08", frozenBal: "0.02" },
        { ccy: "EUR", cashBal: "10", availBal: "10", frozenBal: "0" },
      ] }] };
      case "/api/v5/asset/balances": return { code: "0", data: [
        { ccy: "BTC", bal: "0.2", availBal: "0.1", frozenBal: "0.1" },
        { ccy: "EUR", bal: "5", availBal: "5", frozenBal: "0" },
      ] };
      case "/api/v5/asset/asset-valuation":
        assert.equal(parsed.searchParams.get("ccy"), "EUR");
        return { code: "0", data: [{ details: { earn: "120.25", funding: "9999", trading: "9999", classic: "9999" }, totalBal: "99999" }] };
      default: assert.fail(`Unexpected endpoint: ${parsed.pathname}`);
    }
  });
  const store = createStore();
  try {
    store.addAccount(account);
    const adapters = createProviders(vault, { okxHostname: "eea.okx.com" });
    const priced = [];
    const collector = createCollector({ store, ...adapters, getPrice: async (asset) => {
      priced.push(asset);
      assert.ok(["BTC", "EUR"].includes(asset));
      return asset === "BTC" ? 1000 : 1;
    } });
    assert.equal((await collector.collect()).results[0].ok, true);
    const portfolio = buildPortfolio(store);
    assert.ok(Math.abs(portfolio.total - 435.25) < 1e-8);
    const holdings = portfolio.accounts[0].snapshot.holdings;
    assert.ok(Math.abs(holdings.find((h) => h.asset === "BTC").quantity - 0.3) < 1e-12);
    assert.equal(holdings.find((h) => h.asset === "EUR").quantity, 15);
    assert.deepEqual(holdings.find((h) => h.asset === "OKX_EARN"), {
      asset: "OKX_EARN", valuationOnly: true, currency: "EUR", value: 120.25,
    });
    assert.deepEqual(priced, ["BTC", "EUR"]);
    assert.equal(paths.length, 3);
  } finally { store.close(); }
});

test("missing, invalid or inaccessible OKX Earn valuation preserves the last complete snapshot", async (t) => {
  t.mock.method(ccxt.okx.prototype, "fetchBalance", async () => ({ total: { EUR: 10 } }));
  let response;
  t.mock.method(ccxt.okx.prototype, "privateGetAssetAssetValuation", async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const store = createStore();
  try {
    store.addAccount(account);
    store.recordSnapshot(account.id, "2026-01-01T00:00:00Z", [{ asset: "EUR", quantity: 25, price: 1 }]);
    const adapters = createProviders(vault);
    const collector = createCollector({ store, ...adapters });
    for (const amount of [undefined, null, "", "NaN", "Infinity", "-1", "1e309", 12]) {
      response = { code: "0", data: [{ details: { earn: amount } }] };
      assert.equal((await collector.collect()).results[0].ok, false);
    }
    response = new Error("OKX: permission Read requise");
    assert.equal((await collector.collect()).results[0].ok, false);
    assert.equal(store.snapshots().length, 1);
    assert.equal(buildPortfolio(store).total, 25);
    response = { code: "0", data: [{ details: { earn: "0" } }] };
    assert.equal((await collector.collect()).results[0].ok, true);
    assert.equal(buildPortfolio(store).total, 20);
    assert.equal(buildPortfolio(store).accounts[0].last_error, null);
    assert.deepEqual(await adapters.readValuations({ provider: "coinbase" }), []);
  } finally { store.close(); }
});

test("store rejects malformed provider valuations without changing old snapshots", () => {
  const store = createStore();
  try {
    store.addAccount(account);
    const valid = { asset: "OKX_EARN", valuationOnly: true, currency: "EUR", value: 0 };
    store.recordSnapshot(account.id, "2026-01-01", [valid]);
    for (const change of [{ value: NaN }, { value: -1 }, { currency: "USD" }, { quantity: 12 }, { price: 1 }, { asset: "EUR" }])
      assert.throws(() => store.recordSnapshot(account.id, "2026-01-02", [{ ...valid, ...change }]), /Invalid valuation/);
    assert.equal(store.snapshots().length, 1);
  } finally { store.close(); }
});

test("a funding API failure never replaces a complete OKX balance with trading alone", async (t) => {
  t.mock.method(ccxt.okx.prototype, "fetchBalance", async (params = {}) => {
    if (params.type === "funding") throw new Error("OKX financement indisponible");
    return { total: { EUR: 10 } };
  });
  const closed = t.mock.method(ccxt.okx.prototype, "close", async () => {});
  const store = createStore();
  try {
    store.addAccount(account);
    store.recordSnapshot(account.id, "2026-01-01", [{ asset: "EUR", quantity: 50, price: 1 }]);
    const collector = createCollector({ store, ...createProviders(vault) });
    assert.equal((await collector.collect()).results[0].ok, false);
    assert.equal(store.snapshots().length, 1);
    assert.equal(buildPortfolio(store).total, 50);
    assert.match(store.account(account.id).last_error, /financement indisponible/);
    assert.equal(closed.mock.callCount(), 1);
  } finally { store.close(); }
});
