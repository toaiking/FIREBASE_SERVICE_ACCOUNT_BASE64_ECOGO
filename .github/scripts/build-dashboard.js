"use strict";
/**
 * build-dashboard.js
 * Đọc tất cả file backup-YYYY-MM-DD.json trong /backups/
 * Reconstruct trạng thái đơn hàng mới nhất từ audit_logs + orders
 * Tạo dist/index.html với dashboard tĩnh, nhúng dữ liệu inline
 */

const fs = require("fs");
const path = require("path");

// ════════════════════════════════════════════════════════════
// 1. ĐỌC TẤT CẢ FILE BACKUP
// ════════════════════════════════════════════════════════════
const BACKUP_DIR = "./backups";
const DIST_DIR = "./dist";

if (!fs.existsSync(BACKUP_DIR)) {
  console.error("Không tìm thấy thư mục backups/");
  process.exit(1);
}

const backupFiles = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => f.match(/^backup-\d{4}-\d{2}-\d{2}\.json$/))
  .sort(); // cũ → mới

if (backupFiles.length === 0) {
  console.error("Không tìm thấy file backup nào trong /backups/");
  process.exit(1);
}

console.log(`📦 Tìm thấy ${backupFiles.length} file backup: ${backupFiles.join(", ")}`);

// ════════════════════════════════════════════════════════════
// 2. MERGE: Reconstruct đơn hàng từ audit_logs + orders
// ════════════════════════════════════════════════════════════
// Strategy: dùng audit_logs để lấy snapshot mới nhất của mỗi đơn
// Ưu tiên bản ghi từ file backup MỚI NHẤT (ghi đè file cũ)

const orderMap = new Map();    // orderId → order data (trạng thái mới nhất)
const snapshotLog = [];        // thống kê từng lần backup
const allBatches = new Set();  // tên lô hàng

for (const file of backupFiles) {
  const dateStr = file.replace("backup-", "").replace(".json", "");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), "utf8"));
  } catch (e) {
    console.warn(`⚠️  Bỏ qua file lỗi: ${file}`);
    continue;
  }

  let processedOrders = 0;

  // ── Từ audit_logs: lấy newData của mỗi action ──────────────
  const auditLogs = raw.audit_logs || [];
  // Sắp xếp theo timestamp để đảm bảo xử lý theo thứ tự thời gian
  const sorted = [...auditLogs].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  for (const log of sorted) {
    if (!["CREATE_ORDER", "UPDATE_ORDER"].includes(log.action)) continue;
    const data = log.newData;
    if (!data || !data.id) continue;

    const existing = orderMap.get(data.id);
    // Ghi đè nếu version mới hơn hoặc updatedAt mới hơn
    const newVersion = data.version || 0;
    const existingVersion = existing?.version || -1;
    const newUpdatedAt = data.updatedAt || 0;
    const existingUpdatedAt = existing?.updatedAt || -1;

    if (!existing || newVersion > existingVersion || newUpdatedAt > existingUpdatedAt) {
      orderMap.set(data.id, { ...data, _backupDate: dateStr });
      processedOrders++;
    }

    if (data.batchId) allBatches.add(data.batchId);
  }

  // ── Từ collection orders (nếu có) ──────────────────────────
  const directOrders = raw.orders || [];
  for (const order of directOrders) {
    if (!order.id && !order._id) continue;
    const id = order.id || order._id;
    const existing = orderMap.get(id);
    const newUpdatedAt = order.updatedAt || 0;
    const existingUpdatedAt = existing?.updatedAt || -1;
    if (!existing || newUpdatedAt > existingUpdatedAt) {
      orderMap.set(id, { ...order, id, _backupDate: dateStr });
      processedOrders++;
    }
    if (order.batchId) allBatches.add(order.batchId);
  }

  snapshotLog.push({
    date: dateStr,
    auditCount: auditLogs.length,
    processedOrders,
    totalKnownOrders: orderMap.size,
  });

  console.log(
    `  ✓ ${file}: ${auditLogs.length} audit logs, ${processedOrders} đơn cập nhật → tổng ${orderMap.size} đơn`
  );
}

