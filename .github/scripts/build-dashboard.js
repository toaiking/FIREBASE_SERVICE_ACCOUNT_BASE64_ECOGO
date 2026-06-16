"use strict";
/**
 * build-dashboard.js (Nâng cấp)
 * Đọc tối đa 6 file backup gần nhất trong /backups/
 * Reconstruct trạng thái, xây dựng lịch sử đơn hàng và phát hiện bất thường.
 */

const fs = require("fs");
const path = require("path");

const BACKUP_DIR = "./backups";
const DIST_DIR = "./dist";

if (!fs.existsSync(BACKUP_DIR)) {
  console.error("❌ Không tìm thấy thư mục backups/");
  process.exit(1);
}

// 1. Lấy tối đa 6 file backup gần nhất (sắp xếp từ cũ đến mới)
let backupFiles = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => f.match(/^backup-\d{4}-\d{2}-\d{2}\.json$/))
  .sort();

if (backupFiles.length === 0) {
  console.error("❌ Không tìm thấy file backup nào.");
  process.exit(1);
}

if (backupFiles.length > 6) {
  backupFiles = backupFiles.slice(-6); // Chỉ lấy 6 file gần nhất
}

console.log(`📦 Đang xử lý ${backupFiles.length} file backup gần nhất: ${backupFiles.join(", ")}`);

let ordersMap = {};
let anomalies = [];
let timelineDates = [];

// 2. Duyệt qua từng file backup để dựng lịch sử biến động
backupFiles.forEach((file) => {
  const dateStr = file.replace("backup-", "").replace(".json", "");
  timelineDates.push(dateStr);

  const filePath = path.join(BACKUP_DIR, file);
  const rawData = fs.readFileSync(filePath, "utf8");
  let data;
  try {
    data = JSON.parse(rawData);
  } catch (e) {
    console.error(`💥 Lỗi parse file ${file}, bỏ qua.`);
    return;
  }

  // Thu thập tất cả đơn hàng có trong file này (từ mảng orders hoặc từ audit_logs tùy cấu trúc file của anh)
  // Giả định cấu trúc chuẩn hóa chứa mảng orders trực tiếp hoặc gián tiếp:
  const currentOrders = data.orders || []; 
  
  // Nếu file của anh lưu dạng audit_logs trước, ta có thể kết hợp reconstruct:
  if (data.audit_logs && currentOrders.length === 0) {
    // Logic reconstruct từ audit_logs nếu mảng orders trống
    data.audit_logs.forEach(log => {
      if (log.entityType === "ORDER" && log.newData) {
        currentOrders.push(log.newData);
      }
    });
  }

  currentOrders.forEach((order) => {
    if (!order.id) return;

    const snapshot = {
      date: dateStr,
      status: order.status,
      totalPrice: order.totalPrice || 0,
      updatedAt: order.updatedAt
    };

    if (!ordersMap[order.id]) {
      // Khởi tạo đơn hàng mới xuất hiện
      ordersMap[order.id] = {
        ...order,
        history: [snapshot]
      };
    } else {
      // Đã tồn tại -> Kiểm tra bất thường trước khi cập nhật dữ liệu mới nhất
      const lastSnapshot = ordersMap[order.id].history[ordersMap[order.id].history.length - 1];
      
      // KIỂM TRA BẤT THƯỜNG (ANOMALIES)
      // 1. Giảm tiền bất thường
      if (order.totalPrice < lastSnapshot.totalPrice) {
        anomalies.push({
          orderId: order.id,
          customerName: order.customerName,
          type: "PRICE_DROP",
          desc: `Đơn hàng bị giảm tổng tiền từ ${lastSnapshot.totalPrice.toLocaleString()}đ xuống ${order.totalPrice.toLocaleString()}đ vào ngày ${dateStr}.`
        });
      }
      // 2. Đi lùi trạng thái (Ví dụ từ DONE quay về PENDING)
      if (lastSnapshot.status === "DONE" && order.status === "PENDING") {
        anomalies.push({
          orderId: order.id,
          customerName: order.customerName,
          type: "STATUS_REVERSED",
          desc: `Trạng thái bị chuyển ngược từ DONE về PENDING vào ngày ${dateStr}.`
        });
      }

      // Cập nhật thông tin mới nhất và đẩy vào lịch sử
      ordersMap[order.id] = {
        ...ordersMap[order.id],
        ...order, // Giữ các thông tin mới nhất (tên, địa chỉ, status...)
      };
      ordersMap[order.id].history.push(snapshot);
    }
  });
});

const finalOrders = Object.values(ordersMap);

// 3. TÍNH TOÁN BÁO CÁO TỔNG HỢP (STATS)
const stats = {
  totalRevenue: 0,
  totalOrders: finalOrders.length,
  statusCounts: {},
  topProducts: {}
};

finalOrders.forEach(o => {
  if (o.status !== "CANCELLED") {
    stats.totalRevenue += (o.totalPrice || 0);
  }
  stats.statusCounts[o.status] = (stats.statusCounts[o.status] || 0) + 1;

  // Thống kê sản phẩm
  if (o.items && Array.isArray(o.items)) {
    o.items.forEach(item => {
      stats.topProducts[item.name] = (stats.topProducts[item.name] || 0) + (item.quantity || 1);
    });
  }
});

// Sắp xếp top sản phẩm bán chạy
const topProductsSorted = Object.entries(stats.topProducts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);

// 4. ĐÓNG GÓI DỮ LIỆU VÀO INDEX.HTML
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

const templatePath = "./index.html";
if (!fs.existsSync(templatePath)) {
  console.error("❌ Không tìm thấy file template index.html");
  process.exit(1);
}

let html = fs.readFileSync(templatePath, "utf8");

// Nhúng cục dữ liệu inline vào biến toàn cục của Frontend
const injectedData = {
  orders: finalOrders,
  anomalies: anomalies,
  stats: {
    totalRevenue: stats.totalRevenue,
    totalOrders: stats.totalOrders,
    statusCounts: stats.statusCounts,
    topProducts: topProductsSorted,
    timelineDates: timelineDates
  }
};

html = html.replace(
  "/*INJECT_DATA_HERE*/",
  `window.D = ${JSON.stringify(injectedData, null, 2)};`
);

fs.writeFileSync(path.join(DIST_DIR, "index.html"), html);
console.log("✨ Đã dựng thành công Dashboard tĩnh tại dist/index.html!");
