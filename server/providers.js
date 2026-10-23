import ccxt from "ccxt";

export const providers = [
  { id: "okx", name: "OKX", passphrase: true },
  { id: "kraken", name: "Kraken", passphrase: false },
  { id: "coinbase", name: "Coinbase", passphrase: false },
  { id: "gomining", name: "GoMining", authType: "oauth", scope: "wallet" },
];

/** Symboles courants -> id CoinGecko (evite les collisions BTC/ETH/...). */
const KNOWN_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  ATOM: "cosmos",
  UNI: "uniswap",
  AAVE: "aave",
  MKR: "maker",
  CRV: "curve-dao-token",
  SNX: "havven",
  COMP: "compound-governance-token",
  SUSHI: "sushi",
  YFI: "yearn-finance",
  USDT: "tether",
  USDC: "usd-coin",
  DAI: "dai",
  EURC: "euro-coin",
  EURT: "tether-eurt",
  WBTC: "wrapped-bitcoin",
  STETH: "staked-ether",
  CBETH: "coinbase-wrapped-staked-eth",
  RETH: "rocket-pool-eth",
  WETH: "weth",
  ARB: "arbitrum",
  OP: "optimism",
  APT: "aptos",
  SUI: "sui",
  NEAR: "near",
  FIL: "filecoin",
  ICP: "internet-computer",
  HBAR: "hedera-hashgraph",
  ALGO: "algorand",
  XLM: "stellar",
  TRX: "tron",
  TON: "the-open-network",
  SHIB: "shiba-inu",
  PEPE: "pepe",
  BONK: "bonk",
  RENDER: "render-token",
  FET: "fetch-ai",
  INJ: "injective-protocol",
  SEI: "sei-network",
  TIA: "celestia",
  PYTH: "pyth-network",
  JUP: "jupiter-exchange-solana",
  WIF: "dogwifcoin",
  BNB: "binancecoin",
  GOMINING: "gmt-token",
};

export function createProviders(vault, options = {}) {
  const okxHostname = options.okxHostname ?? process.env.OKX_HOSTNAME ?? "www.okx.com";
  if (!["www.okx.com", "eea.okx.com", "us.okx.com"].includes(okxHostname))
    throw new Error("OKX_HOSTNAME must be www.okx.com, eea.okx.com or us.okx.com.");
  const gramId =
    options.gominingGramId || process.env.GOMINING_GRAM_COINGECKO_ID;
  if (gramId && !/^[a-z0-9-]{1,100}$/.test(gramId))
    throw new Error("Invalid GOMINING_GRAM_COINGECKO_ID.");
  const apiKey = options.coingeckoApiKey || process.env.COINGECKO_API_KEY || "";
  const apiType = (
    options.coingeckoApiType ||
    process.env.COINGECKO_API_TYPE ||
    "demo"
  ).toLowerCase();

  const baseUrl =
    apiType === "pro"
      ? "https://pro-api.coingecko.com/api/v3"
      : "https://api.coingecko.com/api/v3";

  const headers = { Accept: "application/json" };
  if (apiKey) {
    if (apiType === "pro") headers["x-cg-pro-api-key"] = apiKey;
    else headers["x-cg-demo-api-key"] = apiKey;
  }

  let coinListPromise = null;
  const priceCache = new Map();
  const CACHE_TTL_MS = 60_000;

  async function cgFetch(path) {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CoinGecko HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async function loadCoinList() {
    if (!coinListPromise) {
      coinListPromise = cgFetch("/coins/list").then((list) => {
        const bySymbol = new Map();
        for (const coin of list) {
          const sym = String(coin.symbol || "").toUpperCase();
          if (!sym) continue;
          if (!bySymbol.has(sym)) bySymbol.set(sym, []);
          bySymbol.get(sym).push(coin);
        }
        console.log(`[prices] Liste CoinGecko chargee (${list.length} coins)`);
        return bySymbol;
      });
    }
    return coinListPromise;
  }

  async function resolveId(asset) {
    const symbol = String(asset).toUpperCase();
    if (KNOWN_IDS[symbol]) return KNOWN_IDS[symbol];
    const bySymbol = await loadCoinList();
    const candidates = bySymbol.get(symbol) || [];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.id.length - b.id.length);
    return candidates[0].id;
  }

  return {
    async readBalances(account) {
      if (account.provider === "gomining") {
        if (!options.gomining)
          throw new Error("GoMining: connecteur indisponible.");
        return options.gomining.readBalances(account);
      }
      const credentials = vault.decrypt(account.credentials);
      const Exchange = ccxt[account.provider];
      if (!Exchange)
        throw new Error(`Fournisseur inconnu: ${account.provider}`);
      console.log(`[${account.provider}] Lecture soldes: ${account.name}`);
      const client = new Exchange({
        ...credentials,
        ...(account.provider === "okx" ? { hostname: okxHostname } : {}),
        enableRateLimit: true,
        timeout: 20000,
        options: { defaultType: "spot" },
      });
      try {
        const balances = await client.fetchBalance();
        const nonZero = Object.entries(balances.total || {}).filter(
          ([, q]) => Number.isFinite(q) && q > 0,
        );
        console.log(
          `[${account.provider}] ${account.name}: ${nonZero.length} actif(s) non nuls -> ${nonZero.map(([a]) => a).join(", ") || "(aucun)"}`,
        );
        return balances.total;
      } finally {
        await client.close();
      }
    },

    async getPrice(asset) {
      const symbol = String(asset).toUpperCase();
      if (symbol === "EUR") return 1;

      const cached = priceCache.get(symbol);
      if (cached && cached.expires > Date.now()) return cached.price;

      if (symbol === "USD") {
        const data = await cgFetch(
          "/simple/price?ids=tether&vs_currencies=eur",
        );
        const usdtEur = data?.tether?.eur;
        if (!Number.isFinite(usdtEur) || usdtEur <= 0)
          throw new Error("Prix USD/EUR indisponible");
        const price = usdtEur;
        priceCache.set(symbol, { price, expires: Date.now() + CACHE_TTL_MS });
        return price;
      }

      if (symbol === "GRAM" && !gramId)
        throw new Error(
          "GoMining: prix GRAM non configure (GOMINING_GRAM_COINGECKO_ID).",
        );
      const id = symbol === "GRAM" ? gramId : await resolveId(symbol);
      if (!id)
        throw new Error(`Unsupported asset: ${symbol} (inconnu sur CoinGecko)`);

      const data = await cgFetch(
        `/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=eur`,
      );
      const price = data?.[id]?.eur;
      if (!Number.isFinite(price) || price <= 0)
        throw new Error(
          `Unsupported asset: ${symbol} (pas de prix EUR pour ${id})`,
        );

      console.log(`[prices] ${symbol} (${id}) = ${price} EUR`);
      priceCache.set(symbol, { price, expires: Date.now() + CACHE_TTL_MS });
      return price;
    },

    close: async () => {},
  };
}
