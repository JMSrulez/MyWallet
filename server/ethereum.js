export const isEthereumAddress = (value) =>
  typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
export const isEthereumToken = (value) =>
  typeof value === "string" && /^ERC20:0x[a-f0-9]{40}$/.test(value);

function rawUnits(value) {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value))
    throw new Error("Ethereum: quantite brute invalide.");
  return BigInt(value);
}

function quantity(value, decimals) {
  const raw = rawUnits(value).toString().padStart(decimals + 1, "0");
  const text = decimals ? `${raw.slice(0, -decimals)}.${raw.slice(-decimals)}` : raw;
  const result = Number(text);
  if (!Number.isFinite(result)) throw new Error("Ethereum: quantite invalide.");
  return result;
}

export function createEthereum(vault) {
  // Per-account results are replaced only after every page has been read.
  const collected = new Map();
  async function request(path) {
    let response;
    try {
      response = await fetch(`https://eth.blockscout.com/api/v2${path}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000),
      });
    } catch { throw new Error("Ethereum: Blockscout injoignable."); }
    if (!response.ok) throw new Error(`Ethereum: Blockscout HTTP ${response.status}.`);
    try { return await response.json(); }
    catch { throw new Error("Ethereum: reponse Blockscout invalide."); }
  }
  return {
    async readBalances(account) {
      const { address } = vault.decrypt(account.credentials);
      if (!isEthereumAddress(address)) throw new Error("Ethereum: adresse invalide.");
      const wallet = address.toLowerCase();
      const info = await request(`/addresses/${wallet}`);
      if (!isEthereumAddress(info?.hash) || info.hash.toLowerCase() !== wallet)
        throw new Error("Ethereum: adresse absente de la reponse Blockscout.");
      if (info.coin_balance === null)
        throw new Error("Ethereum: solde ETH non encore indexe par Blockscout. Reessayez plus tard.");
      const balances = { ETH: quantity(info.coin_balance, 18) };
      const metadata = new Map();
      const unpriced = [];
      const seen = new Set();
      const cursors = new Set();
      let params = new URLSearchParams({ type: "ERC-20" });
      for (let page = 0; ; page++) {
        if (page >= 20) throw new Error("Ethereum: trop de pages de jetons, collecte incomplete.");
        const data = await request(`/addresses/${wallet}/tokens?${params}`);
        if (!Array.isArray(data?.items) || !Object.hasOwn(data, "next_page_params"))
          throw new Error("Ethereum: liste de jetons invalide.");
        for (const row of data.items) {
          if (row?.token?.type !== "ERC-20") continue;
          if (!isEthereumAddress(row.token.address_hash))
            throw new Error("Ethereum: contrat de jeton invalide.");
          const contract = row.token.address_hash.toLowerCase();
          if (seen.has(contract)) throw new Error("Ethereum: jeton duplique pendant la pagination.");
          seen.add(contract);
          if (rawUnits(row.value) === 0n) continue;
          const asset = `ERC20:${contract}`;
          const details = {
            symbol: typeof row.token.symbol === "string" && row.token.symbol.trim()
              ? row.token.symbol.slice(0, 32) : contract.slice(0, 10),
            name: typeof row.token.name === "string" && row.token.name.trim()
              ? row.token.name.slice(0, 100) : "Jeton ERC-20",
            contract, network: "ethereum",
          };
          metadata.set(asset, details);
          const decimals = typeof row.token.decimals === "string" && /^\d{1,3}$/.test(row.token.decimals)
            ? Number(row.token.decimals) : row.token.decimals;
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
            // No guess of 18 decimals: retain the raw quantity with an explicit
            // unknown value so an unindexed/dust token cannot hide other assets.
            unpriced.push({ asset, ...details, unpriced: true, price: null,
              quantity: null, rawQuantity: row.value, decimals: null });
          } else balances[asset] = quantity(row.value, decimals);
        }
        const next = data.next_page_params;
        if (next === null) break;
        if (!next || typeof next !== "object" || Array.isArray(next) ||
            Object.keys(next).length === 0 || JSON.stringify(next).length > 4096)
          throw new Error("Ethereum: pagination invalide.");
        const entries = Object.entries(next).sort(([a], [b]) => a.localeCompare(b));
        if (entries.some(([key, value]) => !/^[a-zA-Z0-9_]{1,64}$/.test(key) ||
            !(value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))))
          throw new Error("Ethereum: pagination invalide.");
        const cursor = JSON.stringify(entries);
        if (cursors.has(cursor)) throw new Error("Ethereum: pagination repetee.");
        cursors.add(cursor);
        params = new URLSearchParams(entries.filter(([, value]) => value !== null));
        params.set("type", "ERC-20");
      }
      collected.set(account.id, { metadata, unpriced });
      return balances;
    },
    describeAsset: (asset, account) => collected.get(account.id)?.metadata.get(asset) ?? {},
    extraHoldings: (account) => collected.get(account.id)?.unpriced ?? [],
  };
}
