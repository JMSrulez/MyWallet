export const isViaBtcApiKey = (value) =>
  typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value);

const apiErrors = {
  12001: "Cle API invalide. Verifiez la cle du compte ou sous-compte ViaBTC.",
  12002: "Authentification refusee (signature). Verifiez la configuration API ViaBTC.",
  12003: "Horodatage refuse. Verifiez l'horloge du serveur.",
  12004: "IP non autorisee. Ajoutez l'IP publique de sortie du serveur MyWallet a la liste blanche API ViaBTC.",
};

export function parseViaBtcBalances(payload) {
  if (!payload || payload.code !== 0 || !Array.isArray(payload.data?.balance))
    throw new Error("ViaBTC: reponse de soldes absente ou invalide.");
  const balances = new Map();
  for (const row of payload.data.balance) {
    if (typeof row?.coin !== "string" || !/^[A-Za-z0-9]{1,20}$/.test(row.coin))
      throw new Error("ViaBTC: symbole de solde invalide.");
    const asset = row.coin.toUpperCase();
    if (balances.has(asset)) throw new Error("ViaBTC: solde duplique dans la reponse.");
    if (typeof row.amount !== "string" || row.amount.length > 100 ||
        !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(row.amount) ||
        !Number.isFinite(Number(row.amount)))
      throw new Error(`ViaBTC: quantite invalide pour ${asset}.`);
    balances.set(asset, Number(row.amount));
  }
  return Object.fromEntries(balances);
}

export function createViaBtc(vault) {
  return {
    async readBalances(account) {
      const { apiKey } = vault.decrypt(account.credentials);
      if (!isViaBtcApiKey(apiKey)) throw new Error("ViaBTC: cle API absente ou invalide.");
      console.log(`[viabtc] Lecture soldes: ${account.name}`);
      let response;
      try {
        response = await fetch("https://www.viabtc.com/res/openapi/v1/account", {
          method: "GET", headers: { Accept: "application/json", "X-API-KEY": apiKey },
          redirect: "error", signal: AbortSignal.timeout(20000),
        });
      } catch { throw new Error("ViaBTC: serveur injoignable (reseau, DNS, TLS ou redirection). Reessayez plus tard."); }
      let payload;
      try { payload = await response.json(); }
      catch {
        throw new Error(response.ok ? "ViaBTC: reponse JSON invalide."
          : `ViaBTC HTTP ${response.status}: acces refuse ou service indisponible.`);
      }
      if (typeof payload?.code === "number" && payload.code !== 0)
        // Do not persist/log arbitrary provider messages: they can echo keys or
        // account details. Retain only a numeric code and our own explanation.
        throw new Error(`ViaBTC (${payload.code}): ${apiErrors[payload.code] ?? "Requete refusee par l'API. Verifiez les autorisations et la liste blanche IP."}`);
      if (!response.ok) throw new Error(`ViaBTC HTTP ${response.status}: acces refuse ou service indisponible.`);
      // Account info also contains email, observer keys and payout addresses.
      // None of these are returned, stored or added to the account valuation.
      return parseViaBtcBalances(payload);
    },
  };
}
