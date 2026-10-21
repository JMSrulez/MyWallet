import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";

export function createVault(encodedKey) {
  const key = Buffer.from(encodedKey ?? "", "base64");
  if (key.length !== 32)
    throw new Error(
      "ENCRYPTION_KEY must be a base64-encoded 32-byte key. Run npm run setup.",
    );
  return {
    encrypt(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return [nonce, cipher.getAuthTag(), encrypted]
        .map((part) => part.toString("base64"))
        .join(".");
    },
    decrypt(value) {
      const [nonce, tag, encrypted] = value
        .split(".")
        .map((part) => Buffer.from(part, "base64"));
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
          "utf8",
        ),
      );
    },
  };
}

export function passwordsMatch(input, expected) {
  const hash = (value) =>
    createHash("sha256")
      .update(String(value ?? ""))
      .digest();
  return timingSafeEqual(hash(input), hash(expected));
}
