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
 *  5. Anomaly detection trên giá, số lượng, doanh thu theo ngày
 *  6. Render dist/index.html (1 file, data nhúng inline)
 */

const fs = require("fs");
const path = require("path");

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
  .filter((f) => f.match(/^backup-\d{4}-\d{2}-\d{2}\.json$/))
  .sort();

if (backupFiles.length === 0) {
  console.error("Không tìm thấy file backup nào trong /backups/");
  process.exit(1);
}

console.log(`📦 ${backupFiles.length} file backup: ${backupFiles.join(", ")}`);

const snapshots = []; // [{ date, orders: Map<id, order> }]

for (const file of backupFiles) {
  const date = file.replace("backup-", "").replace(".json", "");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), "utf8"));
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
// doanh thu, sản phẩm, lô hàng, anomaly. Người dùng hay xoá mềm thay vì
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
// 4. ANOMALY DETECTION
// ════════════════════════════════════════════════════════════
const anomalies = [];

// (a) Giá bất thường: item price lệch >2.5 std-dev khỏi giá trung bình SẢN PHẨM CÙNG TÊN
const priceByProduct = {};
for (const o of activeOrders) {
  for (const item of o.items || []) {
    const name = (item.name || "").trim();
    if (!name || !item.price) continue;
    if (!priceByProduct[name]) priceByProduct[name] = [];
    priceByProduct[name].push({ price: item.price, orderId: o.id, customerName: o.customerName });
  }
}
for (const [name, prices] of Object.entries(priceByProduct)) {
  if (prices.length < 5) continue; // cần đủ mẫu
  const vals = prices.map((p) => p.price);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance);
  if (std === 0) continue;
  for (const p of prices) {
    const z = (p.price - mean) / std;
    if (Math.abs(z) > 2.8) {
      anomalies.push({
        type: "PRICE_OUTLIER",
        severity: Math.abs(z) > 4 ? "high" : "medium",
        title: `Giá bất thường: ${name}`,
        detail: `${p.price.toLocaleString("vi-VN")}đ (TB: ${Math.round(mean).toLocaleString("vi-VN")}đ, z=${z.toFixed(1)})`,
        orderId: p.orderId,
        customerName: p.customerName,
      });
    }
  }
}

// (b) Đơn giá trị quá cao so với phân phối chung
{
  const vals = activeOrders.map((o) => o.totalPrice || 0).filter((v) => v > 0);
  if (vals.length > 10) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    for (const o of activeOrders) {
      const z = std ? (o.totalPrice - mean) / std : 0;
      if (z > 3.5) {
        anomalies.push({
          type: "ORDER_VALUE_HIGH",
          severity: z > 5 ? "high" : "medium",
          title: `Đơn giá trị cao bất thường`,
          detail: `${(o.totalPrice || 0).toLocaleString("vi-VN")}đ (TB: ${Math.round(mean).toLocaleString("vi-VN")}đ)`,
          orderId: o.id,
          customerName: o.customerName,
        });
      }
    }
  }
}

// (c) Doanh thu ngày bất thường (spike / drop so với 14 ngày liền trước)
for (let i = 7; i < dailyKeys.length; i++) {
  const window = dailyRevenue.slice(Math.max(0, i - 14), i);
  if (window.length < 5) continue;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const std = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
  if (std === 0) continue;
  const z = (dailyRevenue[i] - mean) / std;
  if (Math.abs(z) > 2.5) {
    anomalies.push({
      type: z > 0 ? "REVENUE_SPIKE" : "REVENUE_DROP",
      severity: Math.abs(z) > 3.5 ? "high" : "medium",
      title: z > 0 ? "Doanh thu tăng vọt" : "Doanh thu sụt giảm",
      detail: `${dailyKeys[i]}: ${dailyRevenue[i].toLocaleString("vi-VN")}đ (TB 14 ngày: ${Math.round(mean).toLocaleString("vi-VN")}đ)`,
      date: dailyKeys[i],
    });
  }
}

