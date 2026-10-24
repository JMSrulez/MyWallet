import { holdingValue } from "./holdings.js";

export function createCollector({
  store,
  readBalances,
  preparePrices = async () => {},
  describeAsset = () => ({}),
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
            await preparePrices(balances, account.provider);
            const holdings = [];
            for (const [asset, quantity] of Object.entries(balances)) {
              if (!Number.isFinite(quantity))
                throw new Error(`Solde invalide pour ${asset}`);
              if (quantity === 0) continue;
              const priceKey = `${account.provider}:${asset}`;
              if (!prices.has(priceKey)) {
                const price = await getPrice(asset, account.provider);
                prices.set(priceKey, price);
              }
              const price = prices.get(priceKey);
              holdings.push({
                asset,
                quantity,
                price,
                ...await describeAsset(asset, account),
                ...(price === null && account.provider === "ethereum" ? { unpriced: true } : {}),
              });
            }
            holdings.push(...await readValuations(account, holdings));
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
