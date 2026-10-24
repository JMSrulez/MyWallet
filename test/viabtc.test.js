import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createProviders } from "../server/providers.js";
import { createViaBtc, parseViaBtcBalances } from "../server/viabtc.js";
import { createCollector } from "../server/collector.js";
import { createStore, buildPortfolio } from "../server/store.js";
import { createVault } from "../server/security.js";
import { createApp } from "../server/app.js";

const key = "test-viabtc-api-key";
const account = { id: "pool", name: "ViaBTC", provider: "viabtc", credentials: "encrypted", created_at: "2026-01-01T00:00:00Z" };
const vault = { decrypt: () => ({ apiKey: key, secret: "not-needed" }) };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("ViaBTC reads only account balances using X-API-KEY, values all coins and discards profile/payout data", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(url); calls.push(u);
    if (u.hostname === "www.viabtc.com") {
      assert.equal(u.pathname, "/res/openapi/v1/account");
      assert.equal(u.search, "");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["X-API-KEY"], key);
      assert.ok(!init.headers["X-SIGNATURE"]);
      assert.equal(init.body, undefined);
      return json({ code: 0, message: "OK", data: {
        account: { email: "private@example.com" }, observer: [{ access_key: "private-observer-key" }],
        withdraw_address: [{ coin: "BTC", address: "private-payout-address" }],
        total_profit: "1000000", paid: "1000000",
        balance: [{ coin: "BTC", amount: "0.001" }, { coin: "DOGE", amount: "25" }, { coin: "LTC", amount: "0" }],
      } });
    }
    assert.equal(u.hostname, "api.coingecko.com");
    assert.ok(!init.headers["X-API-KEY"]);
    const id = u.searchParams.get("ids");
    assert.ok(["bitcoin", "dogecoin"].includes(id));
    return json({ [id]: { eur: id === "bitcoin" ? 50000 : 0.1 } });
  });
  const store = createStore();
  try {
    store.addAccount(account);
    const collector = createCollector({ store, ...createProviders(vault) });
    assert.equal((await collector.collect()).results[0].ok, true);
    const p = buildPortfolio(store);
    assert.equal(p.total, 52.5);
    assert.equal(p.partial, false);
    assert.equal(p.accounts[0].snapshot.holdings.length, 2);
    for (const privateValue of [key, "not-needed", "private@example.com", "private-observer-key", "private-payout-address"])
      assert.ok(!JSON.stringify(p).includes(privateValue));
    assert.equal(calls.length, 3);
  } finally { store.close(); }
});

test("ViaBTC API errors preserve old snapshots and never echo provider messages or credentials", async (t) => {
  let payload;
  t.mock.method(globalThis, "fetch", async () => {
    if (payload instanceof Error) throw payload;
    return json(payload);
  });
  const store = createStore();
  try {
    store.addAccount(account);
    store.recordSnapshot(account.id, "2026-01-01", [{ asset: "BTC", quantity: 0.001, price: 50000 }]);
    const collector = createCollector({ store, ...createProviders(vault) });
    for (const code of [12001, 12002, 12003, 12004, 9999]) {
      payload = { code, message: `echo-secret ${key}` };
      assert.equal((await collector.collect()).results[0].ok, false);
      assert.equal(store.snapshots().length, 1);
      assert.equal(buildPortfolio(store).total, 50);
      assert.ok(!store.account(account.id).last_error.includes(key));
      if (code === 12004) assert.match(store.account(account.id).last_error, /IP publique de sortie/);
    }
    payload = new Error(`request failed with ${key}`);
    assert.equal((await collector.collect()).results[0].ok, false);
    assert.ok(!store.account(account.id).last_error.includes(key));
    payload = { code: 0, data: {} };
    assert.equal((await collector.collect()).results[0].ok, false);
    assert.equal(store.snapshots().length, 1);
  } finally { store.close(); }
});

test("ViaBTC balance parsing accepts explicit zero and rejects missing, duplicate or malformed amounts", () => {
  assert.deepEqual(parseViaBtcBalances({ code: 0, data: { balance: [] } }), {});
  assert.deepEqual(parseViaBtcBalances({ code: 0, data: { balance: [{ coin: "btc", amount: "0" }] } }), { BTC: 0 });
  for (const amount of [null, undefined, "", "-1", "NaN", "Infinity", "1e999", 1])
    assert.throws(() => parseViaBtcBalances({ code: 0, data: { balance: [{ coin: "BTC", amount }] } }), /quantite invalide/);
  assert.throws(() => parseViaBtcBalances({ code: 0, data: { balance: [{ coin: "BTC", amount: "1" }, { coin: "btc", amount: "2" }] } }), /duplique/);
  assert.throws(() => parseViaBtcBalances({ code: 0, data: { balance: [{ coin: "<bad>", amount: "1" }] } }), /symbole/);
  assert.throws(() => parseViaBtcBalances({ code: 0, data: {} }), /absente/);
  assert.throws(() => parseViaBtcBalances({ code: "0", data: { balance: [] } }), /invalide/);
});

test("ViaBTC HTTP and non-JSON responses are errors, never an empty balance", async (t) => {
  let response = new Response("<html>Forbidden</html>", { status: 403 });
  t.mock.method(globalThis, "fetch", async () => response);
  const connector = createViaBtc(vault);
  await assert.rejects(connector.readBalances(account), /HTTP 403/);
  response = new Response("not JSON", { status: 200 });
  await assert.rejects(connector.readBalances(account), /JSON invalide/);
});

test("ViaBTC account creation needs only an API key, encrypts it and rejects duplicate keys", async () => {
  const store = createStore();
  const secureVault = createVault(randomBytes(32).toString("base64"));
  const server = createApp({ store, vault: secureVault, collector: { running: false }, password: "a-long-password" }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie) => fetch(base + route, { method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/accounts", { name: "Pool", provider: "viabtc", apiKey: key })).status, 401);
    const login = await post("/api/login", { password: "a-long-password" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const invalid of ["", "key\nheader", "unicode-😀", 123, null])
      assert.equal((await post("/api/accounts", { name: "Pool", provider: "viabtc", apiKey: invalid }, cookie)).status, 400);
    const added = await post("/api/accounts", { name: "Pool", provider: "viabtc", apiKey: ` ${key} `, secret: "ignored-secret" }, cookie);
    assert.equal(added.status, 201);
    const { id } = await added.json();
    assert.deepEqual(secureVault.decrypt(store.account(id).credentials), { apiKey: key });
    assert.ok(!store.account(id).credentials.includes(key));
    assert.equal((await post("/api/accounts", { name: "Duplicate", provider: "viabtc", apiKey: key }, cookie)).status, 409);
    const p = await (await fetch(base + "/api/portfolio", { headers: { Cookie: cookie } })).json();
    assert.ok(!JSON.stringify(p).includes(key));
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});
