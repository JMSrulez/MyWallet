import ccxt from "ccxt";
import { holdingValue } from "./holdings.js";
import { createEthereum, isEthereumToken } from "./ethereum.js";
import { createViaBtc } from "./viabtc.js";
import { readGateSpot } from "./gate.js";

export const providers = [
  { id: "okx", name: "OKX", passphrase: true },
  { id: "kraken", name: "Kraken", passphrase: false },
  { id: "coinbase", name: "Coinbase", passphrase: false },
  { id: "gomining", name: "GoMining", authType: "oauth", scope: "wallet" },
  { id: "ethereum", name: "MetaMask / Ethereum", authType: "address" },
  { id: "viabtc", name: "ViaBTC", authType: "apiKey", secret: false },
  { id: "gate", name: "Gate.io (international)", passphrase: false },
  { id: "gateeu", name: "Gate EU (Europe)", passphrase: false },
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
  GT: "gatechain-token",
};

export function createProviders(vault, options = {}) {
  const ethereum = createEthereum(vault);
  const viabtc = createViaBtc(vault);
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

  function exchangeClient(account) {
    const credentials = vault.decrypt(account.credentials);
    const Exchange = ccxt[account.provider];
    if (!Exchange) throw new Error(`Fournisseur inconnu: ${account.provider}`);
    return new Exchange({
      ...credentials,
      ...(account.provider === "okx" ? { hostname: okxHostname } : {}),
      enableRateLimit: true,
      timeout: 20000,
      options: { defaultType: "spot" },
    });
  }

  return {
    describeAsset: (asset, account) => account.provider === "ethereum"
      ? ethereum.describeAsset(asset, account) : {},

    async preparePrices(balances, provider) {
      if (provider !== "ethereum") return;
      const assets = Object.keys(balances).filter((asset) => isEthereumToken(asset) &&
        balances[asset] > 0 && !(priceCache.get(asset)?.expires > Date.now()));
      // Chunk below CoinGecko's documented 515-address maximum to keep URLs short.
      for (let offset = 0; offset < assets.length; offset += 50) {
        const batch = assets.slice(offset, offset + 50);
        const addresses = batch.map((asset) => asset.slice(6));
        const data = await cgFetch(`/simple/token_price/ethereum?contract_addresses=${addresses.join(",")}&vs_currencies=eur`);
        if (!data || typeof data !== "object" || Array.isArray(data) || data.error || data.status?.error_code)
          throw new Error("Ethereum: reponse de prix CoinGecko invalide.");
        const indexed = new Map(Object.entries(data).map(([key, value]) => [key.toLowerCase(), value]));
        for (const asset of batch) {
          const price = indexed.get(asset.slice(6))?.eur;
          if (price !== undefined && price !== null && (!Number.isFinite(price) || price < 0))
            throw new Error("Ethereum: prix ERC-20 invalide.");
          priceCache.set(asset, { price: Number.isFinite(price) && price > 0 ? price : null,
            expires: Date.now() + CACHE_TTL_MS });
        }
      }
    },

    async readValuations(account, holdings = []) {
      if (account.provider === "ethereum") return ethereum.extraHoldings(account);
      if (account.provider !== "okx") return [];
      const client = exchangeClient(account);
      try {
        // This endpoint already partitions trading, funding and Earn. Only
        // details.earn is additive to the token balances collected below.
        const response = await client.privateGetAssetAssetValuation({ ccy: "EUR" });
        const amount = response?.data?.[0]?.details?.earn;
        if (
          response?.code !== "0" ||
          !Array.isArray(response.data) || response.data.length !== 1 ||
          typeof amount !== "string" ||
          !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) ||
          !Number.isFinite(Number(amount))
        ) throw new Error("OKX Earn: valorisation EUR absente ou invalide.");
        const value = Number(amount);
        console.log(`[okx] ${account.name}: Earn = ${value.toFixed(2)} EUR (valorisation OKX)`);
        const valuations = [{ asset: "OKX_EARN", valuationOnly: true, currency: "EUR", value }];
        if (holdings.some((item) => item.asset === "LYUSDC" && item.quantity > 0)) {
          // A receipt may also be represented by Earn. The public API does not
          // identify that overlap. Reconcile against OKX's total instead of
          // assuming that the receipt is always included (or always excluded).
          const totalAmount = response.data[0].totalBal;
          if (
            typeof totalAmount !== "string" ||
            !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(totalAmount) ||
            !Number.isFinite(Number(totalAmount))
          ) throw new Error("OKX LYUSDC: total EUR requis pour eviter un double comptage.");
          const reportedTotal = Number(totalAmount);
          const estimatedTotal = [...holdings, ...valuations].reduce((sum, item) => sum + holdingValue(item), 0);
          if (!Number.isFinite(estimatedTotal)) throw new Error("OKX LYUSDC: estimation EUR invalide.");
          const adjustment = reportedTotal - estimatedTotal;
          if (Math.abs(adjustment) > 1e-8) valuations.push({
            asset: "OKX_RECONCILIATION", valuationOnly: true, currency: "EUR", value: adjustment,
          });
          console.log(`[okx] ${account.name}: total OKX = ${reportedTotal.toFixed(2)} EUR, ajustement = ${adjustment.toFixed(2)} EUR (LYUSDC/Earn)`);
        }
        return valuations;
      } finally {
        await client.close();
      }
    },

    async readBalances(account) {
      if (account.provider === "viabtc") return viabtc.readBalances(account);
      if (account.provider === "ethereum") return ethereum.readBalances(account);
      if (account.provider === "gomining") {
        if (!options.gomining)
          throw new Error("GoMining: connecteur indisponible.");
        return options.gomining.readBalances(account);
      }
      console.log(`[${account.provider}] Lecture soldes: ${account.name}`);
      const client = exchangeClient(account);
      try {
        if (account.provider === "gate" || account.provider === "gateeu")
          return await readGateSpot(client);
        const balances = await client.fetchBalance();
        let totals = balances.total;
        if (account.provider === "okx") {
          const funding = await client.fetchBalance({ type: "funding" });
          const combined = new Map();
          for (const bucket of [totals, funding.total]) {
            if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
              throw new Error("OKX: soldes trading/financement invalides.");
            for (const [asset, quantity] of Object.entries(bucket)) {
              if (!Number.isFinite(quantity))
                throw new Error(`Solde invalide pour ${asset}`);
              const total = (combined.get(asset) ?? 0) + quantity;
              if (!Number.isFinite(total))
                throw new Error(`Solde invalide pour ${asset}`);
              combined.set(asset, total);
            }
          }
          totals = Object.fromEntries(combined);
        }
        if (account.provider === "kraken" && totals) {
          const combined = new Map();
          for (const [asset, quantity] of Object.entries(totals)) {
            if (!Number.isFinite(quantity))
              throw new Error(`Solde invalide pour ${asset}`);
            // Kraken reports separate staking/rewards balances for the same coin.
            // Only documented balance suffixes are folded; tokenized .T assets
            // and unknown suffixes must keep their distinct identity.
            const symbol = asset === "ETH2.S"
              ? "ETH"
              : asset.replace(/^([^.]+)\.(?:S|M|B|F|P)$/, "$1");
            const total = (combined.get(symbol) ?? 0) + quantity;
            if (!Number.isFinite(total))
              throw new Error(`Solde invalide pour ${symbol}`);
            combined.set(symbol, total);
          }
          totals = Object.fromEntries(combined);
        }
        const nonZero = Object.entries(totals || {}).filter(
          ([, q]) => Number.isFinite(q) && q > 0,
        );
        console.log(
          `[${account.provider}] ${account.name}: ${nonZero.length} actif(s) non nuls -> ${nonZero.map(([a]) => a).join(", ") || "(aucun)"}`,
        );
        return totals;
      } finally {
        await client.close();
      }
    },

    async getPrice(asset, provider) {
      if (provider === "ethereum" && isEthereumToken(asset)) {
        if (!(priceCache.get(asset)?.expires > Date.now()))
          throw new Error("Ethereum: prix ERC-20 non prepares.");
        return priceCache.get(asset).price;
      }
      // Explicit OKX receipt mapping only; never infer parity from a suffix.
      const symbol = provider === "okx" && asset === "LYUSDC"
        ? "USDC"
        : String(asset).toUpperCase();
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
