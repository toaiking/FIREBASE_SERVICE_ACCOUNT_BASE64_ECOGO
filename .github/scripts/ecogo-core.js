"use strict";
/**
 * ecogo-core.js
 * Single Source of Truth cho toàn bộ scripts backup / dashboard / daily report.
 * Đồng bộ 100% logic với App chính (d:\namlunshop):
 *  - services/paymentStateMachine.ts (normalizePaymentMethod, derivePaymentStatusFromLegacy, getOrderPaidAmount)
 *  - components/RevenueReport.tsx & DashboardHome.tsx (Booked vs Collected vs Receivable, Cost & Gross Profit)
 *  - services/storageService.ts (normalizePhone)
 *  - Múi giờ chuẩn Asia/Ho_Chi_Minh (GMT+7) — KHÔNG dùng toISOString() cho ngày/tuần/tháng nghiệp vụ.
 */

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

const PAYMENT_STATUS_VALUES = new Set([
  "UNPAID",
  "PENDING_TRANSFER",
  "PARTIALLY_PAID",
  "VERIFIED_MANUAL",
  "VERIFIED_BANK_AUTO",
  "VOIDED",
]);

function tsToMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === "number") {
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    return ts > 1e12 ? ts : ts * 1000;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof ts === "object") {
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    if (ts.__fsType === "Timestamp" && ts.iso) {
      const parsed = Date.parse(ts.iso);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof ts._seconds === "number") return ts._seconds * 1000;
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
  }
  return 0;
}

/**
 * Chuyển timestamp UTC ms sang Date đã dịch +7 giờ để đọc getUTCFullYear/Month/Date/Day chính xác theo GMT+7
 */
function toVNShiftedDate(ts) {
  const ms = tsToMs(ts);
  if (!ms) return null;
  return new Date(ms + VN_OFFSET_MS);
}

