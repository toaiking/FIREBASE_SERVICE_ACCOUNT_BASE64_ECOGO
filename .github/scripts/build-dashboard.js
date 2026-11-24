"use strict";
/**
 * build-dashboard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Đọc tất cả backup-YYYY-MM-DD.json(.gz) trong /backups/ (hoặc ECOGO_BACKUP_DIR),
 * tính toán chuẩn 100% với App chính thông qua ecogo-core.js:
 *  - PaymentStateMachine: Booked vs Collected (Thực thu) vs Receivable (Công nợ)
 *  - Giá vốn (importPrice) & Lợi nhuận gộp (Cost / Gross Profit / Margin)
 *  - Sổ cái thanh toán payment_ledger & audit_logs
 *  - Múi giờ chuẩn Asia/Ho_Chi_Minh (GMT+7)
 *  - Chuẩn hóa khách hàng từ Master Data `customers`
 *  - Mã hóa AES-256-GCM khi có DASHBOARD_PASSWORD (không xuất dist/data.json thô)
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const {
  tsToMs,
  toVNDateKey,
  toVNWeekKey,
  isOrderDeleted,
  computeOrderFinancials,
  buildCustomerLookup,
  resolveCanonicalCustomer,
} = require("./ecogo-core");

function encryptPayloadAESGCM(jsonDataStr, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(jsonDataStr, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // WebCrypto AES-GCM expects ciphertext + 16-byte tag concatenated
  const combined = Buffer.concat([enc, tag]);
  return {
    encrypted: true,
    alg: "PBKDF2-SHA256-AES-256-GCM",
    iterations: 100000,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: combined.toString("base64"),
  };
}

function buildDashboard(options = {}) {
  const BACKUP_DIR = options.backupDir || process.env.ECOGO_BACKUP_DIR || "./backups";
  const DIST_DIR = options.distDir || process.env.ECOGO_DIST_DIR || "./dist";
  const TEMPLATE_PATH = options.templatePath || path.join(__dirname, "dashboard-template.html");
  const DASHBOARD_PASSWORD = (options.password !== undefined ? options.password : (process.env.DASHBOARD_PASSWORD || "")).trim();

  if (!fs.existsSync(BACKUP_DIR)) {
    throw new Error(`Không tìm thấy thư mục backups: ${BACKUP_DIR}`);
  }

  const backupFiles = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.match(/^backup-\d{4}-\d{2}-\d{2}\.json(\.gz)?$/))
    .sort();

  if (backupFiles.length === 0) {
    throw new Error(`Không tìm thấy file backup nào trong ${BACKUP_DIR}`);
  }

  console.log(`📦 ${backupFiles.length} file backup: ${backupFiles.join(", ")}`);

  const snapshots = [];

  for (const file of backupFiles) {
    const date = file.replace("backup-", "").replace(/\.json(\.gz)?$/, "");
    let raw;
    try {
      const buf = fs.readFileSync(path.join(BACKUP_DIR, file));
      const str = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      raw = JSON.parse(str);
    } catch (e) {
      console.warn(`⚠️  Bỏ qua file lỗi: ${file} (${e.message})`);
      continue;
    }

    const orderMap = new Map();
    const list = raw.orders || [];
    for (const o of list) {
      const id = o.id || o._id;
      if (!id) continue;
      orderMap.set(id, o);
    }

    snapshots.push({
      date,
      orders: orderMap,
      customers: raw.customers || [],
      products: raw.products || [],
      paymentLedger: raw.payment_ledger || [],
      auditLogs: raw.audit_logs || [],
      rawCount: list.length,
    });

    console.log(`  ✓ ${file}: ${orderMap.size} đơn hàng`);
  }

  if (snapshots.length === 0) {
    throw new Error("Không có snapshot hợp lệ nào.");
  }

  const latest = snapshots[snapshots.length - 1];

  // ── 2. DIFF SNAPSHOTS ────────────────────────────────────────
  const FIELDS_TO_TRACK = [
    { key: "status", label: "Trạng thái" },
    { key: "totalPrice", label: "Tổng tiền", isMoney: true },
    { key: "address", label: "Địa chỉ" },
    { key: "paymentMethod", label: "Thanh toán" },
    { key: "paymentStatus", label: "Trạng thái thanh toán" },
    { key: "paidAmount", label: "Số tiền đã thu", isMoney: true },
    { key: "paymentVerified", label: "Xác nhận chuyển khoản", isBool: true },
    { key: "payOk", label: "PayOS tự động", isBool: true },
    { key: "paymentLocked", label: "Khóa thanh toán", isBool: true },
    { key: "batchId", label: "Lô hàng" },
    { key: "customerName", label: "Tên khách" },
  ];

  const changeEvents = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];

    for (const [id, order] of curr.orders) {
      if (!prev.orders.has(id)) {
        changeEvents.push({
          date: curr.date,
          orderId: id,
          customerName: order.customerName || "—",
          type: "NEW",
          field: null,
          from: null,
          to: order.totalPrice,
          order,
        });
        continue;
      }

      const prevOrder = prev.orders.get(id);
      const wasDeleted = isOrderDeleted(prevOrder);
      const nowDeleted = isOrderDeleted(order);
      if (wasDeleted !== nowDeleted) {
        changeEvents.push({
          date: curr.date,
          orderId: id,
          customerName: order.customerName || "—",
          type: nowDeleted ? "SOFT_DELETED" : "SOFT_RESTORED",
          field: "deleteFlag",
          fieldLabel: "Trạng thái xoá mềm",
          from: wasDeleted,
          to: nowDeleted,
          order,
        });
      }

      for (const f of FIELDS_TO_TRACK) {
        const a = prevOrder[f.key];
        const b = order[f.key];
        if (a !== b && !(a == null && b == null)) {
          changeEvents.push({
            date: curr.date,
            orderId: id,
            customerName: order.customerName || "—",
            type: "CHANGED",
            field: f.key,
            fieldLabel: f.label,
            isMoney: !!f.isMoney,
            from: a,
            to: b,
            order,
          });
        }
      }

      const prevItems = prevOrder.items || [];
      const currItems = order.items || [];
      const prevItemMap = new Map(prevItems.map((it) => [it.id || it.productId, it]));
      for (const it of currItems) {
        const key = it.id || it.productId;
        const prevIt = prevItemMap.get(key);
        if (prevIt && prevIt.price !== it.price) {
          const itemName = (it.name || "").trim();
          changeEvents.push({
            date: curr.date,
            orderId: id,
            customerName: order.customerName || "—",
            type: "PRICE_CHANGED",
            field: "item_price",
            fieldLabel: `Giá "${itemName}"`,
            itemName,
            isMoney: true,
            from: prevIt.price,
            to: it.price,
            order,
          });
        }
      }
    }

    for (const [id, order] of prev.orders) {
      if (!curr.orders.has(id)) {
        changeEvents.push({
          date: curr.date,
          orderId: id,
          customerName: order.customerName || "—",
          type: "REMOVED",
          field: null,
          from: order.totalPrice,
          to: null,
          order,
        });
      }
    }
  }

  console.log(`🔄 Phát hiện ${changeEvents.length} sự kiện thay đổi giữa các kỳ backup`);

  // ── 3. TRẠNG THÁI MỚI NHẤT & MASTER DATA LOOKUP ──────────────
  const allOrders = Array.from(latest.orders.values());
  const customerLookup = buildCustomerLookup(latest.customers);
  const liveOrders = allOrders.filter((o) => !isOrderDeleted(o));
  const deletedOrders = allOrders.filter((o) => isOrderDeleted(o));

  console.log(`📊 Tổng đơn hàng: ${allOrders.length} (hoạt động: ${liveOrders.length}, xoá mềm: ${deletedOrders.length})`);

  const STATUS_VI = {
    PENDING: "Chờ xử lý",
    IN_TRANSIT: "Đang giao",
    PICKED_UP: "Đã lấy hàng",
    DELIVERED: "Đã giao",
    CANCELLED: "Đã huỷ",
  };
  const PAY_VI = { CASH: "Tiền mặt", TRANSFER: "Chuyển khoản" };

  const statusCount = {};
  for (const o of liveOrders) {
    const s = o.status || "UNKNOWN";
    statusCount[s] = (statusCount[s] || 0) + 1;
  }

  const activeOrders = liveOrders.filter((o) => o.status !== "CANCELLED");

  let totalRevenue = 0;
  let deliveredRevenue = 0;
  let totalCollected = 0;
  let totalReceivable = 0;
  let totalCost = 0;
  let totalProfit = 0;
  let bankAutoCount = 0;
  let bankAutoRevenue = 0;
  let manualVerifiedCount = 0;
  let manualVerifiedRevenue = 0;
  let partiallyPaidCount = 0;
  let partiallyPaidRemaining = 0;
  let voidedCount = 0;
  let transferVerified = 0;
  let transferUnverified = 0;
  let transferUnverifiedRevenue = 0;

  const dailyMap = {};
  const dailyCountMap = {};
  const weeklyMap = {};
  const productMap = {};
  const customerMap = {};
  const paymentMap = {};

  for (const o of activeOrders) {
    const fin = computeOrderFinancials(o);
    totalRevenue += fin.orderTotal;
    if (o.status === "DELIVERED") deliveredRevenue += fin.orderTotal;
    if (fin.paymentStatus !== "VOIDED") {
      totalCollected += fin.orderPaid;
      totalReceivable += fin.orderReceivable;
    }
    totalCost += fin.orderCost;
    totalProfit += fin.orderProfit;

    if (fin.paymentStatus === "VERIFIED_BANK_AUTO") {
      bankAutoCount++;
      bankAutoRevenue += fin.orderPaid;
    } else if (fin.paymentStatus === "VERIFIED_MANUAL") {
      manualVerifiedCount++;
      manualVerifiedRevenue += fin.orderPaid;
    } else if (fin.paymentStatus === "PARTIALLY_PAID") {
      partiallyPaidCount++;
      partiallyPaidRemaining += fin.orderReceivable;
    } else if (fin.paymentStatus === "VOIDED") {
      voidedCount++;
    }

    if (fin.paymentMethod === "TRANSFER") {
      if (fin.paymentStatus === "VERIFIED_BANK_AUTO" || fin.paymentStatus === "VERIFIED_MANUAL") {
        transferVerified++;
      } else if (fin.paymentStatus === "PENDING_TRANSFER" || fin.paymentStatus === "PARTIALLY_PAID") {
        transferUnverified++;
        transferUnverifiedRevenue += fin.orderReceivable;
      }
    }

    paymentMap[fin.paymentMethod] = (paymentMap[fin.paymentMethod] || 0) + 1;

    // VN timezone daily & weekly buckets
    const ts = tsToMs(o.createdAt || o.updatedAt);
    if (ts) {
      const dk = toVNDateKey(ts);
      if (dk) {
        dailyMap[dk] = (dailyMap[dk] || 0) + fin.orderTotal;
        dailyCountMap[dk] = (dailyCountMap[dk] || 0) + 1;
      }
      const wk = toVNWeekKey(ts);
      if (wk) {
        weeklyMap[wk] = (weeklyMap[wk] || 0) + fin.orderTotal;
      }
    }

    for (const item of o.items || []) {
      const name = String(item.name || "Khác").trim();
      const qty = Number(item.quantity ?? item.qty ?? 0);
      const rev = Math.round(Number(item.price || 0) * qty);
      const cost = Math.round(Number(item.importPrice || 0) * qty);
      if (!productMap[name]) productMap[name] = { qty: 0, revenue: 0, cost: 0, profit: 0, orders: 0 };
      productMap[name].qty += qty;
      productMap[name].revenue += rev;
      productMap[name].cost += cost;
      productMap[name].profit += rev - cost;
      productMap[name].orders += 1;
    }

    const canonCust = resolveCanonicalCustomer(o, customerLookup);
    if (!customerMap[canonCust.key]) {
      customerMap[canonCust.key] = {
        key: canonCust.key,
        name: canonCust.name,
        phone: canonCust.phone,
        count: 0,
        revenue: 0,
        collected: 0,
        receivable: 0,
      };
    }
    customerMap[canonCust.key].count += 1;
    customerMap[canonCust.key].revenue += fin.orderTotal;
    customerMap[canonCust.key].collected += fin.orderPaid;
    customerMap[canonCust.key].receivable += fin.orderReceivable;
  }

  const avgOrderValue = activeOrders.length ? totalRevenue / activeOrders.length : 0;
  const profitMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  const dailyKeys = Object.keys(dailyMap).sort().slice(-90);
  const dailyRevenue = dailyKeys.map((k) => dailyMap[k]);
  const dailyCounts = dailyKeys.map((k) => dailyCountMap[k] || 0);

  const weeklyKeys = Object.keys(weeklyMap).sort().slice(-16);
  const weeklyRevenue = weeklyKeys.map((k) => weeklyMap[k]);

  const topProducts = Object.entries(productMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 12)
    .map(([name, v]) => ({
      name,
      qty: +v.qty.toFixed(2),
      revenue: v.revenue,
      cost: v.cost,
      profit: v.profit,
      orders: v.orders,
    }));

  const topCustomers = Object.values(customerMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 12);

  // ── Batches (tính cả collected, receivable, cost, profit) ──────
  const batchMap = {};
  for (const o of liveOrders) {
    const b = o.batchId || "Không có lô";
    if (!batchMap[b]) {
      batchMap[b] = {
        count: 0,
        revenue: 0,
        collected: 0,
        receivable: 0,
        cost: 0,
        profit: 0,
        cancelled: 0,
        products: {},
        firstDate: null,
        lastDate: null,
      };
    }
    const entry = batchMap[b];
    entry.count++;
    if (o.status === "CANCELLED") {
      entry.cancelled++;
    } else {
      const fin = computeOrderFinancials(o);
      entry.revenue += fin.orderTotal;
      if (fin.paymentStatus !== "VOIDED") {
        entry.collected += fin.orderPaid;
        entry.receivable += fin.orderReceivable;
      }
      entry.cost += fin.orderCost;
      entry.profit += fin.orderProfit;

      for (const item of o.items || []) {
        const name = String(item.name || "Khác").trim();
        const qty = Number(item.quantity ?? item.qty ?? 0);
        const rev = Math.round(Number(item.price || 0) * qty);
        if (!entry.products[name]) entry.products[name] = { qty: 0, revenue: 0 };
        entry.products[name].qty += qty;
        entry.products[name].revenue += rev;
      }
    }
    const t = tsToMs(o.createdAt);
    if (t) {
      if (entry.firstDate === null || t < entry.firstDate) entry.firstDate = t;
      if (entry.lastDate === null || t > entry.lastDate) entry.lastDate = t;
    }
  }

  const deletedCountByBatch = {};
  for (const o of deletedOrders) {
    const b = o.batchId || "Không có lô";
    deletedCountByBatch[b] = (deletedCountByBatch[b] || 0) + 1;
  }

  const allBatches = Object.entries(batchMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([name, v]) => ({
      name,
      count: v.count,
      revenue: v.revenue,
      collected: v.collected,
      receivable: v.receivable,
      cost: v.cost,
      profit: v.profit,
      cancelled: v.cancelled,
      deletedCount: deletedCountByBatch[name] || 0,
      firstDate: v.firstDate,
      lastDate: v.lastDate,
      totalQty: Object.values(v.products).reduce((s, p) => s + p.qty, 0),
      products: Object.entries(v.products)
        .sort((a, b) => b[1].qty - a[1].qty)
        .map(([pname, pv]) => ({ name: pname, qty: +pv.qty.toFixed(2), revenue: pv.revenue })),
    }));

  const topBatches = allBatches.slice(0, 15);

  // ── Ledger Cashflow Summary (payment_ledger) ─────────────────
  const ledgerBySource = {};
  const ledgerByDate = {};
  let ledgerNetCollected = 0;
  let ledgerTotalReversal = 0;

  for (const tx of latest.paymentLedger) {
    const src = tx.source || "UNKNOWN";
    const amt = Math.round(Number(tx.deltaAmount ?? tx.receivedAmount ?? 0));
    if (!ledgerBySource[src]) ledgerBySource[src] = { source: src, count: 0, netAmount: 0 };
    ledgerBySource[src].count += 1;
    ledgerBySource[src].netAmount += amt;

    if (amt < 0 || tx.action === "REVERSAL" || tx.action === "VOID") {
      ledgerTotalReversal += Math.abs(amt);
    } else {
      ledgerNetCollected += amt;
    }

    const dk = toVNDateKey(tx.createdAt);
    if (dk) {
      if (!ledgerByDate[dk]) ledgerByDate[dk] = { date: dk, netAmount: 0, count: 0 };
      ledgerByDate[dk].netAmount += amt;
      ledgerByDate[dk].count += 1;
    }
  }

  const ledgerRecent = latest.paymentLedger
    .slice()
    .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
    .slice(0, 100)
    .map((tx) => ({
      id: tx.id || tx._id || "",
      orderIds: tx.orderIds || [],
      source: tx.source || "UNKNOWN",
      action: tx.action || "CAPTURE",
      expectedAmount: Math.round(Number(tx.expectedAmount || 0)),
      receivedAmount: Math.round(Number(tx.receivedAmount || 0)),
      deltaAmount: Math.round(Number(tx.deltaAmount ?? tx.receivedAmount ?? 0)),
      bankRef: tx.bankRef || "",
      actorName: tx.actorName || "",
      reason: tx.reason || "",
      createdAt: tsToMs(tx.createdAt),
    }));

  // ── Snapshot Log ─────────────────────────────────────────────
  const snapshotSummaries = snapshots.map((s, i) => {
    const prev = i > 0 ? snapshots[i - 1] : null;
    let delta = { new: 0, changed: 0, removed: 0 };
    if (prev) {
      for (const ev of changeEvents) {
        if (ev.date !== s.date) continue;
        if (ev.type === "NEW") delta.new++;
        else if (ev.type === "REMOVED") delta.removed++;
        else delta.changed++;
      }
    }
    return { date: s.date, totalOrders: s.orders.size, ...delta };
  });

  const eventsByOrder = {};
  for (const ev of changeEvents) {
    if (!eventsByOrder[ev.orderId]) eventsByOrder[ev.orderId] = [];
    eventsByOrder[ev.orderId].push(ev);
  }

  const changeEventsFlat = changeEvents
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 500)
    .map((ev) => ({
      date: ev.date,
      orderId: ev.orderId,
      customerName: ev.customerName,
      type: ev.type,
      field: ev.field,
      fieldLabel: ev.fieldLabel,
      itemName: ev.itemName,
      isMoney: ev.isMoney,
      from: ev.from,
      to: ev.to,
    }));

  // ── Canonical Orders for UI & Customers Master Map ────────────
  const customersMaster = {};
  const allOrdersForUI = allOrders.map((o) => {
    const fin = computeOrderFinancials(o);
    const canonCust = resolveCanonicalCustomer(o, customerLookup);
    if (!customersMaster[canonCust.key]) {
      customersMaster[canonCust.key] = {
        key: canonCust.key,
        customerId: canonCust.customerId,
        name: canonCust.name,
        phone: canonCust.phone,
        address: canonCust.address,
        zaloLink: canonCust.zaloLink,
        messengerLink: canonCust.messengerLink,
      };
    }

    const orderId = o.id || o._id;
    return {
      id: orderId,
      customerId: canonCust.customerId,
      customerKey: canonCust.key,
      customerName: canonCust.name,
      orderCustomerName: (o.customerName || "—").trim(),
      customerPhone: canonCust.phone,
      address: (o.address || canonCust.address || "—").trim(),
      zaloLink: canonCust.zaloLink,
      messengerLink: canonCust.messengerLink,
      batchId: o.batchId || "—",
      totalPrice: fin.orderTotal,
      shippingFee: Math.round(Number(o.shippingFee || 0)),
      discount: Math.round(Number(o.discount || 0)),
      orderCost: fin.orderCost,
      orderProfit: fin.orderProfit,
      status: o.status || "UNKNOWN",
      paymentMethod: fin.paymentMethod,
      paymentStatus: fin.paymentStatus,
      paidAmount: fin.orderPaid,
      receivableAmount: fin.orderReceivable,
      paymentVerified: fin.paymentStatus === "VERIFIED_MANUAL" || fin.paymentStatus === "VERIFIED_BANK_AUTO",
      paymentVerifiedKnown: true,
      payOk: Boolean(o.payOk || fin.paymentStatus === "VERIFIED_BANK_AUTO"),
      payOkAt: tsToMs(o.payOkAt),
      paymentLocked: Boolean(o.paymentLocked || fin.orderPaid > 0),
      paymentVersion: Number(o.paymentVersion || 0),
      bankTransactionRef: o.bankTransactionRef || "",
      isPos: Boolean(o.isPos || String(o.address || "").trim().toLowerCase() === "mua tại quầy"),
      deleted: isOrderDeleted(o),
      createdAt: tsToMs(o.createdAt),
      updatedAt: tsToMs(o.updatedAt),
      items: (o.items || []).map((it) => ({
        name: String(it.name || "").trim(),
        qty: Number(it.quantity ?? it.qty ?? 0),
        price: Number(it.price || 0),
        importPrice: Number(it.importPrice || 0),
      })),
      hasHistory: !!eventsByOrder[orderId],
    };
  });

  const dashData = {
    meta: {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Ho_Chi_Minh",
      backupCount: backupFiles.length,
      backupDates: snapshots.map((s) => s.date),
      firstBackup: snapshots[0].date,
      lastBackup: latest.date,
      encrypted: Boolean(DASHBOARD_PASSWORD),
    },
    stats: {
      totalOrders: liveOrders.length,
      deletedCount: deletedOrders.length,
      totalRevenue,
      deliveredRevenue,
      totalCollected,
      totalReceivable,
      totalCost,
      totalProfit,
      profitMargin,
      avgOrderValue,
      pending: statusCount["PENDING"] || 0,
      inTransit: statusCount["IN_TRANSIT"] || 0,
      pickedUp: statusCount["PICKED_UP"] || 0,
      delivered: statusCount["DELIVERED"] || 0,
      cancelled: statusCount["CANCELLED"] || 0,
      totalCustomers: latest.customers.length,
      totalProducts: latest.products.length,
      bankAutoCount,
      bankAutoRevenue,
      manualVerifiedCount,
      manualVerifiedRevenue,
      partiallyPaidCount,
      partiallyPaidRemaining,
      voidedCount,
      transferVerified,
      transferUnverified,
      transferUnverifiedRevenue,
    },
    charts: {
      daily: { labels: dailyKeys, revenue: dailyRevenue, counts: dailyCounts },
      weekly: { labels: weeklyKeys, data: weeklyRevenue },
      status: {
        labels: Object.keys(statusCount).map((k) => STATUS_VI[k] || k),
        data: Object.values(statusCount),
      },
      payment: {
        labels: Object.keys(paymentMap).map((k) => PAY_VI[k] || k),
        data: Object.values(paymentMap),
      },
    },
    topProducts,
    topCustomers,
    topBatches,
    batches: allBatches,
    customersMaster,
    ledger: {
      totalEntries: latest.paymentLedger.length,
      netCollected: ledgerNetCollected,
      totalReversal: ledgerTotalReversal,
      bySource: Object.values(ledgerBySource).sort((a, b) => b.netAmount - a.netAmount),
      byDate: Object.values(ledgerByDate).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30),
      recent: ledgerRecent,
    },
    changeEvents: changeEventsFlat,
    changeEventsTotal: changeEvents.length,
    snapshotSummaries,
    orders: allOrdersForUI,
  };

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const rawJson = JSON.stringify(dashData);

  let embeddedPayloadStr;
  if (DASHBOARD_PASSWORD) {
    const encryptedObj = encryptPayloadAESGCM(rawJson, DASHBOARD_PASSWORD);
    embeddedPayloadStr = JSON.stringify(encryptedObj);
    console.log("🔐 Đã mã hóa toàn bộ dữ liệu Dashboard bằng AES-256-GCM (PBKDF2 100k)");
  } else {
    embeddedPayloadStr = rawJson;
    console.warn("⚠️  CẢNH BÁO BẢO MẬT: Chưa đặt secret DASHBOARD_PASSWORD — dữ liệu Dashboard chưa được mã hóa!");
  }

  let html = fs.readFileSync(TEMPLATE_PATH, "utf8");
  if (!html.includes("__DASHBOARD_DATA__")) {
    throw new Error("Template thiếu placeholder __DASHBOARD_DATA__");
  }
  // Dùng function replacement để tránh ký tự đặc biệt ($&, $') trong JSON làm hỏng replace
  html = html.replace("__DASHBOARD_DATA__", () => embeddedPayloadStr);
  const outHtmlPath = path.join(DIST_DIR, "index.html");
  fs.writeFileSync(outHtmlPath, html, "utf8");

  // Bảo đảm KHÔNG xuất file JSON thô dist/data.json công khai trên Pages
  const legacyDataJson = path.join(DIST_DIR, "data.json");
  if (fs.existsSync(legacyDataJson)) fs.unlinkSync(legacyDataJson);

  console.log(`\n✅ Dashboard built → ${outHtmlPath}`);
  console.log(
    `   ${liveOrders.length} đơn hoạt động (+ ${deletedOrders.length} xoá mềm) | ${allBatches.length} lô | ${latest.paymentLedger.length} ledger`
  );
  console.log(
    `   Ghi nhận: ${(totalRevenue / 1e6).toFixed(2)}M | Thực thu: ${(totalCollected / 1e6).toFixed(2)}M | Công nợ: ${(totalReceivable / 1e6).toFixed(2)}M | Lợi nhuận gộp: ${(totalProfit / 1e6).toFixed(2)}M`
  );

  return { dashData, outHtmlPath, encrypted: Boolean(DASHBOARD_PASSWORD) };
}

if (require.main === module) {
  try {
    buildDashboard();
  } catch (err) {
    console.error("❌ Lỗi build dashboard:", err.message || err);
    process.exit(1);
  }
}

module.exports = { buildDashboard, encryptPayloadAESGCM };