const allOrders = Array.from(orderMap.values());
console.log(`\n📊 Tổng cộng: ${allOrders.length} đơn hàng từ ${backupFiles.length} backup`);

// ════════════════════════════════════════════════════════════
// 3. TÍNH TOÁN THỐNG KÊ
// ════════════════════════════════════════════════════════════

// ── Trạng thái đơn ─────────────────────────────────────────
const STATUS_VI = {
  PENDING:    "Chờ xử lý",
  IN_TRANSIT: "Đang giao",
  DELIVERED:  "Đã giao",
  CANCELLED:  "Đã huỷ",
  PAID:       "Đã thanh toán",
};

const statusCount = {};
for (const o of allOrders) {
  const s = o.status || "UNKNOWN";
  statusCount[s] = (statusCount[s] || 0) + 1;
}

// ── Doanh thu ───────────────────────────────────────────────
const totalRevenue = allOrders
  .filter((o) => o.status !== "CANCELLED")
  .reduce((s, o) => s + (o.totalPrice || 0), 0);

const deliveredRevenue = allOrders
  .filter((o) => o.status === "DELIVERED")
  .reduce((s, o) => s + (o.totalPrice || 0), 0);

// ── Doanh thu theo ngày (30 ngày gần nhất) ─────────────────
const dailyMap = {};
for (const o of allOrders) {
  if (o.status === "CANCELLED") continue;
  const ts = o.createdAt || o.updatedAt || 0;
  const d = new Date(typeof ts === "number" && ts > 1e12 ? ts : ts * 1000);
  const key = d.toISOString().slice(0, 10);
  dailyMap[key] = (dailyMap[key] || 0) + (o.totalPrice || 0);
}
const dailyKeys = Object.keys(dailyMap).sort().slice(-30);
const dailyRevenue = dailyKeys.map((k) => dailyMap[k]);

// ── Doanh thu theo tuần (12 tuần gần nhất) ─────────────────
const weeklyMap = {};
for (const o of allOrders) {
  if (o.status === "CANCELLED") continue;
  const ts = o.createdAt || o.updatedAt || 0;
  const d = new Date(typeof ts === "number" && ts > 1e12 ? ts : ts * 1000);
  // Week key: ISO week
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const key = monday.toISOString().slice(0, 10);
  weeklyMap[key] = (weeklyMap[key] || 0) + (o.totalPrice || 0);
}
const weeklyKeys = Object.keys(weeklyMap).sort().slice(-12);
const weeklyRevenue = weeklyKeys.map((k) => weeklyMap[k]);

// ── Sản phẩm bán chạy ──────────────────────────────────────
const productMap = {};
for (const o of allOrders) {
  if (o.status === "CANCELLED") continue;
  const items = o.items || [];
  for (const item of items) {
    const name = (item.name || "Khác").trim();
    if (!productMap[name]) productMap[name] = { qty: 0, revenue: 0 };
    productMap[name].qty += item.quantity || 0;
    productMap[name].revenue += (item.price || 0) * (item.quantity || 0);
  }
}
const topProducts = Object.entries(productMap)
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .slice(0, 10)
  .map(([name, v]) => ({ name, qty: +v.qty.toFixed(2), revenue: v.revenue }));

// ── Phương thức thanh toán ──────────────────────────────────
const paymentMap = {};
for (const o of allOrders) {
  if (o.status === "CANCELLED") continue;
  const m = o.paymentMethod || "UNKNOWN";
  paymentMap[m] = (paymentMap[m] || 0) + 1;
}

