export function createCollector({
  store,
  readBalances,
  getPrice,
  now = () => new Date().toISOString(),
}) {
  let running = false;
  return {
    get running() {
      return running;
    },
    async collect() {
      if (running) return { busy: true, results: [] };
      running = true;
      const capturedAt = now();
      const results = [];
      const prices = new Map();
      try {
        for (const account of store.accounts()) {
          try {
            const balances = await readBalances(account);
            const holdings = [];
            for (const [asset, quantity] of Object.entries(balances)) {
              if (!Number.isFinite(quantity))
                throw new Error("Invalid balance");
              if (quantity === 0) continue;
              if (!prices.has(asset)) prices.set(asset, await getPrice(asset));
              holdings.push({ asset, quantity, price: prices.get(asset) });
            }
            store.recordSnapshot(account.id, capturedAt, holdings);
            store.recordAttempt(account.id, capturedAt);
            results.push({ id: account.id, ok: true });
          } catch {
            store.recordAttempt(
              account.id,
              capturedAt,
              "Collecte impossible. Verifiez les droits de lecture, les actifs pris en charge et la disponibilite du fournisseur.",
            );
            results.push({ id: account.id, ok: false });
          }
        }
        return { busy: false, results };
      } finally {
        running = false;
      }
    },
  };
}
