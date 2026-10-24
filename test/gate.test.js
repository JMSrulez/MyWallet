import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import ccxt from "ccxt";
import { createProviders } from "../server/providers.js";
import { readGateSpot, readGateQuotes } from "../server/gate.js";
import { createCollector } from "../server/collector.js";
import { createStore, buildPortfolio } from "../server/store.js";
import { createVault } from "../server/security.js";
import { createApp } from "../server/app.js";

const key = "gate-test-key";
const secret = "gate-test-secret";
const vault = { decrypt: () => ({ apiKey: key, secret }) };
const account = { id: "gate", name: "Gate", provider: "gate", credentials: "encrypted", created_at: "2026-01-01T00:00:00Z" };

test("Gate international and EU use only the signed spot balance endpoint and include locked funds", async (t) => {
  const requests = [];
  t.mock.method(ccxt.gate.prototype, "fetch", async (url, method, headers, body) => {
    requests.push({ url, method, headers, body });
    return [
      { currency: "BTC", available: "0.01", locked: "0.002" },
      { currency: "GT", available: "2", locked: "1" },
      { currency: "USDT", available: "0", locked: "0" },
    ];
  });
  const adapters = createProviders(vault);
  for (const [provider, hostname] of [["gate", "api.gateio.ws"], ["gateeu", "api.gateeu.com"]]) {
    assert.deepEqual(await adapters.readBalances({ ...account, provider }), { BTC: 0.012, GT: 3, USDT: 0 });
    const request = requests.at(-1);
    const url = new URL(request.url);
    assert.equal(url.hostname, hostname);
    assert.equal(url.pathname, "/api/v4/spot/accounts");
    assert.equal(url.search, "");
    assert.equal(request.method, "GET");
    assert.equal(request.body, undefined);
    assert.equal(request.headers.KEY, key);
    const payload = ["GET", url.pathname, "", createHash("sha512").update("").digest("hex"), request.headers.Timestamp].join("\n");
    assert.equal(request.headers.SIGN, createHmac("sha512", secret).update(payload).digest("hex"));
    assert.ok(/^\d+$/.test(request.headers.Timestamp));
  }
  assert.equal(requests.length, 2); // No unified/account detail, markets, Earn or transfer request.
});

test("Gate spot collection values GT using its own EUR market", async (t) => {
  t.mock.method(ccxt.gate.prototype, "fetch", async (url) => new URL(url).pathname.endsWith("/tickers")
    ? [{ currency_pair: "GT_EUR", last: "8" }] : [
    { currency: "GT", available: "2", locked: "1" },
    { currency: "EUR", available: "10", locked: "2" },
  ]);
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ "gatechain-token": { eur: 8 } }), { headers: { "Content-Type": "application/json" } });
  });
  const store = createStore();
  try {
    store.addAccount(account);
    const collector = createCollector({ store, ...createProviders(vault) });
    assert.equal((await collector.collect()).results[0].ok, true);
    assert.equal(buildPortfolio(store).total, 36);
    assert.equal(buildPortfolio(store).partial, false);
    assert.equal(urls.length, 0); // EUR market needs no CoinGecko conversion.
    assert.ok(!JSON.stringify(buildPortfolio(store)).includes(secret));
  } finally { store.close(); }
});

test("Gate validates spot responses and explicit zeros instead of inventing balances", async () => {
  const client = { safeCurrencyCode: (symbol) => symbol, privateSpotGetAccounts: async () => [] };
  assert.deepEqual(await readGateSpot(client), {});
  client.privateSpotGetAccounts = async () => [{ currency: "BTC", available: "0", locked: "0" }];
  assert.deepEqual(await readGateSpot(client), { BTC: 0 });
  for (const response of [{}, null, [{ currency: "BTC", available: "1" }],
    [{ currency: "BTC", available: "-1", locked: "0" }], [{ currency: "BTC", available: "NaN", locked: "0" }],
    [{ currency: "BTC", available: 1, locked: "0" }], [{ currency: "BTC", available: "1", locked: "0" }, { currency: "btc", available: "2", locked: "0" }]]) {
    client.privateSpotGetAccounts = async () => response;
    await assert.rejects(readGateSpot(client), /Gate:/);
  }
});

test("Gate labels provide actionable errors, preserve snapshots and never expose raw messages", async (t) => {
  let label;
  t.mock.method(ccxt.gate.prototype, "privateSpotGetAccounts", async () => {
    throw new ccxt.AuthenticationError(`gate ${JSON.stringify({ label, message: `echo ${key} ${secret}` })}`);
  });
  const store = createStore();
  try {
    store.addAccount(account);
    store.recordSnapshot(account.id, "2026-01-01", [{ asset: "EUR", quantity: 100, price: 1 }]);
    const collector = createCollector({ store, ...createProviders(vault) });
    for (label of ["INVALID_KEY", "INVALID_SIGNATURE", "IP_FORBIDDEN", "REQUEST_EXPIRED", "FORBIDDEN", "UNKNOWN"]) {
      assert.equal((await collector.collect()).results[0].ok, false);
      assert.equal(store.snapshots().length, 1);
      assert.equal(buildPortfolio(store).total, 100);
      const error = store.account(account.id).last_error;
      assert.ok(!error.includes(key) && !error.includes(secret));
      if (label === "IP_FORBIDDEN") assert.match(error, /IP publique de sortie/);
      if (label === "REQUEST_EXPIRED") assert.match(error, /horloge/);
      if (label === "FORBIDDEN") assert.match(error, /lecture seule/);
    }
  } finally { store.close(); }
});

