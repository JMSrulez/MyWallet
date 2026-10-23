import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { createGoMining, parseGoMiningBalances } from "../server/gomining.js";
import { createStore, buildPortfolio } from "../server/store.js";
import { createVault } from "../server/security.js";
import { createApp } from "../server/app.js";
import { createCollector } from "../server/collector.js";
import { createProviders } from "../server/providers.js";

test("wallet parser supports structured or JSON balances, normalizes GoMining GMT and rejects unknown formats", () => {
  assert.deepEqual(
    parseGoMiningBalances({
      structuredContent: {
        balances: [
          { asset: "BTC", total: "0.1" },
          { currency: "GMT", balance: "12.5" },
        ],
      },
    }),
    { BTC: 0.1, GOMINING: 12.5 },
  );
  assert.deepEqual(
    parseGoMiningBalances({
      content: [{ type: "text", text: '{"balances":{"ETH":"2","USDC":0}}' }],
    }),
    { ETH: 2, USDC: 0 },
  );
  assert.deepEqual(
    parseGoMiningBalances({ structuredContent: { balances: [] } }),
    {},
  );
  for (const structuredContent of [
    {},
    { miners: [] },
    { balances: { BTC: "" } },
    { balances: { BTC: -1 } },
    { balances: { BTC: "1,2" } },
    { balances: { FAKE: 2 } },
    {
      balances: [
        { asset: "BTC", balance: 1 },
        { asset: "BTC", balance: 2 },
      ],
    },
  ]) {
    assert.throws(
      () => parseGoMiningBalances({ structuredContent }),
      /GoMining:/,
    );
  }
  assert.throws(
    () =>
      parseGoMiningBalances({
        isError: true,
        content: [{ type: "text", text: "private-error" }],
      }),
    (error) => !error.message.includes("private-error"),
  );
});

function setup({ requiredArgument = false } = {}) {
  const store = createStore();
  const vault = createVault(randomBytes(32).toString("base64"));
  let time = Date.now();
  let connections = 0;
  let calls = 0;
  let refresh = false;
  const issuer = "https://auth.gomining.example";
  const makeConnection = (provider) => {
    connections++;
    const transport = {
      async finishAuth(params) {
        assert.equal(params.get("code"), "test-code");
        assert.equal(params.get("iss"), issuer);
        assert.equal(provider.codeVerifier(), "test-verifier");
        assert.ok(provider.discoveryState());
        provider.saveTokens(
          {
            access_token: "test-access",
            refresh_token: "test-refresh",
            token_type: "Bearer",
          },
          { issuer },
        );
      },
    };
    const client = {
      async connect() {
        if (!provider.tokens()) {
          provider.saveClientInformation(
            { client_id: "test-client" },
            { issuer },
          );
          assert.equal(
            provider.clientInformation({ issuer: "https://other.example" }),
            undefined,
          );
          provider.saveDiscoveryState({ authorizationServerUrl: issuer });
          provider.saveCodeVerifier("test-verifier");
          await provider.redirectToAuthorization(
            new URL(`${issuer}/authorize?state=${provider.state()}`),
          );
          throw new UnauthorizedError();
        }
        if (refresh)
          provider.saveTokens(
            { access_token: "renewed-access", token_type: "Bearer" },
            { issuer },
          );
      },
      async listTools() {
        return {
          tools: [
            {
              name: "get_virtual_wallet_balances",
              inputSchema: {
                type: "object",
                ...(requiredArgument ? { required: ["wallet_id"] } : {}),
              },
            },
            { name: "get_account_summary" },
          ],
        };
      },
      async callTool(args) {
        calls++;
        assert.deepEqual(args, {
          name: "get_virtual_wallet_balances",
          arguments: {},
        });
        return { structuredContent: { balances: { BTC: "0.01", GMT: "5" } } };
      },
      async close() {},
    };
    return { client, transport };
  };
  const service = createGoMining({
    store,
    vault,
    makeConnection,
    now: () => time,
  });
  return {
    store,
    vault,
    service,
    setExpired: () => {
      time += 11 * 60000;
    },
    refresh: () => {
      refresh = true;
    },
    counts: () => ({ connections, calls }),
  };
}