function toVNDateKey(ts) {
  const d = toVNShiftedDate(ts);
  if (!d) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toVNMonthKey(ts) {
  const d = toVNShiftedDate(ts);
  if (!d) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toVNWeekKey(ts) {
  const d = toVNShiftedDate(ts);
  if (!d) return "";
  const dow = d.getUTCDay(); // 0=CN..6=T7
  const diffToMon = (dow + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon));
  const y = mon.getUTCFullYear();
  const m = String(mon.getUTCMonth() + 1).padStart(2, "0");
  const day = String(mon.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getVNDayOfWeek(ts) {
  const d = toVNShiftedDate(ts);
  return d ? d.getUTCDay() : 0;
}

function getVNHour(ts) {
  const d = toVNShiftedDate(ts);
  return d ? d.getUTCHours() : 0;
}

function getVNDayBounds(dateKey) {
  // dateKey: "YYYY-MM-DD" theo giờ Việt Nam
  const [y, m, d] = dateKey.split("-").map(Number);
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - VN_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000 - 1;
  return { startMs, endMs };
}

function getTodayVNDateKey(nowMs = Date.now()) {
  return toVNDateKey(nowMs);
}

function normalizePhone(phone) {
  if (!phone) return "";
  let p = String(phone).replace(/[^0-9]/g, "");
  if (p.startsWith("84") && p.length >= 10) p = "0" + p.slice(2);
  if (p.length === 9 && !p.startsWith("0")) p = "0" + p;
  return p;
}

function normalizePaymentMethod(method) {
  if (method === "TRANSFER" || method === "PAID") return "TRANSFER";
  return "CASH";
}

function derivePaymentStatusFromLegacy(order) {
  if (!order) return "UNPAID";
  if (order.paymentStatus && PAYMENT_STATUS_VALUES.has(order.paymentStatus)) {
    return order.paymentStatus;
  }
  if (order.payOk === true) return "VERIFIED_BANK_AUTO";
  if (order.paymentVerified === true) return "VERIFIED_MANUAL";
  if (order.status === "CANCELLED") return "VOIDED";
  if (order.paymentMethod === "TRANSFER" || order.paymentMethod === "PAID") {
    return "PENDING_TRANSFER";
  }
  return "UNPAID";
}

function getOrderPaidAmount(order) {
  if (!order) return 0;
  if (typeof order.paidAmount === "number" && Number.isFinite(order.paidAmount) && order.paidAmount >= 0) {
    return Math.round(order.paidAmount);
  }
  const status = derivePaymentStatusFromLegacy(order);
  if (status === "VERIFIED_MANUAL" || status === "VERIFIED_BANK_AUTO") {
    return Math.max(0, Math.round(Number(order.totalPrice || 0)));
  }
  return 0;
}

function isOrderDeleted(o) {
  return Boolean(o && (o.deleteFlag === true || o.deleteFlag === 1));
}

function computeOrderFinancials(order) {
  const orderTotal = Math.max(0, Math.round(Number(order.totalPrice || 0)));
  const paymentMethod = normalizePaymentMethod(order.paymentMethod);
  const paymentStatus = derivePaymentStatusFromLegacy(order);
  const orderPaid = Math.min(orderTotal, getOrderPaidAmount(order));
  const orderReceivable = Math.max(0, orderTotal - orderPaid);

  let orderCost = 0;
  let hasCostData = false;
  for (const it of order.items || []) {
    const qty = Number(it.quantity ?? it.qty ?? 0);
    const cost = Number(it.importPrice || 0);
    if (cost > 0) hasCostData = true;
    if (Number.isFinite(cost) && Number.isFinite(qty)) {
      orderCost += cost * qty;
    }
  }
  orderCost = Math.round(orderCost);
  const orderProfit = Math.round(orderTotal - orderCost);

  return {
    orderTotal,
    orderPaid,
    orderReceivable,
    orderCost,
    orderProfit,
    hasCostData,
    paymentStatus,
    paymentMethod,
  };
}

function buildCustomerLookup(customersList) {
  const byId = new Map();
  const byPhone = new Map();
  for (const c of customersList || []) {
    if (!c) continue;
    const id = c.id || c._id;
    if (id) byId.set(id, c);
    const np = normalizePhone(c.phone);
    if (np.length >= 9) {
      const prev = byPhone.get(np);
      if (!prev || tsToMs(c.updatedAt) >= tsToMs(prev.updatedAt)) {
        byPhone.set(np, c);
      }
    }
  }
  return { byId, byPhone };
}

function resolveCanonicalCustomer(order, lookup) {
  const { byId, byPhone } = lookup || { byId: new Map(), byPhone: new Map() };
  const masterById = order.customerId ? byId.get(order.customerId) : null;
  const normPhone = normalizePhone(order.customerPhone);
  const masterByPhone = !masterById && normPhone.length >= 9 ? byPhone.get(normPhone) : null;
  const master = masterById || masterByPhone;

  if (master) {
    const masterId = master.id || master._id;
    const masterPhone = normalizePhone(master.phone) || normPhone || "";
    return {
      key: `id:${masterId}`,
      customerId: masterId,
      name: (master.name || order.customerName || "Không rõ").trim(),
      phone: masterPhone,
      address: (master.address || order.address || "").trim(),
      zaloLink: master.zaloLink || order.zaloLink || "",
      messengerLink: master.messengerLink || order.messengerLink || "",
      fromMaster: true,
    };
  }

  const rawName = (order.customerName || "Không rõ").trim();
  const key = normPhone.length >= 9
    ? `p:${normPhone}`
    : `n:${rawName.toLowerCase()}`;
  return {
    key,
    customerId: order.customerId || "",
    name: rawName || (normPhone ? `Khách ${normPhone}` : "Không rõ"),
    phone: normPhone || (order.customerPhone || "").trim(),
    address: (order.address || "").trim(),
    zaloLink: order.zaloLink || "",
    messengerLink: order.messengerLink || "",
    fromMaster: false,
  };
}

function formatVND(n) {
  return new Intl.NumberFormat("vi-VN").format(Math.round(Number(n || 0))) + "đ";
}

module.exports = {
  VN_OFFSET_MS,
  tsToMs,
  toVNDateKey,
  toVNMonthKey,
  toVNWeekKey,
  getVNDayOfWeek,
  getVNHour,
  getVNDayBounds,
  getTodayVNDateKey,
  normalizePhone,
  normalizePaymentMethod,
  derivePaymentStatusFromLegacy,
  getOrderPaidAmount,
  isOrderDeleted,
  computeOrderFinancials,
  buildCustomerLookup,
  resolveCanonicalCustomer,
  formatVND,
};
