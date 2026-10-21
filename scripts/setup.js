import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const content = [
  `AUTH_PASSWORD=${randomBytes(24).toString("base64url")}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  "COLLECT_INTERVAL_MINUTES=60",
  "COOKIE_SECURE=false",
  "PORT=3080",
  "",
].join("\n");

try {
  writeFileSync(new URL("../.env", import.meta.url), content, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Configuration generated in .env. Open it locally to retrieve your login password. Keep this file private and back up ENCRYPTION_KEY with your database.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.error(".env already exists. Nothing was changed.");
  process.exitCode = 1;
}