test("OAuth binds state to the initiating session, persists encrypted credentials and refreshes without exposing tokens", async () => {
  const context = setup();
  const { store, vault, service } = context;
  try {
    const { authorizationUrl } = await service.begin({
      name: "Mon GoMining",
      session: "owner",
    });
    const params = new URLSearchParams({
      state: new URL(authorizationUrl).searchParams.get("state"),
      code: "test-code",
      iss: "https://auth.gomining.example",
    });
    await assert.rejects(
      service.complete({ params, session: "other" }),
      /session incorrecte/,
    );
    const { id } = await service.complete({ params, session: "owner" });
    assert.equal(context.counts().connections, 3);
    assert.equal(store.account(id).provider, "gomining");
    assert.equal(store.account(id).credentials.includes("test-access"), false);
    assert.equal(
      vault.decrypt(store.account(id).credentials).verifier,
      undefined,
    );
    assert.equal(
      JSON.stringify(buildPortfolio(store)).includes("test-refresh"),
      false,
    );
    await assert.rejects(
      service.complete({ params, session: "owner" }),
      /expiree/,
    );
    context.refresh();
    assert.deepEqual(await service.readBalances(store.account(id)), {
      BTC: 0.01,
      GOMINING: 5,
    });
    const saved = vault.decrypt(store.account(id).credentials);
    assert.equal(saved.tokens.access_token, "renewed-access");
    assert.equal(saved.tokens.refresh_token, "test-refresh");
    assert.equal(
      store.account(id).credentials.includes("renewed-access"),
      false,
    );
    const reconnect = await service.begin({
      name: "Mon GoMining",
      session: "owner",
      accountId: id,
    });
    await service.complete({
      session: "owner",
      params: new URLSearchParams({
        state: new URL(reconnect.authorizationUrl).searchParams.get("state"),
        code: "test-code",
        iss: "https://auth.gomining.example",
      }),
    });
    assert.equal(store.accounts().length, 1);
  } finally {
    store.close();
  }
});

test("expired consent and unsupported tool arguments never create a partial account", async () => {
  const context = setup({ requiredArgument: true });
  try {
    const { authorizationUrl } = await context.service.begin({
      name: "Test",
      session: "owner",
    });
    const params = new URLSearchParams({
      state: new URL(authorizationUrl).searchParams.get("state"),
      code: "test-code",
      iss: "https://auth.gomining.example",
    });
    await assert.rejects(
      context.service.complete({ params, session: "owner" }),
      /schema/,
    );
    assert.equal(context.counts().calls, 0);
    assert.equal(context.store.accounts().length, 0);
    const next = await context.service.begin({
      name: "Test",
      session: "owner",
    });
    params.set(
      "state",
      new URL(next.authorizationUrl).searchParams.get("state"),
    );
    context.setExpired();
    await assert.rejects(
      context.service.complete({ params, session: "owner" }),
      /expiree/,
    );
  } finally {
    context.store.close();
  }
});

test("public callback origin rejects remote HTTP and unexpected paths", () => {
  const context = setup();
  try {
    assert.throws(
      () => createGoMining({ ...context, publicUrl: "http://wallet.example" }),
      /PUBLIC_URL/,
    );
    assert.throws(
      () =>
        createGoMining({
          ...context,
          publicUrl: "https://wallet.example/path",
        }),
      /PUBLIC_URL/,
    );
  } finally {
    context.store.close();
  }
});

