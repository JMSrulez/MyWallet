import { holdingValue } from "./holdings.js";

export function createCollector({
  store,
  readBalances,
  readValuations = async () => [],
  getPrice,
  now = () => new Date().toISOString(),
}) {
  let running = false;
  return {
    get running() {
      return running;
    },
    async collect() {
      if (running) {
        console.log("[collect] Deja en cours, ignore.");
        return { busy: true, results: [] };
      }
      running = true;
      const capturedAt = now();
      const results = [];
      const prices = new Map();
      console.log(
        `[collect] Demarrage (${store.accounts().length} compte(s))...`,
      );
      try {
        for (const account of store.accounts()) {
          try {
            const balances = await readBalances(account);
            const holdings = [];
            for (const [asset, quantity] of Object.entries(balances)) {
              if (!Number.isFinite(quantity))
                throw new Error(`Solde invalide pour ${asset}`);
              if (quantity === 0) continue;
              if (!prices.has(asset)) {
                const price = await getPrice(asset);
                prices.set(asset, price);
              }
              holdings.push({
                asset,
                quantity,
                price: prices.get(asset),
              });
            }
            holdings.push(...await readValuations(account));
            store.recordSnapshot(account.id, capturedAt, holdings);
            store.recordAttempt(account.id, capturedAt);
            const total = holdings.reduce(
              (s, h) => s + holdingValue(h),
              0,
            );
            console.log(
              `[collect] OK ${account.provider}/${account.name}: ${holdings.length} actif(s), ${total.toFixed(2)} EUR`,
            );
            results.push({ id: account.id, ok: true });
          } catch (error) {
            const message = error?.message || String(error);
            console.error(
              `[collect] ECHEC ${account.provider}/${account.name}: ${message}`,
            );
            store.recordAttempt(account.id, capturedAt, message);
            results.push({ id: account.id, ok: false });
          }
        }
        const ok = results.filter((r) => r.ok).length;
        const ko = results.length - ok;
        console.log(`[collect] Termine: ${ok} OK, ${ko} echec(s)`);
        return { busy: false, results };
      } finally {
        running = false;
      }
    },
  };
}
