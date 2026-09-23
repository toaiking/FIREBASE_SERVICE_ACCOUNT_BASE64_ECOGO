"use strict";
/**
 * build-dashboard.js
 * ─────────────────────────────────────────────────────────────
 * Đọc tất cả backup-YYYY-MM-DD.json trong /backups/ (mỗi file là
 * một snapshot TOÀN BỘ collection `orders` tại thời điểm đó —
 * KHÔNG dùng audit_logs vì field này đã bị loại bỏ khỏi DB).
 *
 * Pipeline:
 *  1. Đọc & sắp xếp snapshot theo ngày
 *  2. Diff từng cặp snapshot liên tiếp → sinh "change events"
 *     (đơn mới / đổi trạng thái / đổi giá / đổi địa chỉ / xoá đơn)
 *  3. Gộp toàn bộ đơn hàng về trạng thái mới nhất (từ snapshot mới nhất)
 *  4. Tính KPI, top sản phẩm/khách hàng/lô hàng
 *  5. Render dist/index.html (1 file, data nhúng inline)
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BACKUP_DIR = "./backups";
const DIST_DIR = "./dist";

// ════════════════════════════════════════════════════════════
// 1. ĐỌC SNAPSHOT
// ════════════════════════════════════════════════════════════
if (!fs.existsSync(BACKUP_DIR)) {
  console.error("Không tìm thấy thư mục backups/");
  process.exit(1);
}

const backupFiles = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => f.match(/^backup-\d{4}-\d{2}-\d{2}\.json(\.gz)?$/))
  .sort();

if (backupFiles.length === 0) {
  console.error("Không tìm thấy file backup nào trong /backups/");
  process.exit(1);
}

console.log(`📦 ${backupFiles.length} file backup: ${backupFiles.join(", ")}`);

const snapshots = []; // [{ date, orders: Map<id, order> }]

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
    rawCount: list.length,
  });

  console.log(`  ✓ ${file}: ${orderMap.size} đơn hàng`);
}

if (snapshots.length === 0) {
  console.error("Không có snapshot hợp lệ nào.");
  process.exit(1);
}

const latest = snapshots[snapshots.length - 1];

// ════════════════════════════════════════════════════════════
// 2. DIFF GIỮA CÁC SNAPSHOT LIÊN TIẾP → LỊCH SỬ THAY ĐỔI
// ════════════════════════════════════════════════════════════
// changeEvents: mỗi event mô tả 1 thay đổi cụ thể của 1 đơn hàng
// giữa backup (i-1) và backup (i)
const FIELDS_TO_TRACK = [
  { key: "status", label: "Trạng thái" },
  { key: "totalPrice", label: "Tổng tiền", isMoney: true },
  { key: "address", label: "Địa chỉ" },
  { key: "paymentMethod", label: "Thanh toán" },
  { key: "paymentVerified", label: "Xác nhận chuyển khoản", isBool: true },
  { key: "batchId", label: "Lô hàng" },
  { key: "customerName", label: "Tên khách" },
];

function isDeleted(o) {
  return o && (o.deleteFlag === true || o.deleteFlag === 1);
}

const changeEvents = []; // { date, orderId, customerName, type, field, from, to }

for (let i = 1; i < snapshots.length; i++) {
  const prev = snapshots[i - 1];
  const curr = snapshots[i];

  // Đơn mới xuất hiện
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

    // Đơn đã tồn tại — so sánh field
    const prevOrder = prev.orders.get(id);

    // ── Soft-delete / khôi phục: xử lý riêng (ưu tiên hơn field thường) ──
    const wasDeleted = isDeleted(prevOrder);
    const nowDeleted = isDeleted(order);
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

    // So sánh items (giá / số lượng từng món)
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

  // Đơn biến mất (có ở prev nhưng không có ở curr)
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

// ════════════════════════════════════════════════════════════
// 3. TRẠNG THÁI MỚI NHẤT CỦA TOÀN BỘ ĐƠN (từ snapshot cuối)
// ════════════════════════════════════════════════════════════
const allOrders = Array.from(latest.orders.values());

// Tách đơn đã xoá mềm (deleteFlag=true) ra riêng — KHÔNG tính vào KPI,
// doanh thu, sản phẩm, lô hàng. Người dùng hay xoá mềm thay vì
// chuyển status sang CANCELLED, nên nếu không tách sẽ làm sai số liệu.
const liveOrders = allOrders.filter((o) => !isDeleted(o));
const deletedOrders = allOrders.filter((o) => isDeleted(o));

console.log(
  `📊 Tổng đơn hàng: ${allOrders.length} (đang hoạt động: ${liveOrders.length}, đã xoá mềm: ${deletedOrders.length})`
);

const STATUS_VI = {
  PENDING: "Chờ xử lý",
  IN_TRANSIT: "Đang giao",
  PICKED_UP: "Đã lấy hàng",
  DELIVERED: "Đã giao",
  CANCELLED: "Đã huỷ",
};
const PAY_VI = { CASH: "Tiền mặt", TRANSFER: "Chuyển khoản", COD: "Thu hộ (COD)" };

function tsToDate(ts) {
  if (!ts) return null;
  return new Date(ts > 1e12 ? ts : ts * 1000);
}

// ── Status distribution (chỉ tính đơn đang hoạt động) ───────
const statusCount = {};
for (const o of liveOrders) {
  const s = o.status || "UNKNOWN";
  statusCount[s] = (statusCount[s] || 0) + 1;
}

// ── Revenue (chỉ tính đơn đang hoạt động, không xoá mềm, không huỷ) ──
const activeOrders = liveOrders.filter((o) => o.status !== "CANCELLED");
const totalRevenue = activeOrders.reduce((s, o) => s + (o.totalPrice || 0), 0);
const deliveredRevenue = liveOrders
  .filter((o) => o.status === "DELIVERED")
  .reduce((s, o) => s + (o.totalPrice || 0), 0);
const avgOrderValue = activeOrders.length ? totalRevenue / activeOrders.length : 0;

// ── Daily revenue (90 ngày) ─────────────────────────────────
const dailyMap = {};
const dailyCountMap = {};
for (const o of activeOrders) {
  const d = tsToDate(o.createdAt || o.updatedAt);
  if (!d) continue;
  const key = d.toISOString().slice(0, 10);
  dailyMap[key] = (dailyMap[key] || 0) + (o.totalPrice || 0);
  dailyCountMap[key] = (dailyCountMap[key] || 0) + 1;
}
const dailyKeys = Object.keys(dailyMap).sort().slice(-90);
const dailyRevenue = dailyKeys.map((k) => dailyMap[k]);
const dailyCounts = dailyKeys.map((k) => dailyCountMap[k] || 0);

// ── Weekly revenue (16 tuần) ────────────────────────────────
const weeklyMap = {};
for (const o of activeOrders) {
  const d = tsToDate(o.createdAt || o.updatedAt);
  if (!d) continue;
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const key = monday.toISOString().slice(0, 10);
  weeklyMap[key] = (weeklyMap[key] || 0) + (o.totalPrice || 0);
}
const weeklyKeys = Object.keys(weeklyMap).sort().slice(-16);
const weeklyRevenue = weeklyKeys.map((k) => weeklyMap[k]);

// ── Top products ────────────────────────────────────────────
const productMap = {};
for (const o of activeOrders) {
  for (const item of o.items || []) {
    const name = (item.name || "Khác").trim();
    if (!productMap[name]) productMap[name] = { qty: 0, revenue: 0, orders: 0 };
    productMap[name].qty += item.quantity || 0;
    productMap[name].revenue += (item.price || 0) * (item.quantity || 0);
    productMap[name].orders += 1;
  }
}
const topProducts = Object.entries(productMap)
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .slice(0, 12)
  .map(([name, v]) => ({ name, qty: +v.qty.toFixed(2), revenue: v.revenue, orders: v.orders }));

// ── Top customers ───────────────────────────────────────────
const customerMap = {};
for (const o of activeOrders) {
  const name = o.customerName || "Không rõ";
  if (!customerMap[name]) customerMap[name] = { count: 0, revenue: 0, phone: o.customerPhone || "" };
  customerMap[name].count++;
  customerMap[name].revenue += o.totalPrice || 0;
}
const topCustomers = Object.entries(customerMap)
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .slice(0, 12)
  .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue, phone: v.phone }));

// ── Batches ─────────────────────────────────────────────────
// Mỗi lô: tổng đơn (đang hoạt động), doanh thu, số huỷ, số xoá mềm,
// VÀ tổng số lượng từng sản phẩm trong lô — CHỈ tính trên liveOrders
// để số liệu không bị lẫn đơn đã xoá mềm.
const batchMap = {};
for (const o of liveOrders) {
  const b = o.batchId || "Không có lô";
  if (!batchMap[b]) {
    batchMap[b] = { count: 0, revenue: 0, cancelled: 0, products: {}, firstDate: null, lastDate: null };
  }
  const entry = batchMap[b];
  entry.count++;
  if (o.status === "CANCELLED") entry.cancelled++;
  else {
    entry.revenue += o.totalPrice || 0;
    // Gộp số lượng từng sản phẩm (bỏ qua đơn đã huỷ — không tính vào sản lượng thực)
    for (const item of o.items || []) {
      const name = (item.name || "Khác").trim();
      if (!entry.products[name]) entry.products[name] = { qty: 0, revenue: 0 };
      entry.products[name].qty += item.quantity || 0;
      entry.products[name].revenue += (item.price || 0) * (item.quantity || 0);
    }
  }
  const d = tsToDate(o.createdAt);
  if (d) {
    const t = d.getTime();
    if (entry.firstDate === null || t < entry.firstDate) entry.firstDate = t;
    if (entry.lastDate === null || t > entry.lastDate) entry.lastDate = t;
  }
}

// Đếm riêng số đơn đã xoá mềm thuộc mỗi lô (chỉ để hiển thị, không gộp vào count/revenue)
const deletedCountByBatch = {};
for (const o of deletedOrders) {
  const b = o.batchId || "Không có lô";
  deletedCountByBatch[b] = (deletedCountByBatch[b] || 0) + 1;
}

// Toàn bộ lô hàng (không cắt top N) — để hỗ trợ lọc đầy đủ trên UI
const allBatches = Object.entries(batchMap)
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .map(([name, v]) => ({
    name,
    count: v.count,
    revenue: v.revenue,
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

// ── Payment methods ─────────────────────────────────────────
const paymentMap = {};
for (const o of activeOrders) {
  const m = o.paymentMethod || "UNKNOWN";
  paymentMap[m] = (paymentMap[m] || 0) + 1;
}

// ── Xác nhận chuyển khoản (chỉ áp dụng cho phương thức TRANSFER) ──
const transferOrders = activeOrders.filter((o) => o.paymentMethod === "TRANSFER");
const transferVerified = transferOrders.filter((o) => o.paymentVerified === true).length;
const transferUnverified = transferOrders.filter((o) => o.paymentVerified !== true).length;
const transferUnverifiedRevenue = transferOrders
  .filter((o) => o.paymentVerified !== true)
  .reduce((s, o) => s + (o.totalPrice || 0), 0);



// ════════════════════════════════════════════════════════════
// 5. SNAPSHOT LOG (cho phần lịch sử backup)
// ════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════
// 6. CHUẨN BỊ DATA CHO LỊCH SỬ THAY ĐỔI (UI)
// ════════════════════════════════════════════════════════════
// Nhóm change events theo orderId để hiển thị timeline mỗi đơn
const eventsByOrder = {};
for (const ev of changeEvents) {
  if (!eventsByOrder[ev.orderId]) eventsByOrder[ev.orderId] = [];
  eventsByOrder[ev.orderId].push(ev);
}

// Danh sách phẳng cho bảng "Lịch sử thay đổi" (mới nhất trước)
const changeEventsFlat = changeEvents
  .slice()
  .sort((a, b) => (a.date < b.date ? 1 : -1))
  .slice(0, 500) // giới hạn payload
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

// ════════════════════════════════════════════════════════════
// 7. ĐƠN HÀNG ĐẦY ĐỦ (cho tìm kiếm/lọc — không giới hạn 50 nữa)
// ════════════════════════════════════════════════════════════
const allOrdersForUI = allOrders.map((o) => ({
  id: o.id || o._id,
  customerName: o.customerName || "—",
  customerPhone: o.customerPhone || "",
  address: o.address || "—",
  batchId: o.batchId || "—",
  totalPrice: o.totalPrice || 0,
  status: o.status || "UNKNOWN",
  paymentMethod: o.paymentMethod || "—",
  paymentVerified: o.paymentVerified === true,
  paymentVerifiedKnown: typeof o.paymentVerified === "boolean",
  deleted: isDeleted(o),
  createdAt: o.createdAt || 0,
  updatedAt: o.updatedAt || 0,
  items: (o.items || []).map((it) => ({
    name: (it.name || "").trim(),
    qty: it.quantity,
    price: it.price,
  })),
  hasHistory: !!eventsByOrder[o.id || o._id],
}));

// ════════════════════════════════════════════════════════════
// 8. ĐÓNG GÓI DATA
// ════════════════════════════════════════════════════════════
const dashData = {
  meta: {
    generatedAt: new Date().toISOString(),
    backupCount: backupFiles.length,
    backupDates: snapshots.map((s) => s.date),
    firstBackup: snapshots[0].date,
    lastBackup: latest.date,
  },
  stats: {
    totalOrders: liveOrders.length,
    deletedCount: deletedOrders.length,
    totalRevenue,
    deliveredRevenue,
    avgOrderValue,
    pending: statusCount["PENDING"] || 0,
    inTransit: statusCount["IN_TRANSIT"] || 0,
    pickedUp: statusCount["PICKED_UP"] || 0,
    delivered: statusCount["DELIVERED"] || 0,
    cancelled: statusCount["CANCELLED"] || 0,
    totalCustomers: latest.customers.length,
    totalProducts: latest.products.length,
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
  changeEvents: changeEventsFlat,
  changeEventsTotal: changeEvents.length,
  snapshotSummaries,
  orders: allOrdersForUI,
};

// ════════════════════════════════════════════════════════════
// 9. GHI FILE
// ════════════════════════════════════════════════════════════
fs.mkdirSync(DIST_DIR, { recursive: true });
const dataJsonPath = path.join(DIST_DIR, "data.json");
fs.writeFileSync(dataJsonPath, JSON.stringify(dashData), "utf8");

const templatePath = path.join(__dirname, "dashboard-template.html");
let html = fs.readFileSync(templatePath, "utf8");
html = html.replace("__DASHBOARD_DATA__", JSON.stringify(dashData));
fs.writeFileSync(path.join(DIST_DIR, "index.html"), html, "utf8");

console.log(`\n✅ Dashboard built → dist/index.html`);
console.log(
  `   ${liveOrders.length} đơn hoạt động (+ ${deletedOrders.length} đã xoá mềm) | ${allBatches.length} lô hàng | ${changeEvents.length} thay đổi`
);
console.log(
  `   Doanh thu: ${(totalRevenue / 1e6).toFixed(2)}M đ | Chuyển khoản chưa xác nhận: ${transferUnverified} đơn (${(transferUnverifiedRevenue / 1e6).toFixed(2)}M đ)`
);
