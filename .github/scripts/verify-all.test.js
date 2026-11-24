"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const {
  toVNDateKey,
  toVNMonthKey,
  toVNWeekKey,
  getVNDayOfWeek,
  getVNHour,
  normalizePhone,
  normalizePaymentMethod,
  derivePaymentStatusFromLegacy,
  getOrderPaidAmount,
  isOrderDeleted,
  computeOrderFinancials,
  buildCustomerLookup,
  resolveCanonicalCustomer,
} = require("./ecogo-core");

const { serializeFirestoreValue } = require("./backup-firestore");
const { buildDashboard } = require("./build-dashboard");
const { buildDailyReportHtml, resolveTelegramCredentials } = require("./send-daily-report");

test("1. Vietnam Timezone (GMT+7): midnight-to-6:59am VN stays on VN calendar day & month", () => {
  // 2026-11-24 00:30:00 GMT+7 == 2026-11-23 17:30:00 UTC
  const earlyMorningVN = Date.parse("2026-11-23T17:30:00.000Z");
  assert.equal(toVNDateKey(earlyMorningVN), "2026-11-24");
  assert.equal(getVNHour(earlyMorningVN), 0);
  assert.equal(getVNDayOfWeek(earlyMorningVN), 2); // Tuesday

  // 2026-11-01 01:00:00 GMT+7 == 2026-10-31 18:00:00 UTC
  const firstOfMonthVN = Date.parse("2026-10-31T18:00:00.000Z");
  assert.equal(toVNDateKey(firstOfMonthVN), "2026-11-01");
  assert.equal(toVNMonthKey(firstOfMonthVN), "2026-11");
  // Nov 1, 2026 is Sunday -> week starts Monday 2026-10-26
  assert.equal(toVNWeekKey(firstOfMonthVN), "2026-10-26");
});

test("2. PaymentStateMachine & Profit accuracy (Booked vs Collected vs Receivable & Cost)", () => {
  // DELIVERED but PENDING_TRANSFER must NOT count as collected!
  const deliveredDebt = {
    id: "DH_DEBT",
    status: "DELIVERED",
    paymentMethod: "TRANSFER",
    paymentStatus: "PENDING_TRANSFER",
    totalPrice: 500000,
    items: [{ name: "Cha ca", quantity: 2, price: 250000, importPrice: 150000 }],
  };
  const finDebt = computeOrderFinancials(deliveredDebt);
  assert.equal(finDebt.orderTotal, 500000);
  assert.equal(finDebt.orderPaid, 0);
  assert.equal(finDebt.orderReceivable, 500000);
  assert.equal(finDebt.orderCost, 300000);
  assert.equal(finDebt.orderProfit, 200000);

  // PARTIALLY_PAID: 500k order with 200k paid
  const partial = {
    id: "DH_PARTIAL",
    status: "DELIVERED",
    paymentMethod: "TRANSFER",
    paymentStatus: "PARTIALLY_PAID",
    paidAmount: 200000,
    totalPrice: 500000,
    items: [],
  };
  const finPartial = computeOrderFinancials(partial);
  assert.equal(finPartial.orderPaid, 200000);
  assert.equal(finPartial.orderReceivable, 300000);

  // Legacy PAID normalized to TRANSFER, VERIFIED_BANK_AUTO via payOk=true
  assert.equal(normalizePaymentMethod("PAID"), "TRANSFER");
  const legacyPayOk = { status: "DELIVERED", paymentMethod: "PAID", payOk: true, totalPrice: 350000 };
  assert.equal(derivePaymentStatusFromLegacy(legacyPayOk), "VERIFIED_BANK_AUTO");
  assert.equal(getOrderPaidAmount(legacyPayOk), 350000);

  // VOIDED & deleteFlag
  const voided = { status: "DELIVERED", paymentMethod: "TRANSFER", paymentStatus: "VOIDED", paidAmount: 0, totalPrice: 100000 };
  assert.equal(derivePaymentStatusFromLegacy(voided), "VOIDED");
  assert.equal(getOrderPaidAmount(voided), 0);
  assert.equal(isOrderDeleted({ deleteFlag: true }), true);
  assert.equal(isOrderDeleted({ deleteFlag: false }), false);
});

