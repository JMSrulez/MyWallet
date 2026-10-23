import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

export const GOMINING_URL = "https://mcp.gomining.com/mcp";
const WALLET_TOOL = "get_virtual_wallet_balances";
const allowedAssets = new Set([
  "BTC",
  "GMT",
  "GOMINING",
  "USDT",
  "USDC",
  "ETH",
  "BNB",
  "SOL",
  "GRAM",
]);
const validateSchema = new Ajv({ strict: false, validateFormats: false });
const validateModernSchema = new Ajv2020({
  strict: false,
  validateFormats: false,
});
const sessionHash = (session) =>
  createHash("sha256").update(session).digest("hex");
export class GoMiningError extends Error {}
const failure = (detail) => new GoMiningError(`GoMining: ${detail}`);

export function parseGoMiningBalances(result) {
  if (result?.isError) throw failure("outil de soldes en erreur.");
  let payload = result?.structuredContent;
  if (!payload) {
    const texts = result?.content?.filter((item) => item.type === "text");
    if (texts?.length !== 1) throw failure("format de soldes non reconnu.");
    try {
      payload = JSON.parse(texts[0].text);
    } catch {
      throw failure("la reponse de soldes doit etre du JSON.");
    }
  }
  if (!payload || typeof payload !== "object")
    throw failure("format de soldes non reconnu.");
  if (payload.data && typeof payload.data === "object") payload = payload.data;
  const wrapped = Object.hasOwn(payload, "balances");
  const rows = wrapped ? payload.balances : payload;
  const balances = {};
  const append = (asset, value) => {
    if (typeof asset !== "string" || !allowedAssets.has(asset.toUpperCase())) {
      throw failure("actif du wallet non pris en charge.");
    }
    const symbol =
      asset.toUpperCase() === "GMT" ? "GOMINING" : asset.toUpperCase();
    if (Object.hasOwn(balances, symbol))
      throw failure("actif duplique dans les soldes.");
    if (
      typeof value !== "number" &&
      (typeof value !== "string" ||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))
    ) {
      throw failure("quantite de wallet invalide.");
    }
    const quantity = Number(value);
    if (!Number.isFinite(quantity) || quantity < 0)
      throw failure("quantite de wallet invalide.");
    balances[symbol] = quantity;
  };
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== "object")
        throw failure("ligne de solde non reconnue.");
      append(
        row.asset ?? row.currency ?? row.symbol,
        row.total ?? row.balance ?? row.amount,
      );
    }
  } else if (rows && typeof rows === "object") {
    const entries = Object.entries(rows);
    if (!wrapped && entries.length === 0)
      throw failure("reponse vide non reconnue.");
    for (const [asset, value] of entries) {
      append(
        asset,
        typeof value === "object" && value !== null
          ? (value.total ?? value.balance ?? value.amount)
          : value,
      );
    }
  } else {
    throw failure("format de soldes non reconnu.");
  }
  return balances;
}

function connection(authProvider) {
  const transport = new StreamableHTTPClientTransport(new URL(GOMINING_URL), {
    authProvider,
    fetch: (url, init = {}) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(20000),
          ...(init.signal ? [init.signal] : []),
        ]),
      }),
  });
  return {
    client: new Client({ name: "mywallet", version: "0.2.0" }),
    transport,
  };
}

function oauthProvider({
  data,
  redirectUrl,
  state,
  onRedirect,
  persist = () => {},
}) {
  return {
    redirectUrl,
    clientMetadata: {
      client_name: "MyWallet",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type:
        new URL(redirectUrl).protocol === "https:" ? "web" : "native",
    },
    state: () => state,
    clientInformation: (context) =>
      context ? data.clients?.[context.issuer] : undefined,
    saveClientInformation(info, context) {
      if (!context?.issuer) throw failure("emetteur OAuth absent.");
      data.clients ??= {};
      data.clients[context.issuer] = info;
      persist();
    },
    tokens: (context) =>
      !context || context.issuer === data.tokenIssuer ? data.tokens : undefined,
    saveTokens(tokens, context) {
      const issuer = context?.issuer ?? tokens.issuer;
      if (!issuer) throw failure("emetteur des jetons absent.");
      const prior = issuer === data.tokenIssuer ? data.tokens : undefined;
      data.tokens = {
        ...tokens,
        ...(tokens.refresh_token || prior?.refresh_token
          ? { refresh_token: tokens.refresh_token ?? prior.refresh_token }
          : {}),
      };
      data.tokenIssuer = issuer;
      persist();
    },
    saveDiscoveryState(discovery) {
      data.discovery = discovery;
      persist();
    },
    discoveryState: () => data.discovery,
    redirectToAuthorization(url) {
      if (url.protocol !== "https:")
        throw failure("URL d'autorisation non securisee.");
      onRedirect(url.href);
    },
    saveCodeVerifier(verifier) {
      data.verifier = verifier;
    },
    codeVerifier() {
      if (!data.verifier) throw failure("verificateur PKCE absent.");
      return data.verifier;
    },
    invalidateCredentials(scope) {
      if (scope === "all" || scope === "tokens") {
        delete data.tokens;
        delete data.tokenIssuer;
      }
      if (scope === "all" || scope === "client") delete data.clients;
      if (scope === "all" || scope === "verifier") delete data.verifier;
      if (scope === "all" || scope === "discovery") delete data.discovery;
      persist();
    },
  };
}