test("GoMining assets use an explicit token ID; ambiguous GRAM never falls back to a guessed token", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(
      JSON.stringify({
        "gmt-token": { eur: 0.3 },
        "explicit-gram-id": { eur: 1 },
      }),
    );
  };
  try {
    const providers = createProviders({});
    assert.equal(await providers.getPrice("GOMINING"), 0.3);
    assert.match(urls[0], /ids=gmt-token/);
    await assert.rejects(providers.getPrice("GRAM"), /GRAM non configure/);
    assert.equal(urls.length, 1);
    assert.equal(
      await createProviders(
        {},
        { gominingGramId: "explicit-gram-id" },
      ).getPrice("GRAM"),
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth API requires login, hands off callback safely and adds a collectible GoMining account", async () => {
  const context = setup();
  const collector = createCollector({
    store: context.store,
    readBalances: context.service.readBalances,
    getPrice: async () => 1,
  });
  const server = createApp({
    ...context,
    gomining: context.service,
    collector,
    password: "a-long-test-password",
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, cookie) =>
    fetch(base + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request("/api/gomining/authorize", { name: "Test" })).status,
      401,
    );
    const login = await request("/api/login", {
      password: "a-long-test-password",
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await request(
          "/api/accounts",
          {
            name: "Bypass",
            provider: "gomining",
            apiKey: "fake",
            secret: "fake",
          },
          cookie,
        )
      ).status,
      400,
    );
    const started = await request(
      "/api/gomining/authorize",
      { name: "Mon GoMining" },
      cookie,
    );
    assert.equal(started.status, 200);
    const { authorizationUrl } = await started.json();
    const body = {
      state: new URL(authorizationUrl).searchParams.get("state"),
      code: "test-code",
      iss: "https://auth.gomining.example",
    };
    const handoff = await fetch(
      `${base}/oauth/gomining/callback?${new URLSearchParams(body)}`,
      { redirect: "manual" },
    );
    assert.equal(handoff.status, 303);
    assert.match(
      handoff.headers.get("location"),
      /^http:\/\/localhost:3080\/#gomining-callback\?/,
    );
    assert.equal(handoff.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await request("/api/gomining/callback", body)).status, 401);
    const completed = await request("/api/gomining/callback", body, cookie);
    assert.equal(completed.status, 201);
    const { id } = await completed.json();
    assert.equal(
      (await request("/api/gomining/callback", body, cookie)).status,
      400,
    );
    assert.equal((await collector.collect()).results[0].ok, true);
    const portfolio = await (
      await fetch(`${base}/api/portfolio`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(portfolio.accounts[0].provider, "gomining");
    assert.equal(portfolio.total, 5.01);
    assert.equal(JSON.stringify(portfolio).includes("test-access"), false);
    const adapters = createProviders(context.vault, {
      gomining: context.service,
    });
    assert.deepEqual(await adapters.readBalances(context.store.account(id)), {
      BTC: 0.01,
      GOMINING: 5,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    context.store.close();
  }
});

test("official SDK performs discovery, PKCE registration, fresh transport connection and refresh", async () => {
  const store = createStore();
  const vault = createVault(randomBytes(32).toString("base64"));
  const originalFetch = globalThis.fetch;
  const issuer = "https://auth.gomining.example";
  let refreshRequired = false;
  const grants = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    if (url.pathname.includes(".well-known/oauth-protected-resource")) {
      return json({
        resource: "https://mcp.gomining.com/mcp",
        authorization_servers: [issuer],
        scopes_supported: ["wallet:read"],
      });
    }
    if (url.pathname.includes(".well-known/oauth-authorization-server")) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.href === `${issuer}/register`) {
      const registration = JSON.parse(init.body);
      assert.equal(
        registration.redirect_uris[0],
        "http://localhost:3080/oauth/gomining/callback",
      );
      return json({ ...registration, client_id: "sdk-client" }, 201);
    }
    if (url.href === `${issuer}/token`) {
      const params = new URLSearchParams(init.body);
      grants.push(params.get("grant_type"));
      if (params.get("grant_type") === "authorization_code") {
        assert.ok(params.get("code_verifier"));
        assert.equal(params.get("resource"), "https://mcp.gomining.com/mcp");
        return json({
          access_token: "sdk-access",
          refresh_token: "sdk-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      assert.equal(params.get("refresh_token"), "sdk-refresh");
      return json({
        access_token: "sdk-renewed",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    assert.equal(url.href, "https://mcp.gomining.com/mcp");
    const authorization = headers.get("authorization");
    if (
      !authorization ||
      (refreshRequired && authorization === "Bearer sdk-access")
    ) {
      return new Response("", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://mcp.gomining.com/.well-known/oauth-protected-resource"',
        },
      });
    }
    if (init.method === "GET") return new Response("", { status: 405 });
    const request = JSON.parse(init.body);
    if (request.id === undefined) return new Response(null, { status: 202 });
    const results = {
      initialize: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "gomining-test", version: "1" },
      },
      "tools/list": {
        tools: [
          {
            name: "get_virtual_wallet_balances",
            inputSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {},
            },
          },
        ],
      },
      "tools/call": {
        content: [],
        structuredContent: { balances: { BTC: "0.02", GMT: "7" } },
      },
    };
    assert.ok(
      results[request.method],
      `Unexpected MCP method: ${request.method}`,
    );
    return json({
      jsonrpc: "2.0",
      id: request.id,
      result: results[request.method],
    });
  };
  try {
    const service = createGoMining({ store, vault });
    const { authorizationUrl } = await service.begin({
      name: "SDK integration",
      session: "sdk-owner",
    });
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.origin, issuer);
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.ok(authorization.searchParams.get("code_challenge"));
    const { id } = await service.complete({
      session: "sdk-owner",
      params: new URLSearchParams({
        state: authorization.searchParams.get("state"),
        code: "sdk-code",
        iss: issuer,
      }),
    });
    refreshRequired = true;
    assert.deepEqual(await service.readBalances(store.account(id)), {
      BTC: 0.02,
      GOMINING: 7,
    });
    const credentials = vault.decrypt(store.account(id).credentials);
    assert.equal(credentials.tokens.access_token, "sdk-renewed");
    assert.equal(credentials.tokens.refresh_token, "sdk-refresh");
    assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
    const savedCredentials = store.account(id).credentials;
    const retry = await service.begin({
      name: "SDK integration",
      session: "sdk-owner",
      accountId: id,
    });
    await assert.rejects(
      service.complete({
        session: "sdk-owner",
        params: new URLSearchParams({
          state: new URL(retry.authorizationUrl).searchParams.get("state"),
          code: "sdk-code",
          iss: "https://wrong-issuer.example",
        }),
      }),
      /echange OAuth impossible/,
    );
    assert.equal(store.account(id).credentials, savedCredentials);
    assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