// (d) Khách hàng đặt đơn liên tiếp bất thường nhanh (khả năng trùng / spam)
{
  const byCustomer = {};
  for (const o of activeOrders) {
    const cid = o.customerId || o.customerName;
    if (!cid) continue;
    if (!byCustomer[cid]) byCustomer[cid] = [];
    const d = tsToDate(o.createdAt);
    if (d) byCustomer[cid].push({ time: d.getTime(), order: o });
  }
  for (const [cid, list] of Object.entries(byCustomer)) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.time - b.time);
    for (let i = 1; i < list.length; i++) {
      const diffMin = (list[i].time - list[i - 1].time) / 60000;
      if (diffMin < 3 && diffMin >= 0) {
        anomalies.push({
          type: "DUPLICATE_SUSPECT",
          severity: "low",
          title: "Khả năng đơn trùng lặp",
          detail: `${list[i].order.customerName || "—"}: 2 đơn cách nhau ${diffMin.toFixed(1)} phút`,
          orderId: list[i].order.id,
          customerName: list[i].order.customerName,
        });
      }
    }
  }
}

// (e) Đơn PENDING quá lâu (>5 ngày kể từ createdAt, vẫn pending tại snapshot cuối)
{
  const now = Date.now();
  for (const o of liveOrders) {
    if (o.status !== "PENDING") continue;
    const d = tsToDate(o.createdAt);
    if (!d) continue;
    const ageDays = (now - d.getTime()) / 86400000;
    if (ageDays > 5) {
      anomalies.push({
        type: "STALE_PENDING",
        severity: ageDays > 14 ? "high" : "medium",
        title: "Đơn chờ xử lý quá lâu",
        detail: `${o.customerName || "—"}: ${Math.floor(ageDays)} ngày chưa xử lý`,
        orderId: o.id,
        customerName: o.customerName,
      });
    }
  }
}

// (f) Chuyển khoản chưa xác nhận quá lâu (>3 ngày, vẫn chưa verified tại snapshot cuối)
{
  const now = Date.now();
  for (const o of liveOrders) {
    if (o.paymentMethod !== "TRANSFER") continue;
    if (o.paymentVerified === true) continue;
    if (o.status === "CANCELLED") continue;
    const d = tsToDate(o.createdAt);
    if (!d) continue;
    const ageDays = (now - d.getTime()) / 86400000;
    if (ageDays > 3) {
      anomalies.push({
        type: "UNVERIFIED_TRANSFER",
        severity: ageDays > 10 ? "high" : "medium",
        title: "Chuyển khoản chưa xác nhận",
        detail: `${o.customerName || "—"}: ${(o.totalPrice || 0).toLocaleString("vi-VN")}đ · ${Math.floor(ageDays)} ngày chưa xác nhận`,
        orderId: o.id,
        customerName: o.customerName,
      });
    }
  }
}

// Chọn đại diện cân đối: ưu tiên mỗi LOẠI bất thường đều có mặt (tối đa N/loại),
// trong mỗi loại thì ưu tiên severity cao trước. Tránh trường hợp loại xuất hiện
// nhiều (như STALE_PENDING) lấn hết chỗ của loại khác (như UNVERIFIED_TRANSFER).
const SEV_RANK = { high: 3, medium: 2, low: 1 };
const PER_TYPE_LIMIT = 15;
const byType = {};
for (const a of anomalies) {
  (byType[a.type] = byType[a.type] || []).push(a);
}
let topAnomalies = [];
for (const type of Object.keys(byType)) {
  const sorted = byType[type].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  topAnomalies.push(...sorted.slice(0, PER_TYPE_LIMIT));
}
// Sắp xếp lại toàn bộ theo severity để hiển thị cái nghiêm trọng nhất lên đầu
topAnomalies.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

console.log(`🔍 Phát hiện ${anomalies.length} bất thường (hiển thị top ${topAnomalies.length})`);

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
  anomalies: topAnomalies,
  anomalyTotal: anomalies.length,
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
  `   ${liveOrders.length} đơn hoạt động (+ ${deletedOrders.length} đã xoá mềm) | ${allBatches.length} lô hàng | ${changeEvents.length} thay đổi | ${anomalies.length} bất thường`
);
console.log(
  `   Doanh thu: ${(totalRevenue / 1e6).toFixed(2)}M đ | Chuyển khoản chưa xác nhận: ${transferUnverified} đơn (${(transferUnverifiedRevenue / 1e6).toFixed(2)}M đ)`
);
