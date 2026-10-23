import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../server/app.js";
import { createStore } from "../server/store.js";
import { createVault } from "../server/security.js";
import { createCollector } from "../server/collector.js";

test("authenticated account creation, collection, export and deletion", async () => {
  const store = createStore();
  const vault = createVault(randomBytes(32).toString("base64"));
  const collector = createCollector({
    store,
    readBalances: async () => ({ EUR: 42 }),
    getPrice: async () => 1,
  });
  const server = createApp({
    store,
    vault,
    collector,
    password: "a-long-test-password",
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, method = "GET", body, cookie, origin) =>
    fetch(base + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await request("/api/portfolio")).status, 401);
    assert.equal(
      (await request("/api/login", "POST", { password: "bad" })).status,
      401,
    );
    const login = await request("/api/login", "POST", {
      password: "a-long-test-password",
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const homepage = await request("/");
    assert.equal(homepage.status, 200);
    const html = await homepage.text();
    assert.equal(html.includes("\x00"), false);
    assert.match(html, /Page pr&eacute;c&eacute;dente/);
    assert.equal((await request("/vendor/chart.js")).status, 200);
    assert.equal((await request("/vendor/lucide.js")).status, 200);
    assert.equal(
      (
        await request(
          "/api/accounts",
          "POST",
          {},
          cookie,
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/accounts",
          "POST",
          { name: "Missing keys", provider: "okx" },
          cookie,
        )
      ).status,
      400,
    );
    const added = await request(
      "/api/accounts",
      "POST",
      {
        name: "<script>alert(1)</script>",
        provider: "kraken",
        apiKey: "test-key",
        secret: "test-secret",
      },
      cookie,
    );
    assert.equal(added.status, 201);
    const { id } = await added.json();
    assert.equal(store.account(id).credentials.includes("test-secret"), false);
    assert.equal(
      (await request("/api/collect", "POST", {}, cookie)).status,
      200,
    );
    const portfolio = await (
      await request("/api/portfolio", "GET", null, cookie)
    ).json();
    assert.equal(portfolio.total, 42);
    assert.equal(JSON.stringify(portfolio).includes("test-secret"), false);
    assert.equal("credentials" in portfolio.accounts[0], false);
    const exported = await request("/api/export", "GET", null, cookie);
    assert.match(await exported.text(), /42.00/);
    assert.equal(
      (await request(`/api/accounts/${id}`, "DELETE", {}, cookie)).status,
      200,
    );
    assert.equal(store.snapshots().length, 0);
    await request("/api/logout", "POST", {}, cookie);
    assert.equal(
      (await request("/api/portfolio", "GET", null, cookie)).status,
      401,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("demo rejects account changes and collections", async () => {
  const store = createStore();
  const server = createApp({
    store,
    collector: { running: false },
    demo: true,
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/portfolio`)).status, 200);
    for (const route of [
      "/api/accounts",
      "/api/collect",
      "/api/gomining/authorize",
      "/api/gomining/callback",
    ]) {
      assert.equal(
        (
          await fetch(base + route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (await fetch(`${base}/oauth/gomining/callback?code=fake&state=fake`))
        .status,
      404,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