// ── Top khách hàng ──────────────────────────────────────────
const customerMap = {};
for (const o of allOrders) {
  if (o.status === "CANCELLED") continue;
  const name = o.customerName || "Không rõ";
  if (!customerMap[name]) customerMap[name] = { count: 0, revenue: 0 };
  customerMap[name].count++;
  customerMap[name].revenue += o.totalPrice || 0;
}
const topCustomers = Object.entries(customerMap)
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .slice(0, 10)
  .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue }));

// ── Lô hàng (batches) ───────────────────────────────────────
const batchMap = {};
for (const o of allOrders) {
  const b = o.batchId || "Không có lô";
  if (!batchMap[b]) batchMap[b] = { count: 0, revenue: 0 };
  batchMap[b].count++;
  if (o.status !== "CANCELLED") batchMap[b].revenue += o.totalPrice || 0;
}
const topBatches = Object.entries(batchMap)
  .sort((a, b) => b[1].revenue - a[1].revenue)
  .slice(0, 8)
  .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue }));

// ── 50 đơn hàng mới nhất ───────────────────────────────────
const recentOrders = [...allOrders]
  .sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || 0;
    const tb = b.updatedAt || b.createdAt || 0;
    return tb - ta;
  })
  .slice(0, 50)
  .map((o) => ({
    id: o.id || o._id,
    customerName: o.customerName || "—",
    address: o.address || "—",
    batchId: o.batchId || "—",
    totalPrice: o.totalPrice || 0,
    status: o.status || "UNKNOWN",
    paymentMethod: o.paymentMethod || "—",
    createdAt: o.createdAt || 0,
    itemCount: (o.items || []).length,
    _backupDate: o._backupDate,
  }));

// ════════════════════════════════════════════════════════════
// 4. GÓI DATA VÀ BUILD HTML
// ════════════════════════════════════════════════════════════
const dashData = {
  meta: {
    generatedAt: new Date().toISOString(),
    backupCount: backupFiles.length,
    backupDates: backupFiles.map((f) => f.replace("backup-", "").replace(".json", "")),
    lastBackup: backupFiles[backupFiles.length - 1]
      ?.replace("backup-", "")
      .replace(".json", ""),
  },
  stats: {
    totalOrders: allOrders.length,
    totalRevenue,
    deliveredRevenue,
    pending: statusCount["PENDING"] || 0,
    inTransit: statusCount["IN_TRANSIT"] || 0,
    delivered: statusCount["DELIVERED"] || 0,
    cancelled: statusCount["CANCELLED"] || 0,
  },
  charts: {
    daily: { labels: dailyKeys, data: dailyRevenue },
    weekly: { labels: weeklyKeys, data: weeklyRevenue },
    status: {
      labels: Object.keys(statusCount).map((k) => STATUS_VI[k] || k),
      data: Object.values(statusCount),
    },
    payment: {
      labels: Object.keys(paymentMap),
      data: Object.values(paymentMap),
    },
  },
  topProducts,
  topCustomers,
  topBatches,
  recentOrders,
  snapshotLog,
};

// ════════════════════════════════════════════════════════════
// 5. VIẾT FILE HTML
// ════════════════════════════════════════════════════════════
fs.mkdirSync(DIST_DIR, { recursive: true });

const html = buildHTML(dashData);
fs.writeFileSync(path.join(DIST_DIR, "index.html"), html, "utf8");

console.log(`\n✅ Dashboard built → dist/index.html`);
console.log(`   ${allOrders.length} đơn hàng | ${topProducts.length} sản phẩm | doanh thu: ${(totalRevenue/1e6).toFixed(2)}M đ`);

// ════════════════════════════════════════════════════════════
// 6. HTML TEMPLATE
// ════════════════════════════════════════════════════════════
function fmtMoney(n) {
  return new Intl.NumberFormat("vi-VN").format(Math.round(n)) + "đ";
}