export function createGoMining({
  store,
  vault,
  publicUrl = "http://localhost:3080",
  makeConnection = connection,
  now = Date.now,
}) {
  const origin = new URL(publicUrl);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  ) {
    throw new Error(
      "PUBLIC_URL must be an HTTPS origin or a local HTTP origin.",
    );
  }
  const redirectUrl = new URL("/oauth/gomining/callback", origin).href;
  const pending = new Map();
  const cleanup = () => {
    for (const [state, flow] of pending)
      if (flow.expires <= now()) pending.delete(state);
  };
  const close = async (client) => {
    try {
      await client.close();
    } catch {}
  };
  const walletBalances = async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === WALLET_TOOL);
    if (!tool) throw failure("outil de soldes absent du serveur.");
    let acceptsEmpty = false;
    try {
      const validator = tool.inputSchema?.$schema?.includes("draft-07")
        ? validateSchema
        : validateModernSchema;
      acceptsEmpty = validator.compile(tool.inputSchema)({});
    } catch {}
    if (!acceptsEmpty)
      throw failure("le schema de soldes exige des arguments non configures.");
    const result = await client.callTool({ name: WALLET_TOOL, arguments: {} });
    return parseGoMiningBalances(result);
  };
  return {
    redirectUrl,
    async begin({ name, session, accountId }) {
      cleanup();
      if (
        !session ||
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 60
      )
        throw failure("connexion locale et nom de compte requis.");
      const account = accountId ? store.account(accountId) : null;
      if (accountId && account?.provider !== "gomining")
        throw failure("compte introuvable.");
      if (!accountId && store.accounts().length >= 30)
        throw failure("limite de comptes atteinte.");
      const owner = sessionHash(session);
      for (const [state, flow] of pending)
        if (flow.owner === owner) pending.delete(state);
      if (pending.size >= 30) throw failure("trop de connexions en attente.");
      const state = randomBytes(32).toString("hex");
      const flow = {
        state,
        owner,
        name: name.trim(),
        accountId,
        data: {},
        expires: now() + 10 * 60000,
      };
      const provider = oauthProvider({
        data: flow.data,
        state,
        redirectUrl,
        onRedirect: (url) => {
          flow.authorizationUrl = url;
        },
      });
      const { client, transport } = makeConnection(provider);
      try {
        await client.connect(transport);
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || !flow.authorizationUrl)
          throw failure("autorisation indisponible. Reessayez plus tard.");
      } finally {
        await close(client);
      }
      if (!flow.authorizationUrl)
        throw failure("le serveur n'a pas demande d'autorisation.");
      pending.set(state, flow);
      return { authorizationUrl: flow.authorizationUrl };
    },
    async complete({ params, session }) {
      cleanup();
      const state = params.get("state");
      const flow = pending.get(state);
      if (!flow || !session || flow.owner !== sessionHash(session))
        throw failure(
          "autorisation expiree ou session incorrecte. Reconnectez le compte.",
        );
      pending.delete(state);
      if (
        params.has("error") ||
        !params.get("code") ||
        params.get("code").length > 4096
      )
        throw failure("autorisation refusee ou incomplete.");
      if (
        flow.accountId &&
        store.account(flow.accountId)?.provider !== "gomining"
      )
        throw failure("compte supprime pendant l'autorisation.");
      if (!flow.accountId && store.accounts().length >= 30)
        throw failure("limite de comptes atteinte.");
      const provider = oauthProvider({
        data: flow.data,
        state,
        redirectUrl,
        onRedirect: () => {
          throw failure("autorisation a renouveler.");
        },
      });
      const authConnection = makeConnection(provider);
      try {
        await authConnection.transport.finishAuth(params);
      } catch {
        throw failure("echange OAuth impossible. Reconnectez le compte.");
      } finally {
        await close(authConnection.client);
      }
      if (!flow.data.tokens?.access_token)
        throw failure("jeton d'acces absent.");
      const { client, transport } = makeConnection(provider);
      try {
        await client.connect(transport);
        await walletBalances(client);
      } catch (error) {
        throw error instanceof GoMiningError
          ? error
          : failure(
              "verification du wallet impossible. Reconnectez le compte.",
            );
      } finally {
        await close(client);
      }
      delete flow.data.verifier;
      const credentials = vault.encrypt(flow.data);
      const id = flow.accountId ?? randomUUID();
      if (flow.accountId) {
        if (!store.updateCredentials(id, credentials))
          throw failure("compte supprime.");
      } else {
        store.addAccount({
          id,
          name: flow.name,
          provider: "gomining",
          credentials,
          created_at: new Date(now()).toISOString(),
        });
      }
      return { id };
    },
    async readBalances(account) {
      try {
        const current = store.account(account.id);
        if (current?.provider !== "gomining")
          throw failure("compte introuvable.");
        const data = vault.decrypt(current.credentials);
        if (!data.tokens) throw failure("autorisation a renouveler.");
        const persist = () => {
          if (!store.updateCredentials(account.id, vault.encrypt(data)))
            throw failure("compte supprime.");
        };
        const provider = oauthProvider({
          data,
          redirectUrl,
          persist,
          onRedirect: () => {
            throw failure("autorisation a renouveler.");
          },
        });
        const { client, transport } = makeConnection(provider);
        try {
          await client.connect(transport);
          return await walletBalances(client);
        } finally {
          await close(client);
        }
      } catch (error) {
        if (error instanceof GoMiningError) throw error;
        throw failure(
          "lecture du wallet impossible. Verifiez la connexion ou renouvelez l'autorisation.",
        );
      }
    },
  };
}
