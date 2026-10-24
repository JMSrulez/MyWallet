import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createProviders } from "../server/providers.js";
import { createEthereum } from "../server/ethereum.js";
import { createCollector } from "../server/collector.js";
import { createStore, buildPortfolio } from "../server/store.js";
import { createApp } from "../server/app.js";
import { createVault } from "../server/security.js";

const address = "0x1111111111111111111111111111111111111111";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const fake = "0x2222222222222222222222222222222222222222";
const unknown = "0x3333333333333333333333333333333333333333";
const vault = { decrypt: () => ({ address }) };
const account = { id: "ethereum", name: "MetaMask", provider: "ethereum", credentials: "encrypted", created_at: "2026-01-01T00:00:00Z" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const token = (contract, value, decimals = "18", symbol = "USDC") => ({ value,
  token: { type: "ERC-20", address_hash: contract, decimals, symbol, name: "Token name" } });

test("Ethereum paginates ERC-20s, converts decimals, prices by contract and exposes unpriced tokens", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(url); calls.push(u);
    assert.ok(!init?.method || init.method === "GET");
    if (u.hostname === "eth.blockscout.com") {
      assert.ok(u.pathname.startsWith(`/api/v2/addresses/${address}`));
      if (!u.pathname.endsWith("/tokens")) return json({ hash: address, coin_balance: "1000000000000000000" });
      assert.equal(u.searchParams.get("type"), "ERC-20");
      if (!u.searchParams.has("items_count")) return json({ items: [token(usdc, "1234567", "6")],
        next_page_params: { items_count: 50, id: 123, value: "1234567" } });
      return json({ items: [token(fake, "10000000000000000000"), token(unknown, "123", null),
        token("0x4444444444444444444444444444444444444444", "0")], next_page_params: null });
    }
    assert.equal(u.hostname, "api.coingecko.com");
    if (u.pathname.endsWith("/simple/token_price/ethereum")) {
      assert.deepEqual(new Set(u.searchParams.get("contract_addresses").split(",")), new Set([usdc, fake]));
      return json({ [usdc]: { eur: 0.9 } });
    }
    assert.equal(u.pathname, "/api/v3/simple/price");
    assert.equal(u.searchParams.get("ids"), "ethereum");
    return json({ ethereum: { eur: 2000 } });
  });
  const store = createStore();
  try {
    store.addAccount(account);
    const collector = createCollector({ store, ...createProviders(vault) });
    assert.equal((await collector.collect()).results[0].ok, true);
    const p = buildPortfolio(store);
    assert.ok(Math.abs(p.total - (2000 + 1.234567 * 0.9)) < 1e-8);
    assert.equal(p.partial, true);
    assert.equal(p.accounts[0].snapshot.partial, true);
    assert.equal(p.accounts[0].history[0].partial, true);
    assert.equal(p.history[0].partial, true);
    const h = p.accounts[0].snapshot.holdings;
    assert.equal(h.find((item) => item.asset === `ERC20:${usdc}`).quantity, 1.234567);
    assert.equal(h.find((item) => item.asset === `ERC20:${fake}`).unpriced, true);
    assert.equal(h.find((item) => item.asset === `ERC20:${fake}`).quantity, 10);
    assert.equal(h.find((item) => item.asset === `ERC20:${unknown}`).quantity, null);
    assert.equal(h.find((item) => item.asset === `ERC20:${unknown}`).rawQuantity, "123");
    assert.equal(h.length, 4);
    assert.equal(calls.filter((u) => u.hostname.includes("coingecko")).length, 2);
    assert.ok(calls.every((u) => !u.pathname.includes("/coins/list")));
  } finally { store.close(); }
});

test("Ethereum malformed balances, repeated pages and HTTP failures cannot write partial balance scans", async (t) => {
  let mode = "repeat";
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url);
    if (mode === "http") return json({}, 429);
    if (!u.pathname.endsWith("/tokens")) return json({ hash: address, coin_balance: mode === "null" ? null : "0" });
    if (mode === "shape") return json({ items: [] });
    if (mode === "duplicate") return json({ items: [token(fake, "1"), token(fake, "2")], next_page_params: null });
    return json({ items: [], next_page_params: { items_count: 50 } });
  });
  const store = createStore();
  try {
    store.addAccount(account);
    store.recordSnapshot(account.id, "2026-01-01", [{ asset: "ETH", quantity: 1, price: 2000 }]);
    const collector = createCollector({ store, ...createProviders(vault) });
    for (mode of ["repeat", "http", "null", "shape", "duplicate"]) {
      assert.equal((await collector.collect()).results[0].ok, false);
      assert.equal(store.snapshots().length, 1);
      assert.equal(buildPortfolio(store).total, 2000);
    }
  } finally { store.close(); }
});

test("ERC-20 price API failures stay errors rather than being reclassified as unknown prices", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ error: "rate limit" }, 429));
  await assert.rejects(createProviders(vault).preparePrices({ [`ERC20:${usdc}`]: 1 }, "ethereum"), /429/);
});

test("an indexed empty Ethereum wallet is a genuine zero balance", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => json(new URL(url).pathname.endsWith("/tokens")
    ? { items: [], next_page_params: null } : { hash: address, coin_balance: "0" }));
  assert.deepEqual(await createEthereum(vault).readBalances(account), { ETH: 0 });
});

test("authenticated address creation uses no wallet secrets, rejects duplicates and exports partial status", async () => {
  const store = createStore();
  const secureVault = createVault(randomBytes(32).toString("base64"));
  const collector = createCollector({ store, readBalances: async () => ({ ETH: 1 }), getPrice: async () => 2000,
    readValuations: async () => [{ asset: `ERC20:${fake}`, contract: fake, network: "ethereum", symbol: "TEST",
      quantity: 1, price: null, unpriced: true }],
  });
  const server = createApp({ store, vault: secureVault, collector, password: "test-long-password" }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, cookie) => fetch(base + route, { method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await request("/api/accounts", { provider: "ethereum", name: "MM", address })).status, 401);
    const login = await request("/api/login", { password: "test-long-password" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const invalid of ["vitalik.eth", "0x1234", "https://example.com", 123, null])
      assert.equal((await request("/api/accounts", { provider: "ethereum", name: "MM", address: invalid }, cookie)).status, 400);
    const added = await request("/api/accounts", { provider: "ethereum", name: "MM", address }, cookie);
    assert.equal(added.status, 201);
    const { id } = await added.json();
    assert.deepEqual(secureVault.decrypt(store.account(id).credentials), { address });
    assert.equal((await request("/api/accounts", { provider: "ethereum", name: "duplicate", address }, cookie)).status, 409);
    assert.equal((await request("/api/collect", {}, cookie)).status, 200);
    const p = await (await fetch(base + "/api/portfolio", { headers: { Cookie: cookie } })).json();
    assert.equal(p.partial, true);
    assert.equal(p.total, 2000);
    assert.ok(!("credentials" in p.accounts[0]));
    const exported = await (await fetch(base + "/api/export", { headers: { Cookie: cookie } })).text();
    assert.match(exported, /valuation_status/);
    assert.match(exported, /partial/);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});
