import { mkdirSync } from "node:fs";
import path from "node:path";
import { createStore } from "./store.js";
import { createVault } from "./security.js";
import { createCollector } from "./collector.js";
import { createProviders } from "./providers.js";
import { createApp } from "./app.js";
import { seedDemo } from "./demo.js";
import { createGoMining } from "./gomining.js";

const demo =
  process.argv.includes("--demo") || process.env.DEMO_MODE === "true";
const password = process.env.AUTH_PASSWORD;
if (!demo && (!password || password.length < 12))
  throw new Error(
    "AUTH_PASSWORD must contain at least 12 characters. Run npm run setup.",
  );
const directory = path.resolve(process.env.DATA_DIR || "./data");
mkdirSync(directory, { recursive: true });
const store = createStore(
  path.join(directory, demo ? "demo.sqlite" : "wallet.sqlite"),
);
const vault = demo ? null : createVault(process.env.ENCRYPTION_KEY);
const gomining = demo
  ? null
  : createGoMining({
      store,
      vault,
      publicUrl:
        process.env.PUBLIC_URL ||
        `http://localhost:${process.env.PORT || 3080}`,
    });
const adapters = demo ? null : createProviders(vault, { gomining });
if (demo) seedDemo(store);
const collector = createCollector({
  store,
  readBalances: adapters?.readBalances,
  preparePrices: adapters?.preparePrices,
  describeAsset: adapters?.describeAsset,
  readValuations: adapters?.readValuations,
  getPrice: adapters?.getPrice,
});
const intervalMinutes = Number(process.env.COLLECT_INTERVAL_MINUTES || 60);
if (
  !Number.isFinite(intervalMinutes) ||
  intervalMinutes < 5 ||
  intervalMinutes > 10080
)
  throw new Error("COLLECT_INTERVAL_MINUTES must be between 5 and 10080.");
const port = Number(process.env.PORT || 3080);
const app = createApp({
  store,
  vault,
  collector,
  password,
  demo,
  intervalMinutes,
  secureCookie: process.env.COOKIE_SECURE === "true",
  gomining,
});
const server = app.listen(port, process.env.HOST || "0.0.0.0", () =>
  console.log(
    `MyWallet: http://localhost:${port}${demo ? " (demonstration)" : ""}`,
  ),
);
const timer = demo
  ? null
  : setInterval(
      () =>
        collector
          .collect()
          .catch((err) =>
            console.error("Scheduled collection failed:", err?.message || err),
          ),
      intervalMinutes * 60000,
    );
if (!demo)
  collector
    .collect()
    .catch((err) =>
      console.error("Startup collection failed:", err?.message || err),
    );
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(async () => {
    await adapters?.close();
    store.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
