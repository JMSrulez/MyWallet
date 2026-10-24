import { DatabaseSync } from "node:sqlite";
import { holdingValue } from "./holdings.js";

export function createStore(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      credentials TEXT NOT NULL, created_at TEXT NOT NULL,
      last_attempt TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      captured_at TEXT NOT NULL, total REAL NOT NULL, holdings TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_account_time ON snapshots(account_id, captured_at);
  `);
  return {
    close: () => db.close(),
    accounts: () =>
      db.prepare("SELECT * FROM accounts ORDER BY created_at, id").all(),
    account: (id) => db.prepare("SELECT * FROM accounts WHERE id = ?").get(id),
    addAccount(account) {
      db.prepare(
        "INSERT INTO accounts (id, name, provider, credentials, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        account.id,
        account.name,
        account.provider,
        account.credentials,
        account.created_at,
      );
    },
    updateCredentials(id, credentials) {
      return db
        .prepare("UPDATE accounts SET credentials = ? WHERE id = ?")
        .run(credentials, id).changes;
    },
    removeAccount(id) {
      return db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes;
    },
    recordSnapshot(accountId, capturedAt, holdings) {
      const total = holdings.reduce(
        (sum, item) => sum + holdingValue(item),
        0,
      );
      if (!Number.isFinite(total)) throw new Error("Invalid total");
      db.prepare(
        "INSERT INTO snapshots (account_id, captured_at, total, holdings) VALUES (?, ?, ?, ?)",
      ).run(accountId, capturedAt, total, JSON.stringify(holdings));
    },
    recordAttempt(id, capturedAt, error = null) {
      db.prepare(
        "UPDATE accounts SET last_attempt = ?, last_error = ? WHERE id = ?",
      ).run(capturedAt, error, id);
    },
    snapshots() {
      return db
        .prepare("SELECT * FROM snapshots ORDER BY captured_at, id")
        .all()
        .map((row) => ({ ...row, holdings: JSON.parse(row.holdings) }));
    },
  };
}

export function buildPortfolio(store) {
  const accounts = store.accounts();
  const snapshots = store.snapshots();
  const latest = new Map();
  const timeline = new Map();
  for (const snapshot of snapshots) {
    latest.set(snapshot.account_id, snapshot);
    timeline.set(snapshot.captured_at, {
      time: snapshot.captured_at,
      total: [...latest.values()].reduce((sum, item) => sum + item.total, 0),
      accounts: Object.fromEntries(
        [...latest].map(([id, item]) => [id, item.total]),
      ),
    });
  }
  const safeAccounts = accounts.map(({ credentials, ...account }) => ({
    ...account,
    snapshot: latest.get(account.id) ?? null,
    history: snapshots
      .filter((item) => item.account_id === account.id)
      .map((item) => ({ time: item.captured_at, total: item.total })),
  }));
  return {
    currency: "EUR",
    total: safeAccounts.reduce(
      (sum, account) => sum + (account.snapshot?.total ?? 0),
      0,
    ),
    accounts: safeAccounts,
    history: [...timeline.values()],
  };
}
