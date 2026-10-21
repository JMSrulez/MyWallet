import ccxt from "ccxt";

export const providers = [
  { id: "okx", name: "OKX", passphrase: true },
  { id: "kraken", name: "Kraken", passphrase: false },
  { id: "coinbase", name: "Coinbase", passphrase: false },
];

export function createProviders(vault) {
  const pricing = new ccxt.kraken({ enableRateLimit: true, timeout: 20000 });
  return {
    async readBalances(account) {
      const credentials = vault.decrypt(account.credentials);
      const Exchange = ccxt[account.provider];
      const client = new Exchange({
        ...credentials,
        enableRateLimit: true,
        timeout: 20000,
        options: { defaultType: "spot" },
      });
      try {
        const balances = await client.fetchBalance();
        return balances.total;
      } finally {
        await client.close();
      }
    },
    async getPrice(asset) {
      if (asset === "EUR") return 1;
      await pricing.loadMarkets();
      const rate = async (symbol) => {
        const ticker = await pricing.fetchTicker(symbol);
        if (!Number.isFinite(ticker.last) || ticker.last <= 0)
          throw new Error("Price unavailable");
        return ticker.last;
      };
      if (pricing.markets[`${asset}/EUR`]) return rate(`${asset}/EUR`);
      if (pricing.markets[`EUR/${asset}`])
        return 1 / (await rate(`EUR/${asset}`));
      const usdToEur = 1 / (await rate("EUR/USD"));
      if (asset === "USD") return usdToEur;
      if (pricing.markets[`${asset}/USD`])
        return (await rate(`${asset}/USD`)) * usdToEur;
      throw new Error("Unsupported asset");
    },
    close: () => pricing.close(),
  };
}
