"use strict";
/**
 * send-daily-report.js
 * ───────────────────────────────────────────────────────────────────────────
 * Gửi báo cáo kinh doanh cuối ngày (Mobile-first) & cảnh báo lỗi tức thì qua Telegram.
 * Nguồn số liệu đồng bộ 100% với App chính thông qua ecogo-core.js.
 */

const fs = require("fs");
const zlib = require("zlib");
const https = require("https");
const {
  toVNDateKey,
  getVNDayBounds,
  getTodayVNDateKey,
  isOrderDeleted,
  computeOrderFinancials,
  formatVND,
} = require("./ecogo-core");

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (raw.startsWith("--")) {
      const idx = raw.indexOf("=");
      if (idx > 2) {
        args[raw.slice(2, idx)] = raw.slice(idx + 1);
      }
    }
  }
  return args;
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readBackupFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const str = filePath.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return JSON.parse(str);
}

function resolveTelegramCredentials(backupData) {
  let token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  let chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();

  if ((!token || !chatId) && backupData && Array.isArray(backupData.settings)) {
    const tgDoc = backupData.settings.find((d) => d._id === "telegramConfig" || d.id === "telegramConfig");
    if (tgDoc) {
      if (!token && tgDoc.botToken) token = String(tgDoc.botToken).trim();
      if (!chatId) {
        if (tgDoc.chatId) chatId = String(tgDoc.chatId).trim();
        else if (Array.isArray(tgDoc.allowedAdminIds) && tgDoc.allowedAdminIds.length > 0) {
          chatId = String(tgDoc.allowedAdminIds[0]).trim();
        }
      }
    }
  }

  return { token, chatId };
}

function postTelegramMessage(token, chatId, htmlText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: htmlText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300 && json.ok) {
              resolve(json);
            } else {
              reject(new Error(`Telegram API ${res.statusCode}: ${json.description || body}`));
            }
          } catch {
            reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Telegram request timeout"));
    });
    req.write(payload);
    req.end();
  });
}