test("3. Firestore Backup Serialization preserves nested Timestamp, GeoPoint, DocumentReference, Bytes", () => {
  class GeoPoint {
    constructor(lat, lng) {
      this.latitude = lat;
      this.longitude = lng;
    }
  }
  const fakeTimestamp = {
    seconds: 1795500000,
    nanoseconds: 500000000,
    toDate: () => new Date(1795500000 * 1000),
  };
  const fakeDocRef = {
    path: "customers/CUST_01",
    listCollections: async () => [],
  };

  const serialized = serializeFirestoreValue({
    createdAt: 1795500000000,
    nested: {
      ts: fakeTimestamp,
      loc: new GeoPoint(10.77, 106.69),
      ref: fakeDocRef,
      raw: Buffer.from("abc"),
    },
    arr: [{ ts: fakeTimestamp }],
  });

  assert.equal(serialized.createdAt, 1795500000000);
  assert.deepEqual(serialized.nested.ts, {
    __fsType: "Timestamp",
    seconds: 1795500000,
    nanoseconds: 500000000,
    iso: new Date(1795500000 * 1000).toISOString(),
  });
  assert.deepEqual(serialized.nested.loc, { __fsType: "GeoPoint", latitude: 10.77, longitude: 106.69 });
  assert.deepEqual(serialized.nested.ref, { __fsType: "DocumentReference", path: "customers/CUST_01" });
  assert.deepEqual(serialized.nested.raw, { __fsType: "Bytes", base64: Buffer.from("abc").toString("base64") });
  assert.equal(serialized.arr[0].ts.__fsType, "Timestamp");
});

test("4. Master Data Customer Lookup unifies +84 / spaces / updated names", () => {
  const lookup = buildCustomerLookup([
    { id: "CUST_A", name: "Chi Lan (Ten Moi)", phone: "0909123456", address: "123 Le Loi", updatedAt: 2000 },
  ]);
  const res1 = resolveCanonicalCustomer(
    { customerId: "CUST_A", customerName: "Lan Cu", customerPhone: "+84 909 123 456" },
    lookup
  );
  const res2 = resolveCanonicalCustomer(
    { customerName: "Chi Lan", customerPhone: "84909123456" },
    lookup
  );
  assert.equal(res1.key, "id:CUST_A");
  assert.equal(res2.key, "id:CUST_A");
  assert.equal(res1.name, "Chi Lan (Ten Moi)");
  assert.equal(normalizePhone("+84 909-123-456"), "0909123456");
});