test("Gate.io and Gate EU accounts require API key and secret, encrypt credentials and omit passphrase", async () => {
  const store = createStore();
  const secureVault = createVault(randomBytes(32).toString("base64"));
  const server = createApp({ store, vault: secureVault, collector: { running: false }, password: "long-test-password" }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie) => fetch(base + route, { method: "POST", headers: {
    "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}),
  }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/accounts", { name: "Gate", provider: "gate", apiKey: key, secret })).status, 401);
    const login = await post("/api/login", { password: "long-test-password" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const provider of ["gate", "gateeu"]) {
      assert.equal((await post("/api/accounts", { name: "Gate", provider, apiKey: key }, cookie)).status, 400);
      const added = await post("/api/accounts", { name: "Gate", provider, apiKey: key, secret }, cookie);
      assert.equal(added.status, 201);
      const { id } = await added.json();
      assert.deepEqual(secureVault.decrypt(store.account(id).credentials), { apiKey: key, secret });
      assert.ok(!store.account(id).credentials.includes(secret));
    }
    const p = await (await fetch(base + "/api/portfolio", { headers: { Cookie: cookie } })).json();
    assert.equal(p.accounts.length, 2);
    assert.ok(!JSON.stringify(p).includes(secret));
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});

test("Gate long-tail tokens use native markets, USDT conversion and visible partial valuation", async (t) => {
  const requests = [];
  t.mock.method(ccxt.gate.prototype, "fetch", async (url, method, headers) => {
    requests.push({ url: new URL(url), headers });
    if (url.includes("/tickers")) return [
      { currency_pair: "AIAGENT_USDT", last: "0.002" },
      { currency_pair: "AIAGENT_BTC", last: "999" },
      { currency_pair: "DUST_USDT", last: "" },
      { currency_pair: "DIRECT_EUR", last: "3" },
    ];
    return [
      { currency: "AIAGENT", available: "1000", locked: "500" },
      { currency: "DUST", available: "2", locked: "0" },
      { currency: "DIRECT", available: "2", locked: "0" },
    ];
  });
  const cg = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    cg.push(parsed);
    assert.equal(parsed.searchParams.get("ids"), "tether");
    return new Response(JSON.stringify({ tether: { eur: 0.9 } }));
  });
  for (const provider of ["gate", "gateeu"]) {
    const store = createStore();
    try {
      store.addAccount({ ...account, provider });
      const collector = createCollector({ store, ...createProviders(vault) });
      assert.equal((await collector.collect()).results[0].ok, true);
      const portfolio = buildPortfolio(store);
      assert.equal(portfolio.total, 8.7);
      assert.equal(portfolio.partial, true);
      const holdings = portfolio.accounts[0].snapshot.holdings;
      assert.ok(Math.abs(holdings.find(h => h.asset === "AIAGENT").price - 0.0018) < 1e-15);
      assert.deepEqual(holdings.find(h => h.asset === "DUST"), {
        asset: "DUST", quantity: 2, price: null, priceProvider: provider, unpriced: true,
      });
      const tick = requests.at(-1);
      assert.equal(tick.url.pathname, "/api/v4/spot/tickers");
      assert.equal(tick.url.hostname, provider === "gate" ? "api.gateio.ws" : "api.gateeu.com");
      assert.equal(tick.headers?.KEY, undefined);
      assert.equal(tick.headers?.SIGN, undefined);
    } finally { store.close(); }
  }
  assert.equal(cg.length, 2);
});

test("Gate malformed or unavailable tickers preserve the last snapshot", async (t) => {
  let response;
  t.mock.method(ccxt.gate.prototype, "privateSpotGetAccounts", async () => [
    { currency: "AIAGENT", available: "1", locked: "0" },
  ]);
  t.mock.method(ccxt.gate.prototype, "publicSpotGetTickers", async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const store = createStore();
  try {
    store.addAccount(account);
    store.recordSnapshot(account.id, "2026-01-01", [{ asset: "EUR", quantity: 100, price: 1 }]);
    const collector = createCollector({ store, ...createProviders(vault) });
    for (response of [null, {}, [{ currency_pair: "AIAGENT_USDT", last: "oops" }], new Error("network")]) {
      assert.equal((await collector.collect()).results[0].ok, false);
      assert.equal(store.snapshots().length, 1);
      assert.equal(buildPortfolio(store).total, 100);
    }
  } finally { store.close(); }
});

test("Gate quotes distinguish missing markets, validate duplicates and prefer EUR", async () => {
  const client = { safeCurrencyCode: s => s, publicSpotGetTickers: async () => [
    { currency_pair: "AIAGENT_USDT", last: "2" },
    { currency_pair: "AIAGENT_EUR", last: "1" },
    { currency_pair: "DELISTED_USDT", last: "0" },
  ] };
  const quotes = await readGateQuotes(client);
  assert.equal(quotes.get("AIAGENT").quote, "EUR");
  assert.equal(quotes.has("DELISTED"), false);
  client.publicSpotGetTickers = async () => [
    { currency_pair: "X_USDT", last: "1" }, { currency_pair: "X_USDT", last: "2" },
  ];
  await assert.rejects(readGateQuotes(client), /duplique/);
});

test("Gate EUR conversion failure is not treated as a missing token quotation", async (t) => {
  t.mock.method(ccxt.gate.prototype, "publicSpotGetTickers", async () => [
    { currency_pair: "AIAGENT_USDT", last: "2" },
  ]);
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const providers = createProviders(vault);
  await providers.preparePrices({ AIAGENT: 1 }, "gate");
  await assert.rejects(providers.getPrice("AIAGENT", "gate"), /CoinGecko HTTP 503/);
  assert.equal(await providers.getPrice("UNKNOWN", "gate"), null);
  assert.equal(await providers.getPrice("EUR", "gate"), 1);
});