function buildDailyReportHtml(backupData, summary, targetDateVN) {
  const orders = (backupData.orders || []).filter((o) => !isOrderDeleted(o));
  const products = backupData.products || [];
  const ledger = backupData.payment_ledger || [];

  const { startMs: todayStartMs } = getVNDayBounds(targetDateVN);
  const yesterdayVN = toVNDateKey(todayStartMs - 12 * 3600 * 1000);

  let bookedToday = 0;
  let collectedToday = 0;
  let receivableToday = 0;
  let costToday = 0;
  let profitToday = 0;
  let hasCostToday = false;

  let countTodayActive = 0;
  let countTodayPos = 0;
  let countTodayDelivery = 0;
  let countTodayDelivered = 0;
  let countTodayPending = 0;
  let countTodayCancelled = 0;
  let bookedYesterday = 0;

  // Tổng công nợ tồn đọng toàn hệ thống
  let sysReceivableTotal = 0;
  let sysPendingTransferCount = 0;
  let sysPendingTransferAmount = 0;
  let sysPartialCount = 0;
  let sysPartialRemaining = 0;

  const prodSalesMap = new Map();

  for (const o of orders) {
    const fin = computeOrderFinancials(o);
    const createdDateVN = toVNDateKey(o.createdAt || o.updatedAt);

    // Công nợ tồn đọng toàn hệ thống (không tính đơn huỷ & đã hoàn tiền VOIDED)
    if (o.status !== "CANCELLED" && fin.paymentStatus !== "VOIDED" && fin.orderReceivable > 0) {
      sysReceivableTotal += fin.orderReceivable;
      if (fin.paymentStatus === "PARTIALLY_PAID") {
        sysPartialCount++;
        sysPartialRemaining += fin.orderReceivable;
      } else if (fin.paymentStatus === "PENDING_TRANSFER") {
        sysPendingTransferCount++;
        sysPendingTransferAmount += fin.orderReceivable;
      }
    }

    if (createdDateVN === yesterdayVN && o.status !== "CANCELLED") {
      bookedYesterday += fin.orderTotal;
    }

    if (createdDateVN !== targetDateVN) continue;

    if (o.status === "CANCELLED") {
      countTodayCancelled++;
      continue;
    }

    countTodayActive++;
    const isPos = Boolean(o.isPos || String(o.address || "").trim().toLowerCase() === "mua tại quầy");
    if (isPos) countTodayPos++;
    else countTodayDelivery++;

    if (o.status === "DELIVERED") countTodayDelivered++;
    else countTodayPending++;

    bookedToday += fin.orderTotal;
    collectedToday += fin.orderPaid;
    receivableToday += fin.orderReceivable;
    costToday += fin.orderCost;
    profitToday += fin.orderProfit;
    if (fin.hasCostData) hasCostToday = true;

    for (const it of o.items || []) {
      const name = String(it.name || "Khác").trim();
      const qty = Number(it.quantity ?? it.qty ?? 0);
      const rev = Math.round(Number(it.price || 0) * qty);
      if (!prodSalesMap.has(name)) prodSalesMap.set(name, { name, qty: 0, revenue: 0 });
      const entry = prodSalesMap.get(name);
      entry.qty += qty;
      entry.revenue += rev;
    }
  }

  // Sổ cái dòng tiền thực thu trong ngày (payment_ledger)
  let ledgerPayos = 0;
  let ledgerManual = 0;
  let ledgerPos = 0;
  let ledgerReversal = 0;
  let ledgerEntriesToday = 0;

  for (const tx of ledger) {
    if (toVNDateKey(tx.createdAt) !== targetDateVN) continue;
    ledgerEntriesToday++;
    const amt = Math.round(Number(tx.deltaAmount ?? tx.receivedAmount ?? 0));
    if (tx.action === "REVERSAL" || tx.action === "VOID" || amt < 0) {
      ledgerReversal += Math.abs(amt);
    } else if (tx.source === "PAYOS_WEBHOOK") {
      ledgerPayos += amt;
    } else if (tx.source === "POS") {
      ledgerPos += amt;
    } else {
      ledgerManual += amt;
    }
  }

  const trendStr =
    bookedYesterday > 0
      ? (() => {
          const pct = ((bookedToday - bookedYesterday) / bookedYesterday) * 100;
          const arrow = pct >= 0 ? "📈 +" : "📉 ";
          return `${arrow}${pct.toFixed(1)}% vs hôm qua`;
        })()
      : bookedToday > 0
        ? "📈 Mới phát sinh hôm nay"
        : "—";

  const marginPct = bookedToday > 0 ? ((profitToday / bookedToday) * 100).toFixed(1) : "0.0";

  const top5Products = Array.from(prodSalesMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const lowStockItems = products
    .filter((p) => typeof p.stockQuantity === "number" && p.stockQuantity < 5)
    .sort((a, b) => a.stockQuantity - b.stockQuantity)
    .slice(0, 5);

  const [yyyy, mm, dd] = targetDateVN.split("-");
  const dateDisplay = `${dd}/${mm}/${yyyy}`;

  const lines = [
    `📊 <b>BÁO CÁO CUỐI NGÀY — ${dateDisplay}</b>`,
    `<i>Nấm Lùn Shop (EcoGo) · GMT+7</i>`,
    ``,
    `💰 <b>DOANH THU &amp; DÒNG TIỀN HÔM NAY</b>`,
    `• Ghi nhận: <b>${formatVND(bookedToday)}</b> (${countTodayActive} đơn: ${countTodayDelivery} giao · ${countTodayPos} POS)`,
    `  <i>${trendStr}</i>`,
    `• Thực thu (Đã XN): <b>${formatVND(collectedToday)}</b>`,
    `• Công nợ phát sinh: <b>${formatVND(receivableToday)}</b>`,
    hasCostToday
      ? `• Lợi nhuận gộp: <b>${formatVND(profitToday)}</b> (${marginPct}% · vốn ${formatVND(costToday)})`
      : `• Lợi nhuận gộp: <i>Chưa đủ dữ liệu giá vốn</i>`,
  ];

  if (ledgerEntriesToday > 0) {
    lines.push(
      ``,
      `🏦 <b>SỔ CÁI THỰC THU TRONG NGÀY (${ledgerEntriesToday} GD)</b>`,
      `• PayOS Auto: <b>${formatVND(ledgerPayos)}</b> | POS: <b>${formatVND(ledgerPos)}</b>`,
      `• XN Thủ công: <b>${formatVND(ledgerManual)}</b>${ledgerReversal > 0 ? ` | Hoàn/Huỷ: -${formatVND(ledgerReversal)}` : ""}`
    );
  }

  lines.push(
    ``,
    `📦 <b>VẬN HÀNH &amp; CÔNG NỢ TOÀN HỆ THỐNG</b>`,
    `• Trạng thái hôm nay: ✅ ${countTodayDelivered} đã giao · ⏳ ${countTodayPending} đang xử lý · ❌ ${countTodayCancelled} huỷ`,
    `• Tổng công nợ chưa thu: <b>${formatVND(sysReceivableTotal)}</b>` +
      (sysPendingTransferCount > 0 || sysPartialCount > 0
        ? ` (CK chờ duyệt: ${sysPendingTransferCount} đơn ${formatVND(sysPendingTransferAmount)}` +
          (sysPartialCount > 0 ? ` · Trả thiếu: ${sysPartialCount} đơn ${formatVND(sysPartialRemaining)}` : "") +
          `)`
        : "")
  );

  if (top5Products.length > 0) {
    lines.push(``, `🏆 <b>TOP BÁN CHẠY HÔM NAY</b>`);
    top5Products.forEach((p, idx) => {
      const qtyStr = Number.isInteger(p.qty) ? p.qty : Number(p.qty.toFixed(2));
      lines.push(`${idx + 1}. ${escapeHtml(p.name)} — <b>${qtyStr}</b> (${formatVND(p.revenue)})`);
    });
  }

  if (lowStockItems.length > 0) {
    lines.push(``, `⚠️ <b>CẢNH BÁO TỒN KHO THẤP (&lt; 5)</b>`);
    lowStockItems.forEach((p) => {
      const qtyStr = Number.isInteger(p.stockQuantity) ? p.stockQuantity : Number(p.stockQuantity.toFixed(2));
      lines.push(`• ${escapeHtml(p.name)}: còn <b>${qtyStr}</b>`);
    });
  }

  if (summary) {
    lines.push(
      ``,
      `💾 <b>BACKUP AN TOÀN</b>`,
      `• ${summary.collectionsCount} collections · <b>${summary.totalDocuments}</b> docs · ${summary.gzSizeKB} KB`,
      `• SHA-256: <code>${String(summary.sha256 || "").slice(0, 16)}</code>`
    );
  }

  return lines.join("\n");
}

function buildFailureAlertHtml(args) {
  const wf = escapeHtml(args.workflow || "EcoGo Automation");
  const date = escapeHtml(args.date || getTodayVNDateKey());
  const repo = escapeHtml(args.repo || "");
  const runUrl = args["run-url"] || "";
  const lines = [
    `🚨 <b>CẢNH BÁO: ${wf} THẤT BẠI!</b>`,
    ``,
    `• Thời gian: <b>${date}</b> (GMT+7)`,
    repo ? `• Repository: <code>${repo}</code>` : null,
    runUrl ? `• Xem log lỗi: <a href="${escapeHtml(runUrl)}">Mở GitHub Actions</a>` : null,
    ``,
    `<i>Vui lòng kiểm tra ngay để đảm bảo không gián đoạn sao lưu dữ liệu.</i>`,
  ].filter(Boolean);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode || "daily";

  let backupData = null;
  if (args.backup) {
    backupData = readBackupFile(args.backup);
  }

  let summary = null;
  if (args.summary && fs.existsSync(args.summary)) {
    summary = JSON.parse(fs.readFileSync(args.summary, "utf8"));
  }

  const { token, chatId } = resolveTelegramCredentials(backupData);

  let htmlText;
  if (mode === "failure") {
    htmlText = buildFailureAlertHtml(args);
  } else {
    if (!backupData) {
      throw new Error("Thiếu file backup (--backup=...) để tạo báo cáo ngày.");
    }
    const targetDateVN =
      args.date ||
      (summary && summary.dateVN) ||
      (backupData._meta && backupData._meta.exportedDateVN) ||
      getTodayVNDateKey();
    htmlText = buildDailyReportHtml(backupData, summary, targetDateVN);
  }

  if (args.dryRun) {
    console.log("─── TELEGRAM DRY-RUN PREVIEW ───");
    console.log(htmlText);
    console.log("────────────────────────────────");
    return;
  }

  if (!token || !chatId) {
    console.log("ℹ️ Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (cả trong Secrets lẫn Firestore settings/telegramConfig). Bỏ qua bước gửi Telegram.");
    return;
  }

  await postTelegramMessage(token, chatId, htmlText);
  console.log(`✅ Đã gửi Telegram (${mode}) thành công tới chat ${chatId}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Lỗi send-daily-report:", err.message || err);
      process.exit(1);
    });
}

module.exports = { buildDailyReportHtml, buildFailureAlertHtml, resolveTelegramCredentials };