function buildHTML(data) {
  const D = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EcoGo Dashboard – Nấm Lùn</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #21262d;
    --accent: #3fb950;
    --accent2: #58a6ff;
    --accent3: #f78166;
    --accent4: #d2a8ff;
    --text: #e6edf3;
    --muted: #8b949e;
    --pending: #d29922;
    --transit: #58a6ff;
    --delivered: #3fb950;
    --cancelled: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; min-height: 100vh; }

  /* ── Header ── */
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .logo { display: flex; align-items: center; gap: 10px; }
  .logo-icon { font-size: 22px; }
  .logo h1 { font-size: 16px; font-weight: 600; color: var(--accent); }
  .logo span { font-size: 11px; color: var(--muted); margin-left: 8px; }
  .header-meta { font-size: 11px; color: var(--muted); text-align: right; line-height: 1.6; }
  .pulse { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-right: 5px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

  /* ── Layout ── */
  main { padding: 20px 24px; max-width: 1400px; margin: 0 auto; }

  /* ── Section title ── */
  .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 28px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }

  /* ── Stat cards ── */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 18px;
    position: relative;
    overflow: hidden;
  }
  .stat-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--accent-bar, var(--accent));
  }
  .stat-label { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .stat-value { font-size: 24px; font-weight: 700; line-height: 1; }
  .stat-sub { font-size: 11px; color: var(--muted); margin-top: 6px; }

  /* ── Charts grid ── */
  .charts-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
  .charts-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .chart-title { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 12px; }
  .chart-wrap { position: relative; height: 200px; }

  /* ── Tables ── */
  .table-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .table-header { padding: 12px 16px; font-size: 12px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; padding: 8px 12px; text-align: left; background: rgba(255,255,255,.02); }
  td { padding: 9px 12px; font-size: 13px; border-top: 1px solid var(--border); }
  tr:hover td { background: rgba(255,255,255,.03); }

  /* ── Status badges ── */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-PENDING    { background: rgba(210,153,34,.15);  color: var(--pending); }
  .badge-IN_TRANSIT { background: rgba(88,166,255,.15);  color: var(--transit); }
  .badge-DELIVERED  { background: rgba(63,185,80,.15);   color: var(--delivered); }
  .badge-CANCELLED  { background: rgba(248,81,73,.15);   color: var(--cancelled); }
  .badge-UNKNOWN    { background: rgba(139,148,158,.15); color: var(--muted); }

  /* ── Tabs ── */
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 0; }
  .tab { padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; } 
  .tab-content.active { display: block; }

  /* ── Search ── */
  .search-bar { padding: 10px 12px; display: flex; gap: 8px; border-bottom: 1px solid var(--border); }
  .search-bar input {
    flex: 1; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; padding: 6px 10px; font-size: 13px;
    outline: none;
  }
  .search-bar input:focus { border-color: var(--accent2); }
  .search-bar select {
    background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; outline: none;
  }

  /* ── Backup log ── */
  .backup-timeline { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px; }
  .backup-dot {
    padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600;
    background: rgba(63,185,80,.1); color: var(--accent); border: 1px solid rgba(63,185,80,.25);
    cursor: default;
    position: relative;
  }
  .backup-dot:hover .backup-tooltip { display: block; }
  .backup-tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: #2d333b;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 11px;
    white-space: nowrap;
    z-index: 10;
    color: var(--text);
    line-height: 1.6;
  }

  /* ── Bar mini ── */
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .bar-label { width: 120px; font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; background: var(--border); border-radius: 3px; height: 8px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; background: var(--accent); }
  .bar-val { width: 90px; font-size: 11px; color: var(--muted); text-align: right; }

  /* ── Responsive ── */
  @media (max-width: 900px) {
    .charts-grid { grid-template-columns: 1fr; }
    .charts-grid-2 { grid-template-columns: 1fr; }
    main { padding: 12px 14px; }
  }
  @media (max-width: 600px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .stat-value { font-size: 20px; }
    table { font-size: 12px; }
    td, th { padding: 7px 8px; }
  }

  .money { color: var(--accent); font-weight: 600; }
  .dim { color: var(--muted); }
  .text-right { text-align: right; }
