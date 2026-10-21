const demoAccounts = [
  {
    id: "demo-okx",
    name: "Mon compte OKX",
    provider: "okx",
    amounts: { BTC: 0.72, ETH: 6.4, USDT: 2400 },
  },
  {
    id: "demo-kraken",
    name: "Mon compte Kraken",
    provider: "kraken",
    amounts: { BTC: 0.31, ETH: 4.8, SOL: 82 },
  },
  {
    id: "demo-coinbase",
    name: "Mon compte Coinbase",
    provider: "coinbase",
    amounts: { BTC: 0.18, ETH: 3.2, SOL: 42, EUR: 1800 },
  },
];
const prices = { BTC: 62480, ETH: 2380, SOL: 148.5, USDT: 0.92, EUR: 1 };

export function seedDemo(store) {
  if (store.accounts().length) return;
  const end = new Date();
  for (const account of demoAccounts) {
    store.addAccount({
      ...account,
      credentials: "demo",
      created_at: new Date(end.getTime() - 90 * 86400000).toISOString(),
    });
  }
  for (let day = 90; day >= 0; day--) {
    const capturedAt = new Date(end.getTime() - day * 86400000).toISOString();
    const growth =
      1 -
      day * 0.0018 +
      Math.sin(day * 0.65) * 0.013 +
      Math.sin(day * 0.19) * 0.025;
    for (const account of demoAccounts) {
      store.recordSnapshot(
        account.id,
        capturedAt,
        Object.entries(account.amounts).map(([asset, quantity]) => ({
          asset,
          quantity,
          price:
            prices[asset] * (asset === "EUR" || asset === "USDT" ? 1 : growth),
        })),
      );
      store.recordAttempt(account.id, capturedAt);
    }
  }
}
