"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * メール送信手段を作る。
 * - console: 送信せずサーバーのログに出力する（開発用）
 * - file:    1 通ずつ JSON ファイルとして保存する（E2E テスト用）
 * - resend:  Resend の HTTP API で実際に送信する
 *
 * @param {{ transport: string, from?: string, resendApiKey?: string, outboxDir?: string }} options
 * @returns {{ send(message: { to: string, subject: string, text: string }): Promise<void> }}
 */
function createMailer({ transport, from, resendApiKey, outboxDir }) {
  if (transport === "console") {
    return {
      async send({ to, subject, text }) {
        console.log(`\n---- メール（未送信: MAIL_TRANSPORT=console）----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n----\n`);
      },
    };
  }

  if (transport === "file") {
    return {
      async send(message) {
        await fs.promises.mkdir(outboxDir, { recursive: true });
        const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
        await fs.promises.writeFile(path.join(outboxDir, name), JSON.stringify({ ...message, from }));
      },
    };
  }

  if (transport === "resend") {
    return {
      async send({ to, subject, text }) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
        }
      },
    };
  }

  throw new Error(`Unknown MAIL_TRANSPORT: ${transport}`);
}

module.exports = { createMailer };