</style>
</head>
<body>

<header>
  <div class="logo">
    <span class="logo-icon">🐟</span>
    <div>
      <h1>EcoGo Dashboard</h1>
    </div>
    <span style="font-size:11px;color:var(--muted);margin-left:8px;">Nấm Lùn Shop</span>
  </div>
  <div class="header-meta" id="header-meta"></div>
</header>

<main>
  <!-- KPI Cards -->
  <p class="section-title">Tổng quan</p>
  <div class="stats-grid" id="stats-grid"></div>

  <!-- Charts -->
  <p class="section-title">Doanh thu</p>
  <div class="charts-grid">
    <div class="chart-card">
      <p class="chart-title">Doanh thu 30 ngày gần nhất</p>
      <div class="chart-wrap"><canvas id="chartDaily"></canvas></div>
    </div>
    <div class="chart-card">
      <p class="chart-title">Trạng thái đơn hàng</p>
      <div class="chart-wrap"><canvas id="chartStatus"></canvas></div>
    </div>
  </div>
  <div class="charts-grid-2">
    <div class="chart-card">
      <p class="chart-title">Doanh thu theo tuần (12 tuần)</p>
      <div class="chart-wrap"><canvas id="chartWeekly"></canvas></div>
    </div>
    <div class="chart-card">
      <p class="chart-title">Phương thức thanh toán</p>
      <div class="chart-wrap"><canvas id="chartPayment"></canvas></div>
    </div>
  </div>

  <!-- Products & Customers -->
  <p class="section-title">Phân tích</p>
  <div class="charts-grid">
    <div class="table-card">
      <div class="table-header">🏆 Sản phẩm bán chạy</div>
      <div id="products-bars" style="padding:12px 16px;"></div>
    </div>
    <div class="table-card">
      <div class="table-header">👤 Top khách hàng</div>
      <div id="customers-bars" style="padding:12px 16px;"></div>
    </div>
  </div>

  <!-- Lô hàng -->
  <p class="section-title">Lô hàng gần đây</p>
  <div class="table-card" style="overflow-x:auto;">
    <table>
      <thead><tr>
        <th>Tên lô</th>
        <th class="text-right">Số đơn</th>
        <th class="text-right">Doanh thu</th>
      </tr></thead>
      <tbody id="batches-tbody"></tbody>
    </table>
  </div>

  <!-- Orders table -->
  <p class="section-title">Đơn hàng gần nhất</p>
  <div class="table-card">
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Tìm tên khách, địa chỉ, mã đơn...">
      <select id="status-filter">
        <option value="">Tất cả trạng thái</option>
        <option value="PENDING">Chờ xử lý</option>
        <option value="IN_TRANSIT">Đang giao</option>
        <option value="DELIVERED">Đã giao</option>
        <option value="CANCELLED">Đã huỷ</option>
      </select>
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr>
          <th>Mã đơn</th>
          <th>Khách hàng</th>
          <th>Địa chỉ</th>
          <th>Lô</th>
          <th class="text-right">Số tiền</th>
          <th>Trạng thái</th>
          <th>Thanh toán</th>
          <th>Ngày tạo</th>
        </tr></thead>
        <tbody id="orders-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- Backup log -->
  <p class="section-title">Lịch sử backup</p>
  <div class="table-card">
    <div class="backup-timeline" id="backup-timeline"></div>
  </div>

</main>

<script>
const D = ${D};

