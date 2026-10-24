import ccxt from "ccxt";

class GateBalanceError extends Error {}
const failure = (detail) => new GateBalanceError(`Gate: ${detail}`);
const errorLabels = {
  INVALID_KEY: "Cle API invalide. Verifiez le choix Gate.io international / Gate EU.",
  INVALID_CREDENTIALS: "Cle ou secret invalide. Verifiez la plateforme de creation de la cle.",
  AUTHENTICATION_FAILED: "Authentification refusee. Verifiez la cle, le secret et la plateforme.",
  INVALID_SIGNATURE: "Signature invalide. Verifiez le secret API v4.",
  IP_FORBIDDEN: "IP non autorisee. Verifiez l'IP publique de sortie du serveur dans la liste blanche de la cle.",
  REQUEST_EXPIRED: "Horodatage expire. Synchronisez l'horloge du serveur.",
  FORBIDDEN: "Acces refuse. Activez la permission Spot en lecture seule pour cette cle.",
  ACCOUNT_LOCKED: "Compte bloque par Gate. Verifiez son statut sur la plateforme.",
};

function amount(value) {
  if (typeof value !== "string" || value.length > 100 ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(Number(value))) throw failure("Quantite spot invalide.");
  return Number(value);
}

export async function readGateSpot(client) {
  try {
    // Use only the spot balance endpoint: fetchBalance() may first discover
    // unified-account status and load unrelated markets/permission groups.
    const response = await client.privateSpotGetAccounts();
    if (!Array.isArray(response)) throw failure("Reponse de soldes spot invalide.");
    const balances = new Map();
    for (const row of response) {
      if (typeof row?.currency !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(row.currency))
        throw failure("Symbole spot invalide.");
      const asset = client.safeCurrencyCode(row.currency.toUpperCase());
      if (typeof asset !== "string" || balances.has(asset)) throw failure("Symbole spot absent ou duplique.");
      const total = amount(row.available) + amount(row.locked);
      if (!Number.isFinite(total)) throw failure("Total spot invalide.");
      balances.set(asset, total);
    }
    return Object.fromEntries(balances);
  } catch (error) {
    if (error instanceof GateBalanceError) throw error;
    // Read only whitelisted labels from CCXT's error envelope, never return
    // the raw body/message, which can include request/account information.
    let label;
    try {
      const message = String(error?.message ?? "");
      if (message.length <= 10000) label = JSON.parse(message.slice(message.indexOf("{"))).label;
    } catch {}
    if (typeof label === "string" && Object.hasOwn(errorLabels, label)) throw failure(errorLabels[label]);
    if (error instanceof ccxt.PermissionDenied)
      throw failure("Acces refuse. Verifiez la permission Spot en lecture seule.");
    if (error instanceof ccxt.AuthenticationError)
      throw failure("Authentification refusee. Verifiez cle, secret, plateforme et liste blanche IP.");
    if (error instanceof ccxt.RateLimitExceeded)
      throw failure("Limite de requetes atteinte. Reessayez plus tard.");
    if (error instanceof ccxt.NetworkError)
      throw failure("Serveur injoignable. Verifiez le reseau et reessayez.");
    throw failure("Lecture du solde spot impossible. Verifiez la connexion API.");
  }
}

// Gate's own market identity avoids CoinGecko symbol collisions for long-tail tokens.
export async function readGateQuotes(client) {
  let rows;
  try { rows = await client.publicSpotGetTickers(); }
  catch { throw failure("Cours spot indisponibles. Reessayez plus tard."); }
  if (!Array.isArray(rows)) throw failure("Reponse de cours spot invalide.");
  const pairs = new Map();
  const quotes = ["EUR", "USDT", "USDC", "BTC", "ETH"];
  for (const row of rows) {
    if (typeof row?.currency_pair !== "string") throw failure("Paire spot invalide.");
    const parts = row.currency_pair.split("_");
    if (parts.length !== 2 || !quotes.includes(parts[1])) continue;
    if (pairs.has(row.currency_pair)) throw failure("Cours spot duplique.");
    // Empty/zero last prices mean no usable quotation, not a worthless token.
    const last = row.last === "" ? 0 : amount(row.last);
    pairs.set(row.currency_pair, { asset: client.safeCurrencyCode(parts[0]), quote: parts[1], last });
  }
  const result = new Map();
  for (const quote of quotes) {
    for (const item of pairs.values()) {
      if (item.quote === quote && item.last > 0 && !result.has(item.asset))
        result.set(item.asset, item);
    }
  }
  return result;
}