test("5. End-to-end buildDashboard (unencrypted + AES-256-GCM encrypted), Client JS syntax, and Telegram Daily Report", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecogo-test-"));
  try {
    const backupDir = path.join(tmpDir, "backups");
    const distPlain = path.join(tmpDir, "dist-plain");
    const distEnc = path.join(tmpDir, "dist-enc");
    fs.mkdirSync(backupDir, { recursive: true });

    const day1Ts = Date.parse("2026-11-23T10:00:00.000Z"); // 2026-11-23 17:00 GMT+7
    const day2EarlyTs = Date.parse("2026-11-23T17:30:00.000Z"); // 2026-11-24 00:30 GMT+7!
    const day2NoonTs = Date.parse("2026-11-24T05:00:00.000Z"); // 2026-11-24 12:00 GMT+7

    const snap1 = {
      _meta: { exportedDateVN: "2026-11-23" },
      orders: [
        {
          id: "DH001",
          customerId: "CUST_1",
          customerName: "Nguyen Van A (Cu)",
          customerPhone: "0901112222",
          address: "10 Nguyen Hue",
          batchId: "LO-2026-11-23",
          totalPrice: 400000,
          status: "IN_TRANSIT",
          paymentMethod: "TRANSFER",
          paymentStatus: "PENDING_TRANSFER",
          paidAmount: 0,
          createdAt: day1Ts,
          updatedAt: day1Ts,
          items: [{ id: "i1", productId: "P1", name: "Cha ca thu", quantity: 2, price: 200000, importPrice: 120000 }],
        },
      ],
      customers: [{ id: "CUST_1", name: "Nguyen Van A (Cu)", phone: "0901112222", address: "10 Nguyen Hue", updatedAt: day1Ts }],
      products: [{ id: "P1", name: "Cha ca thu", stockQuantity: 3 }],
      payment_ledger: [],
    };

    const snap2 = {
      _meta: { exportedDateVN: "2026-11-24" },
      orders: [
        {
          ...snap1.orders[0],
          status: "DELIVERED",
          paymentStatus: "VERIFIED_BANK_AUTO",
          payOk: true,
          paymentVerified: true,
          paidAmount: 400000,
          updatedAt: day2NoonTs,
        },
        {
          id: "DH002",
          customerId: "CUST_1",
          customerName: "Nguyen Van A (Moi)",
          customerPhone: "+84 901 112 222",
          address: "99 Tran Hung Dao",
          batchId: "LO-2026-11-24",
          totalPrice: 500000,
          status: "DELIVERED",
          paymentMethod: "TRANSFER",
          paymentStatus: "PARTIALLY_PAID",
          paidAmount: 200000,
          createdAt: day2EarlyTs,
          updatedAt: day2EarlyTs,
          items: [{ id: "i2", productId: "P1", name: "Cha ca thu", quantity: 2.5, price: 200000, importPrice: 120000 }],
        },
        {
          id: "DH003_DEL",
          customerName: "Don Xoa Mem",
          totalPrice: 999000,
          status: "PENDING",
          deleteFlag: true,
          createdAt: day2NoonTs,
          items: [],
        },
      ],
      customers: [{ id: "CUST_1", name: "Nguyen Van A (Moi)", phone: "0901112222", address: "99 Tran Hung Dao", updatedAt: day2NoonTs }],
      products: [
        { id: "P1", name: "Cha ca thu", stockQuantity: 2 },
        { id: "P2", name: "Muc mot nang", stockQuantity: 20 },
      ],
      payment_ledger: [
        {
          id: "LED_1",
          orderIds: ["DH001"],
          source: "PAYOS_WEBHOOK",
          action: "CAPTURE",
          expectedAmount: 400000,
          receivedAmount: 400000,
          deltaAmount: 400000,
          createdAt: day2NoonTs,
        },
        {
          id: "LED_2",
          orderIds: ["DH002"],
          source: "WEB_UI",
          action: "PARTIAL_CAPTURE",
          expectedAmount: 500000,
          receivedAmount: 200000,
          deltaAmount: 200000,
          createdAt: day2NoonTs,
        },
      ],
      settings: [
        { _id: "telegramConfig", botToken: "TEST_TOKEN_FROM_DB", chatId: "999888777" },
      ],
    };

    const gz1Path = path.join(backupDir, "backup-2026-11-23.json.gz");
    const gz2Path = path.join(backupDir, "backup-2026-11-24.json.gz");
    fs.writeFileSync(gz1Path, zlib.gzipSync(Buffer.from(JSON.stringify(snap1), "utf8")));
    fs.writeFileSync(gz2Path, zlib.gzipSync(Buffer.from(JSON.stringify(snap2), "utf8")));

    // 5a. Build unencrypted & assert metrics
    const plainRes = buildDashboard({ backupDir, distDir: distPlain, password: "" });
    assert.equal(plainRes.encrypted, false);
    assert.equal(fs.existsSync(path.join(distPlain, "data.json")), false, "dist/data.json MUST NOT be generated");

    const s = plainRes.dashData.stats;
    assert.equal(s.totalOrders, 2);
    assert.equal(s.deletedCount, 1);
    assert.equal(s.totalRevenue, 900000);
    assert.equal(s.totalCollected, 600000); // 400k + 200k
    assert.equal(s.totalReceivable, 300000); // 500k - 200k
    assert.equal(s.totalCost, 540000); // (2 + 2.5) * 120k = 540k
    assert.equal(s.totalProfit, 360000); // 900k - 540k
    assert.equal(s.partiallyPaidCount, 1);
    assert.equal(s.bankAutoCount, 1);
    assert.deepEqual(plainRes.dashData.charts.daily.labels, ["2026-11-23", "2026-11-24"]);
    assert.equal(plainRes.dashData.topCustomers.length, 1, "Master Data lookup must merge CUST_1 orders");
    assert.equal(plainRes.dashData.topCustomers[0].name, "Nguyen Van A (Moi)");
    assert.equal(plainRes.dashData.ledger.netCollected, 600000);

    // 5b. Validate client <script> syntax in generated dist/index.html
    const plainHtml = fs.readFileSync(plainRes.outHtmlPath, "utf8");
    const scriptMatches = [...plainHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scriptMatches.length >= 1);
    const inlineJs = scriptMatches[scriptMatches.length - 1][1];
    assert.doesNotThrow(() => new Function(inlineJs), "Inline dashboard JS must have zero syntax errors");

    // 5c. Build AES-256-GCM encrypted & verify NO plaintext PII leaks + decryption works
    const secretPass = "NamLunShop@2026!";
    const encRes = buildDashboard({ backupDir, distDir: distEnc, password: secretPass });
    assert.equal(encRes.encrypted, true);
    const encHtml = fs.readFileSync(encRes.outHtmlPath, "utf8");
    assert.equal(encHtml.includes("0901112222"), false, "Plaintext phone must NOT appear in encrypted HTML");
    assert.equal(encHtml.includes("99 Tran Hung Dao"), false, "Plaintext address must NOT appear in encrypted HTML");

    const payloadMatch = encHtml.match(/const __PAYLOAD__ = (\{.*?\});/s);
    assert.ok(payloadMatch, "Encrypted payload object must be embedded");
    const encPayload = JSON.parse(payloadMatch[1]);
    assert.equal(encPayload.encrypted, true);

    const key = crypto.pbkdf2Sync(secretPass, Buffer.from(encPayload.salt, "base64"), encPayload.iterations, 32, "sha256");
    const rawCombined = Buffer.from(encPayload.ciphertext, "base64");
    const tag = rawCombined.subarray(rawCombined.length - 16);
    const ciphertext = rawCombined.subarray(0, rawCombined.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encPayload.iv, "base64"));
    decipher.setAuthTag(tag);
    const decryptedJson = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const decryptedObj = JSON.parse(decryptedJson);
    assert.equal(decryptedObj.stats.totalCollected, 600000);
    assert.equal(decryptedObj.orders.length, 3);

    // 5d. Telegram daily report + credentials fallback
    const creds = resolveTelegramCredentials(snap2);
    assert.equal(creds.token, "TEST_TOKEN_FROM_DB");
    assert.equal(creds.chatId, "999888777");

    const summary = {
      collectionsCount: 4,
      totalDocuments: 7,
      gzSizeKB: 1.5,
      sha256: "abcdef0123456789abcdef",
      dateVN: "2026-11-24",
    };
    const tgHtml = buildDailyReportHtml(snap2, summary, "2026-11-24");
    assert.ok(tgHtml.includes("24/11/2026"));
    assert.ok(tgHtml.includes("500.000đ")); // Today's booked (DH002)
    assert.ok(tgHtml.includes("200.000đ")); // Today's collected (DH002 partial)
    assert.ok(tgHtml.includes("300.000đ")); // Today's receivable
    assert.ok(tgHtml.includes("PayOS Auto"));
    assert.ok(tgHtml.includes("Cha ca thu"));
    assert.ok(tgHtml.includes("còn <b>2</b>")); // Low stock warning < 5
    assert.ok(tgHtml.includes("abcdef0123456789"));

    const summaryPath = path.join(tmpDir, "backup-summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary), "utf8");
    const cliDryRun = execFileSync(
      process.execPath,
      [path.join(__dirname, "send-daily-report.js"), "--mode=daily", `--backup=${gz2Path}`, `--summary=${summaryPath}`, "--dry-run"],
      { encoding: "utf8" }
    );
    assert.ok(cliDryRun.includes("TELEGRAM DRY-RUN PREVIEW"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. Legacy orders with createdAt=0 / missing timestamps NEVER crash client dashboard rendering", () => {
  const vm = require("node:vm");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecogo-zero-ts-"));
  try {
    const backupDir = path.join(tmpDir, "backups");
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(backupDir, { recursive: true });

    const snap = {
      _meta: { exportedDateVN: "2026-11-24" },
      orders: [
        {
          id: "DH_LEGACY_ZERO",
          customerName: "Khach Cu Khong Timestamp",
          customerPhone: "0905556666",
          address: "Dia chi cu",
          batchId: "LO-CU",
          totalPrice: 250000,
          status: "DELIVERED",
          paymentMethod: "CASH",
          createdAt: 0,
          updatedAt: 0,
          items: [{ id: "1", name: "Cha ca", quantity: 1, price: 250000 }],
        },
        {
          id: "DH_VALID",
          customerName: "Khach Cu Khong Timestamp",
          customerPhone: "0905556666",
          address: "Dia chi cu",
          batchId: "LO-MOI",
          totalPrice: 300000,
          status: "DELIVERED",
          paymentMethod: "TRANSFER",
          paymentVerified: true,
          createdAt: Date.parse("2026-11-24T05:00:00.000Z"),
          updatedAt: Date.parse("2026-11-24T05:00:00.000Z"),
          items: [{ id: "2", name: "Cha ca", quantity: 1, price: 300000 }],
        },
      ],
      customers: [],
      products: [],
      payment_ledger: [],
    };

    fs.writeFileSync(
      path.join(backupDir, "backup-2026-11-24.json.gz"),
      zlib.gzipSync(Buffer.from(JSON.stringify(snap), "utf8"))
    );

    const res = buildDashboard({ backupDir, distDir, password: "" });
    assert.equal(res.dashData.orders.length, 2);

    // Execute client dashboard script inside a lightweight mock DOM to confirm zero runtime crashes!
    const html = fs.readFileSync(res.outHtmlPath, "utf8");
    const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const inlineJs = scriptMatches[scriptMatches.length - 1][1];

    const elements = new Map();
    const makeEl = (id) => {
      if (elements.has(id)) return elements.get(id);
      const el = {
        id,
        textContent: "",
        innerHTML: "",
        value: "",
        style: {},
        dataset: {},
        options: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        querySelectorAll() { return []; },
        querySelector() { return null; },
        focus() {},
        select() {},
      };
      elements.set(id, el);
      return el;
    };

    const sandbox = {
      console,
      Math, Date, Number, String, Boolean, Array, Object, Set, Map, JSON, RegExp, Intl, Error, Uint8Array,
      TextEncoder, TextDecoder,
      atob: (s) => Buffer.from(s, "base64").toString("binary"),
      window: {},
      document: {
        getElementById: (id) => makeEl(id),
        querySelectorAll: () => [],
        querySelector: () => makeEl("mock-tab"),
        addEventListener() {},
      },
      Chart: Object.assign(function MockChart() { this.destroy = () => {}; }, { defaults: { font: {} } }),
      XLSX: undefined,
      sessionStorage: { getItem: () => null, setItem() {} },
      crypto: { subtle: {} },
    };
    sandbox.window = sandbox;

    const consoleErrors = [];
    sandbox.console = { ...console, error: (...args) => consoleErrors.push(args.map(String).join(" ")) };

    vm.runInNewContext(inlineJs, sandbox);
    assert.equal(consoleErrors.length, 0, "Expected 0 runtime console errors, got: " + consoleErrors.join("; "));
    assert.ok(makeEl("orders-tbody").innerHTML.includes("DH_LEGACY_ZERO"), "Orders table must populate including DH_LEGACY_ZERO");
    assert.ok(makeEl("customers-bars").innerHTML.includes("Khach Cu Khong Timestamp"), "Top customers must populate");
    assert.ok(makeEl("batches-tbody").innerHTML.includes("LO-CU"), "Batches table must populate");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
