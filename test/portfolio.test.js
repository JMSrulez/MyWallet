import test from "node:test";
import assert from "node:assert/strict";
import { createStore, buildPortfolio } from "../server/store.js";
import { createCollector } from "../server/collector.js";

function addAccount(store, id) {
  store.addAccount({
    id,
    name: id,
    provider: "kraken",
    credentials: "encrypted-secret",
    created_at: "2026-01-01T00:00:00Z",
  });
}

test("collects all balances including held funds and builds individual/global history", async () => {
  const store = createStore();
  try {
    addAccount(store, "one");
    addAccount(store, "two");
    const collector = createCollector({
      store,
      readBalances: async () => ({ BTC: 2, EUR: 50, ETH: 0 }),
      getPrice: async (asset) => (asset === "EUR" ? 1 : 100),
      now: () => "2026-01-02T00:00:00Z",
    });
    assert.equal((await collector.collect()).results.length, 2);
    const portfolio = buildPortfolio(store);
    assert.equal(portfolio.total, 500);
    assert.equal(portfolio.history.length, 1);
    assert.equal(portfolio.history[0].total, 500);
    assert.equal(portfolio.accounts[0].history[0].total, 250);
    assert.equal(JSON.stringify(portfolio).includes("encrypted-secret"), false);
  } finally {
    store.close();
  }
});

test("failed valuation writes no partial snapshot and preserves the last known balance", async () => {
  const store = createStore();
  try {
    addAccount(store, "one");
    store.recordSnapshot("one", "2026-01-01T00:00:00Z", [
      { asset: "EUR", quantity: 25, price: 1 },
    ]);
    const collector = createCollector({
      store,
      readBalances: async () => ({ EUR: 50, UNKNOWN: 10 }),
      getPrice: async (asset) => {
        if (asset === "UNKNOWN") throw new Error("secret-provider-error");
        return 1;
      },
    });
    assert.equal((await collector.collect()).results[0].ok, false);
    const portfolio = buildPortfolio(store);
    assert.equal(portfolio.total, 25);
    assert.equal(store.snapshots().length, 1);
    assert.ok(portfolio.accounts[0].last_error);
    assert.equal(
      JSON.stringify(portfolio).includes("secret-provider-error"),
      false,
    );
  } finally {
    store.close();
  }
});

test("global history carries forward the latest known account values", () => {
  const store = createStore();
  try {
    addAccount(store, "one");
    addAccount(store, "two");
    store.recordSnapshot("one", "2026-01-01T00:00:00Z", [
      { asset: "EUR", quantity: 100, price: 1 },
    ]);
    store.recordSnapshot("two", "2026-01-02T00:00:00Z", [
      { asset: "EUR", quantity: 200, price: 1 },
    ]);
    store.recordSnapshot("one", "2026-01-03T00:00:00Z", [
      { asset: "EUR", quantity: 150, price: 1 },
    ]);
    assert.deepEqual(
      buildPortfolio(store).history.map((point) => point.total),
      [100, 300, 350],
    );
    assert.throws(() =>
      store.recordSnapshot("one", "2026-01-04", [
        { asset: "BAD", quantity: 1, price: NaN },
      ]),
    );
  } finally {
    store.close();
  }
});

test("concurrent collections do not overlap", async () => {
  const store = createStore();
  try {
    addAccount(store, "one");
    let release;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const collector = createCollector({
      store,
      readBalances: async () => {
        await waiting;
        return { EUR: 1 };
      },
      getPrice: async () => 1,
    });
    const first = collector.collect();
    assert.equal((await collector.collect()).busy, true);
    release();
    await first;
    assert.equal(store.snapshots().length, 1);
  } finally {
    store.close();
  }
});