// ── Helpers ─────────────────────────────────────────────────
const fmt = n => new Intl.NumberFormat('vi-VN').format(Math.round(n)) + 'đ';
const fmtK = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : Math.round(n).toString();
const fmtDate = ts => {
  if (!ts) return '—';
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  return d.toLocaleDateString('vi-VN', {day:'2-digit',month:'2-digit',year:'2-digit'});
};
const STATUS_VI = {PENDING:'Chờ xử lý',IN_TRANSIT:'Đang giao',DELIVERED:'Đã giao',CANCELLED:'Đã huỷ'};
const PAY_VI = {CASH:'Tiền mặt',TRANSFER:'Chuyển khoản'};

// ── Header meta ─────────────────────────────────────────────
document.getElementById('header-meta').innerHTML =
  '<span class="pulse"></span>Cập nhật: ' +
  new Date(D.meta.generatedAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}) +
  '<br>Từ ' + D.meta.backupCount + ' file backup | Backup mới nhất: ' + D.meta.lastBackup;

// ── Stat cards ──────────────────────────────────────────────
const statDefs = [
  { label:'Tổng đơn hàng', value: D.stats.totalOrders.toLocaleString(), sub:'tất cả trạng thái', color:'#3fb950' },
  { label:'Doanh thu (không huỷ)', value: fmtK(D.stats.totalRevenue), sub:fmt(D.stats.totalRevenue), color:'#3fb950' },
  { label:'Đã giao – doanh thu', value: fmtK(D.stats.deliveredRevenue), sub:D.stats.delivered + ' đơn', color:'#3fb950' },
  { label:'Chờ xử lý', value: D.stats.pending, sub:'đơn PENDING', color:'#d29922' },
  { label:'Đang giao', value: D.stats.inTransit, sub:'đơn IN_TRANSIT', color:'#58a6ff' },
  { label:'Đã huỷ', value: D.stats.cancelled, sub:'đơn CANCELLED', color:'#f85149' },
];
document.getElementById('stats-grid').innerHTML = statDefs.map(s => \`
  <div class="stat-card" style="--accent-bar:\${s.color}">
    <p class="stat-label">\${s.label}</p>
    <p class="stat-value" style="color:\${s.color}">\${s.value}</p>
    <p class="stat-sub">\${s.sub}</p>
  </div>
\`).join('');

// ── Chart defaults ──────────────────────────────────────────
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#21262d';
const COLORS = ['#3fb950','#58a6ff','#d29922','#f78166','#d2a8ff','#79c0ff','#ffa657'];

// ── Daily revenue chart ─────────────────────────────────────
new Chart(document.getElementById('chartDaily'), {
  type: 'bar',
  data: {
    labels: D.charts.daily.labels,
    datasets: [{
      label: 'Doanh thu',
      data: D.charts.daily.data,
      backgroundColor: 'rgba(63,185,80,.35)',
      borderColor: '#3fb950',
      borderWidth: 1,
      borderRadius: 3,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmt(ctx.raw) } } },
    scales: {
      x: { ticks: { font:{size:10}, maxRotation:45 } },
      y: { ticks: { callback: v => fmtK(v) } }
    }
  }
});

// ── Status donut ────────────────────────────────────────────
new Chart(document.getElementById('chartStatus'), {
  type: 'doughnut',
  data: {
    labels: D.charts.status.labels,
    datasets: [{ data: D.charts.status.data, backgroundColor: ['#d29922','#58a6ff','#3fb950','#f85149'], borderWidth: 0 }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position:'right', labels:{ font:{size:11}, boxWidth:12 } } }
  }
});

// ── Weekly chart ────────────────────────────────────────────
new Chart(document.getElementById('chartWeekly'), {
  type: 'line',
  data: {
    labels: D.charts.weekly.labels,
    datasets: [{
      label: 'Doanh thu tuần',
      data: D.charts.weekly.data,
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88,166,255,.1)',
      tension: .3, fill: true, pointRadius: 3, pointBackgroundColor: '#58a6ff'
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx=>fmt(ctx.raw) } } },
    scales: { y:{ ticks:{ callback: v=>fmtK(v) } } }
  }
});

// ── Payment pie ─────────────────────────────────────────────
new Chart(document.getElementById('chartPayment'), {
  type: 'pie',
  data: {
    labels: D.charts.payment.labels.map(l => PAY_VI[l]||l),
    datasets: [{ data: D.charts.payment.data, backgroundColor: COLORS, borderWidth: 0 }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend:{ position:'right', labels:{ font:{size:11}, boxWidth:12 } } }
  }
});

// ── Product bars ─────────────────────────────────────────────
const maxProd = D.topProducts[0]?.revenue || 1;
document.getElementById('products-bars').innerHTML = D.topProducts.map(p => \`
  <div class="bar-row">
    <span class="bar-label" title="\${p.name}">\${p.name}</span>
    <div class="bar-track"><div class="bar-fill" style="width:\${(p.revenue/maxProd*100).toFixed(1)}%"></div></div>
    <span class="bar-val">\${fmtK(p.revenue)}</span>
  </div>
\`).join('');

// ── Customer bars ─────────────────────────────────────────────
const maxCust = D.topCustomers[0]?.revenue || 1;
document.getElementById('customers-bars').innerHTML = D.topCustomers.map(c => \`
  <div class="bar-row">
    <span class="bar-label" title="\${c.name}">\${c.name}</span>
    <div class="bar-track"><div class="bar-fill" style="width:\${(c.revenue/maxCust*100).toFixed(1)}%;background:#58a6ff"></div></div>
    <span class="bar-val">\${c.count} đơn</span>
  </div>
\`).join('');

// ── Batches table ─────────────────────────────────────────────
document.getElementById('batches-tbody').innerHTML = D.topBatches.map(b => \`
  <tr>
    <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${b.name}">\${b.name}</td>
    <td class="text-right dim">\${b.count}</td>
    <td class="text-right money">\${fmtK(b.revenue)}</td>
  </tr>
\`).join('');

// ── Orders table ─────────────────────────────────────────────
let filteredOrders = [...D.recentOrders];
function renderOrders() {
  const q = document.getElementById('search-input').value.toLowerCase();
  const st = document.getElementById('status-filter').value;
  const rows = filteredOrders.filter(o => {
    const matchQ = !q || [o.id, o.customerName, o.address, o.batchId].some(v => (v||'').toLowerCase().includes(q));
    const matchS = !st || o.status === st;
    return matchQ && matchS;
  });
  document.getElementById('orders-tbody').innerHTML = rows.map(o => \`
    <tr>
      <td><code style="font-size:11px;color:var(--accent2)">\${o.id||'—'}</code></td>
      <td>\${o.customerName}</td>
      <td class="dim" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${o.address}</td>
      <td class="dim" style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${o.batchId}">\${o.batchId}</td>
      <td class="text-right money">\${fmt(o.totalPrice)}</td>
      <td><span class="badge badge-\${o.status}">\${STATUS_VI[o.status]||o.status}</span></td>
      <td class="dim">\${PAY_VI[o.paymentMethod]||o.paymentMethod}</td>
      <td class="dim">\${fmtDate(o.createdAt)}</td>
    </tr>
  \`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">Không tìm thấy đơn hàng</td></tr>';
}
document.getElementById('search-input').addEventListener('input', renderOrders);
document.getElementById('status-filter').addEventListener('change', renderOrders);
renderOrders();

// ── Backup timeline ───────────────────────────────────────────
document.getElementById('backup-timeline').innerHTML = D.snapshotLog.map(s => \`
  <div class="backup-dot">\${s.date}
    <div class="backup-tooltip">
      📅 \${s.date}<br>
      📋 \${s.auditCount.toLocaleString()} audit logs<br>
      🔄 \${s.processedOrders} đơn cập nhật<br>
      📦 Tổng lũy kế: \${s.totalKnownOrders} đơn
    </div>
  </div>
\`).join('');
<\/script>
</body>
</html>`;
}
