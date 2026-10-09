import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";

const getRoot = () => process.env.GROK_BOT_ROOT || path.join(process.env.APPDATA || "", "Grok Bot");

let cached;

// Zero cached secrets on process exit so they do not linger in core dumps.
export function clearCache() {
  if (cached) {
    cached.token = "";
    cached = null;
  }
}
for (const ev of ["SIGINT", "SIGTERM", "beforeExit", "exit"]) process.once(ev, clearCache);

export function dpapi(b64) {
  return new Promise((resolve, reject) => {
    // Pass the base64 over stdin so it is never interpolated into PowerShell source.
    const ps = [
      "Add-Type -AssemblyName System.Security",
      "$ErrorActionPreference = 'Stop'",
      "$in = [Console]::In.ReadToEnd()",
      "$bytes = [Convert]::FromBase64String($in.Trim())",
      "$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
      "[Convert]::ToBase64String($out)"
    ].join("; ");
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Таймаут чтения сессии Grok Bot."));
    }, 10000);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Не удалось прочитать сессию Grok Bot."));
      resolve(Buffer.from(stdout.trim(), "base64"));
    });
    child.stdin.end(b64);
  });
}

export function dpapiSync(b64) {
  const ps = [
    "Add-Type -AssemblyName System.Security",
    "$ErrorActionPreference = 'Stop'",
    "$in = [Console]::In.ReadToEnd()",
    "$bytes = [Convert]::FromBase64String($in.Trim())",
    "$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
    "[Convert]::ToBase64String($out)"
  ].join("; ");
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    input: b64,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  if (run.status !== 0) throw new Error("Не удалось прочитать сессию Grok Bot.");
  return Buffer.from(run.stdout.trim(), "base64");
}

export function electronDecrypt(value, key) {
  if (value.startsWith("plaintext:v1:")) {
    return Buffer.from(value.slice("plaintext:v1:".length), "base64").toString("utf8");
  }
  const blob = Buffer.from(value, "base64");
  const nonce = blob.subarray(3, 15);
  const data = blob.subarray(15);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final()
  ]).toString("utf8");
}

export function electronEncrypt(text, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const prefix = Buffer.from("v10");
  return Buffer.concat([prefix, nonce, enc, tag]).toString("base64");
}

export async function loadSession() {
  const root = getRoot();
  const secretPath = path.join(root, "sand-secrets.json");
  const localStatePath = path.join(root, "Local State");
  const stamp = (await fs.promises.stat(secretPath)).mtimeMs;
  if (cached && cached.stamp === stamp && Date.now() - cached.at < 60000) return cached;
  const local = JSON.parse(await fs.promises.readFile(localStatePath, "utf8"));
  const key = await dpapi(Buffer.from(local.os_crypt.encrypted_key, "base64").subarray(5).toString("base64"));
  const secrets = JSON.parse(await fs.promises.readFile(secretPath, "utf8"));
  const accounts = JSON.parse(secrets["cursor-accounts"]);
  const active = accounts.accounts[accounts.active];
  if (!active?.["cursor-access-token"]) throw new Error("Войдите в Grok Bot: активная сессия не найдена.");
  cached = { token: electronDecrypt(active["cursor-access-token"], key), at: Date.now(), stamp };
  return cached;
}

export function loadSessionSync() {
  const root = getRoot();
  const secretPath = path.join(root, "sand-secrets.json");
  const localStatePath = path.join(root, "Local State");
  const stamp = fs.statSync(secretPath).mtimeMs;
  if (cached && cached.stamp === stamp && Date.now() - cached.at < 60000) return cached;
  const local = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  const key = dpapiSync(Buffer.from(local.os_crypt.encrypted_key, "base64").subarray(5).toString("base64"));
  const secrets = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  const accounts = JSON.parse(secrets["cursor-accounts"]);
  const active = accounts.accounts[accounts.active];
  if (!active?.["cursor-access-token"]) throw new Error("Войдите в Grok Bot: активная сессия не найдена.");
  cached = { token: electronDecrypt(active["cursor-access-token"], key), at: Date.now(), stamp };
  return cached;
}
