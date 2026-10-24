import express from "express";
import helmet from "helmet";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortfolio } from "./store.js";
import { passwordsMatch } from "./security.js";
import { providers } from "./providers.js";
import { GoMiningError } from "./gomining.js";
import { isEthereumAddress } from "./ethereum.js";
import { isViaBtcApiKey } from "./viabtc.js";

const root = fileURLToPath(new URL("../", import.meta.url));

export function createApp({
  store,
  vault,
  collector,
  password,
  demo = false,
  intervalMinutes = 60,
  secureCookie = false,
  gomining,
}) {
  const app = express();
  const sessions = new Map();
  const attempts = new Map();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "style-src": [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          "font-src": ["'self'", "https://fonts.gstatic.com"],
          "img-src": ["'self'", "data:", "https://coin-images.coingecko.com"],
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "24kb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      const origin = req.get("origin");
      if (
        origin &&
        origin !==
          `${secureCookie ? "https" : req.protocol}://${req.get("host")}`
      )
        return res.status(403).json({ error: "Origine non autorisee." });
      if (!req.is("application/json"))
        return res.status(415).json({ error: "JSON requis." });
    }
    const token = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("wallet_session="))
      ?.slice(15);
    const expires = sessions.get(token);
    req.authenticated = demo || (expires && expires > Date.now());
    req.sessionToken = token;
    next();
  });
  app.get("/api/session", (req, res) =>
    res.json({
      authenticated: Boolean(req.authenticated),
      demo,
      intervalMinutes,
      providers,
    }),
  );
  app.post("/api/login", (req, res) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until < now) attempts.delete(key);
    for (const [key, expires] of sessions)
      if (expires < now) sessions.delete(key);
    const attempt = attempts.get(req.ip) ?? {
      count: 0,
      until: now + 15 * 60000,
    };
    if (attempt.count >= 5)
      return res
        .status(429)
        .json({ error: "Trop de tentatives. Reessayez dans 15 minutes." });
    if (!passwordsMatch(req.body?.password, password)) {
      attempt.count++;
      attempts.set(req.ip, attempt);
      return res.status(401).json({ error: "Mot de passe incorrect." });
    }
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    attempts.delete(req.ip);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + 12 * 3600000);
    res.cookie("wallet_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookie,
      maxAge: 12 * 3600000,
    });
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) =>
    req.authenticated
      ? next()
      : res.status(401).json({ error: "Connexion requise." }),
  );
  app.post("/api/logout", (req, res) => {
    sessions.delete(req.sessionToken);
    res.clearCookie("wallet_session", {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookie,
    });
    res.json({ ok: true });
  });
  app.get("/api/portfolio", (req, res) =>
    res.json({ ...buildPortfolio(store), collecting: collector.running }),
  );
  app.get("/api/export", (req, res) => {
    const portfolio = buildPortfolio(store);
    const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const rows = [
      ["date", "account_id", "provider", "value_eur", "valuation_status"],
      ...store
        .snapshots()
        .map((snapshot) => [
          snapshot.captured_at,
          snapshot.account_id,
          portfolio.accounts.find(
            (account) => account.id === snapshot.account_id,
          )?.provider,
          snapshot.total.toFixed(2),
          snapshot.holdings.some((item) => item.unpriced) ? "partial" : "complete",
        ]),
    ];
    res
      .type("text/csv")
      .attachment("mywallet-historique.csv")
      .send(rows.map((row) => row.map(escape).join(",")).join("\r\n"));
  });
  app.use("/api", (req, res, next) =>
    demo && req.method !== "GET"
      ? res.status(403).json({
          error: "Les donnees de demonstration sont en lecture seule.",
        })
      : next(),
  );
  const oauthError = (res, error) =>
    res.status(400).json({
      error:
        error instanceof GoMiningError
          ? error.message
          : "GoMining: connexion impossible. Reessayez plus tard.",
    });
  app.post("/api/gomining/authorize", async (req, res) => {
    if (!gomining)
      return res.status(503).json({ error: "GoMining indisponible." });
    if (collector.running)
      return res.status(409).json({ error: "Une collecte est en cours." });
    const origin = req.get("origin");
    if (origin && origin !== new URL(gomining.redirectUrl).origin) {
      return res
        .status(400)
        .json({
          error:
            "Ouvrez MyWallet a l'adresse PUBLIC_URL configuree avant de connecter GoMining.",
        });
    }
    const { name, accountId } = req.body ?? {};
    if (accountId !== undefined && typeof accountId !== "string")
      return res.status(400).json({ error: "Compte invalide." });
    try {
      const account = accountId ? store.account(accountId) : null;
      res.json(
        await gomining.begin({
          name: account?.name ?? name,
          accountId,
          session: req.sessionToken,
        }),
      );
    } catch (error) {
      oauthError(res, error);
    }
  });
  app.post("/api/gomining/callback", async (req, res) => {
    if (!gomining)
      return res.status(503).json({ error: "GoMining indisponible." });
    if (collector.running)
      return res
        .status(409)
        .json({
          error: "Une collecte est en cours. Reconnectez GoMining ensuite.",
        });
    const params = new URLSearchParams();
    for (const key of ["state", "code", "iss", "error"]) {
      const value = req.body?.[key];
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 4096)
          return res.status(400).json({ error: "Retour OAuth invalide." });
        params.set(key, value);
      }
    }
    try {
      res
        .status(201)
        .json(await gomining.complete({ params, session: req.sessionToken }));
    } catch (error) {
      oauthError(res, error);
    }
  });
  app.post("/api/accounts", (req, res) => {
    if (collector.running)
      return res
        .status(409)
        .json({ error: "Une collecte est en cours. Reessayez ensuite." });
    const { name, provider, apiKey, secret, passphrase, address } = req.body ?? {};
    if (provider === "gomining")
      return res
        .status(400)
        .json({
          error: "GoMining utilise une autorisation OAuth, pas des cles API.",
        });
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 60 ||
      !providers.some((item) => item.id === provider)
    )
      return res.status(400).json({ error: "Nom ou fournisseur invalide." });
    if (store.accounts().length >= 30)
      return res.status(400).json({ error: "Limite de 30 comptes atteinte." });
    if (provider === "viabtc") {
      if (typeof apiKey !== "string" || !isViaBtcApiKey(apiKey.trim()))
        return res.status(400).json({ error: "Cle API ViaBTC absente ou invalide." });
      const normalized = apiKey.trim();
      if (store.accounts().some((item) => item.provider === "viabtc" &&
          vault.decrypt(item.credentials).apiKey === normalized))
        return res.status(409).json({ error: "Cette cle API ViaBTC est deja utilisee." });
      const id = randomUUID();
      store.addAccount({ id, name: name.trim(), provider,
        credentials: vault.encrypt({ apiKey: normalized }), created_at: new Date().toISOString() });
      return res.status(201).json({ id });
    }
    if (provider === "ethereum") {
      if (typeof address !== "string" || !isEthereumAddress(address.trim()))
        return res.status(400).json({ error: "Adresse publique Ethereum invalide (0x suivi de 40 caracteres hexadecimaux)." });
      const normalized = address.trim().toLowerCase();
      if (store.accounts().some((item) => item.provider === "ethereum" &&
          vault.decrypt(item.credentials).address?.toLowerCase() === normalized))
        return res.status(409).json({ error: "Cette adresse Ethereum est deja suivie." });
      const id = randomUUID();
      store.addAccount({ id, name: name.trim(), provider,
        credentials: vault.encrypt({ address: normalized }), created_at: new Date().toISOString() });
      return res.status(201).json({ id });
    }
    if (
      typeof apiKey !== "string" ||
      !apiKey.trim() ||
      apiKey.length > 4096 ||
      typeof secret !== "string" ||
      !secret.trim() ||
      secret.length > 8192 ||
      (provider === "okx" &&
        (typeof passphrase !== "string" ||
          !passphrase.trim() ||
          passphrase.length > 1024))
    )
      return res
        .status(400)
        .json({ error: "Identifiants API incomplets ou invalides." });
    const account = {
      id: randomUUID(),
      name: name.trim(),
      provider,
      credentials: vault.encrypt({
        apiKey: apiKey.trim(),
        secret: secret.trim().replaceAll("\\n", "\n"),
        ...(provider === "okx" ? { password: passphrase } : {}),
      }),
      created_at: new Date().toISOString(),
    };
    store.addAccount(account);
    res.status(201).json({ id: account.id });
  });
  app.delete("/api/accounts/:id", (req, res) => {
    if (collector.running)
      return res.status(409).json({ error: "Une collecte est en cours." });
    if (!store.removeAccount(req.params.id))
      return res.status(404).json({ error: "Compte introuvable." });
    res.json({ ok: true });
  });
  app.post("/api/collect", async (req, res) => {
    if (collector.running)
      return res.status(409).json({ error: "Une collecte est deja en cours." });
    res.json(await collector.collect());
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Route introuvable." }),
  );
  app.get("/oauth/gomining/callback", (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (demo || !gomining)
      return res.status(404).send("GoMining indisponible.");
    const params = new URLSearchParams();
    for (const key of ["state", "code", "iss", "error"]) {
      const value = req.query[key];
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 4096)
          return res.status(400).send("Retour OAuth invalide.");
        params.set(key, value);
      }
    }
    res.redirect(
      303,
      `${new URL(gomining.redirectUrl).origin}/#gomining-callback?${params}`,
    );
  });
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/vendor/chart.js", (req, res) =>
    res.sendFile(path.join(root, "node_modules/chart.js/dist/chart.umd.js")),
  );
  app.get("/vendor/lucide.js", (req, res) =>
    res.sendFile(path.join(root, "node_modules/lucide/dist/umd/lucide.js")),
  );
  app.use(express.static(path.join(root, "public")));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 400 ? 400 : 500).json({
      error:
        error.status === 400
          ? "Requete invalide."
          : "Erreur interne. Reessayez plus tard.",
    });
  });
  return app;
}
