"use strict";
/**
 * backup-firestore.js
 * ───────────────────────────────────────────────────────────────────────────
 * Script backup toàn bộ Firestore an toàn, có phân trang, hỗ trợ subcollections,
 * bảo toàn nguyên kiểu dữ liệu Firestore (Timestamp / GeoPoint / DocumentReference)
 * để khôi phục 100% nguyên bản, kèm SHA-256 checksum và Sanity Check.
 */

const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { getTodayVNDateKey } = require("./ecogo-core");

const PAGE_SIZE = 1000;
const SUBCOLLECTION_CONCURRENCY = 20;

/**
 * Serialize đệ quy mọi giá trị Firestore (giữ nguyên số/chuỗi thường, gắn tag kiểu
 * cho Timestamp / GeoPoint / DocumentReference / Bytes để restore chuẩn 100%).
 */
function serializeFirestoreValue(val) {
  if (val === null || val === undefined) return val;

  // Firestore Timestamp
  if (typeof val === "object" && typeof val.toDate === "function" && typeof val.seconds === "number") {
    return {
      __fsType: "Timestamp",
      seconds: val.seconds,
      nanoseconds: val.nanoseconds || 0,
      iso: val.toDate().toISOString(),
    };
  }

  // Firestore GeoPoint
  if (
    typeof val === "object" &&
    typeof val.latitude === "number" &&
    typeof val.longitude === "number" &&
    val.constructor &&
    val.constructor.name === "GeoPoint"
  ) {
    return {
      __fsType: "GeoPoint",
      latitude: val.latitude,
      longitude: val.longitude,
    };
  }

  // Firestore DocumentReference
  if (typeof val === "object" && typeof val.path === "string" && typeof val.listCollections === "function") {
    return {
      __fsType: "DocumentReference",
      path: val.path,
    };
  }

  // Buffer / Uint8Array
  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    return {
      __fsType: "Bytes",
      base64: Buffer.from(val).toString("base64"),
    };
  }

  if (Array.isArray(val)) {
    return val.map(serializeFirestoreValue);
  }

  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = serializeFirestoreValue(v);
    }
    return out;
  }

  return val;
}

/**
 * Xuất toàn bộ collection bằng phân trang (orderBy(__name__) + startAfter)
 * Tránh vượt gRPC timeout (60s) và tránh OOM khi collection lớn.
 */
async function exportCollectionPaginated(admin, colRef, depth = 0) {
  const docs = [];
  let lastDoc = null;

  while (true) {
    let q = colRef.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const docSnap of snap.docs) {
      const normalized = serializeFirestoreValue(docSnap.data());
      normalized._id = docSnap.id;
      docs.push({ snap: docSnap, data: normalized });
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE_SIZE) break;
  }

  // Kiểm tra subcollections theo batch nhỏ (chỉ khi depth < 3 và <= 2000 docs)
  if (depth < 3 && docs.length > 0 && docs.length <= 2000) {
    for (let i = 0; i < docs.length; i += SUBCOLLECTION_CONCURRENCY) {
      const slice = docs.slice(i, i + SUBCOLLECTION_CONCURRENCY);
      await Promise.all(
        slice.map(async (entry) => {
          const subCols = await entry.snap.ref.listCollections();
          if (subCols.length > 0) {
            entry.data._subcollections = {};
            for (const subCol of subCols) {
              entry.data._subcollections[subCol.id] = await exportCollectionPaginated(admin, subCol, depth + 1);
            }
          }
        })
      );
    }
  }

  return docs.map((d) => d.data);
}

function initFirebase() {
  const admin = require("firebase-admin");
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64 || !b64.trim()) {
    throw new Error("Thiếu biến môi trường FIREBASE_SERVICE_ACCOUNT_BASE64");
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (err) {
    throw new Error("Không thể parse FIREBASE_SERVICE_ACCOUNT_BASE64: " + err.message);
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return { admin, db: admin.firestore(), projectId: serviceAccount.project_id };
}

async function main() {
  const startTime = Date.now();
  const vnDate = getTodayVNDateKey(startTime);
  const vnTimeStr = new Date(startTime).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

  console.log("=".repeat(60));
  console.log("🚀 Bắt đầu backup Firestore (Phân trang + Bảo toàn kiểu dữ liệu)");
  console.log(`🕒 Thời gian (GMT+7): ${vnTimeStr} (${vnDate})`);
  console.log("=".repeat(60));

  const { admin, db, projectId } = initFirebase();

  const collections = await db.listCollections();
  if (collections.length === 0) {
    throw new Error("SANITY CHECK FAILED: Không tìm thấy bất kỳ collection nào trong Firestore!");
  }

  console.log(`📚 Tìm thấy ${collections.length} collections: ${collections.map((c) => c.id).join(", ")}`);

  const backup = {
    _meta: {
      schemaVersion: 2,
      exportedAt: new Date(startTime).toISOString(),
      exportedDateVN: vnDate,
      timezone: "Asia/Ho_Chi_Minh",
      projectId,
      collectionsCount: collections.length,
      counts: {},
    },
  };

  // Chạy song song theo nhóm tối đa 4 collection để vừa nhanh vừa không chạm rate limit / OOM
  const colList = [...collections];
  let totalDocs = 0;

  for (let i = 0; i < colList.length; i += 4) {
    const batchCols = colList.slice(i, i + 4);
    const results = await Promise.all(
      batchCols.map(async (col) => {
        const t0 = Date.now();
        const docs = await exportCollectionPaginated(admin, col, 0);
        const sec = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`  ✓ ${col.id}: ${docs.length} documents (${sec}s)`);
        return { id: col.id, docs };
      })
    );

    for (const res of results) {
      backup[res.id] = res.docs;
      backup._meta.counts[res.id] = res.docs.length;
      totalDocs += res.docs.length;
    }
  }

  // SANITY CHECK: Bắt buộc collection orders phải tồn tại và có dữ liệu (chống ghi đè backup rỗng)
  const ordersCount = backup._meta.counts.orders || 0;
  if (ordersCount === 0 && process.env.ALLOW_EMPTY_ORDERS !== "true") {
    throw new Error("SANITY CHECK FAILED: Collection 'orders' có 0 documents — dừng backup để bảo vệ dữ liệu!");
  }

  backup._meta.totalDocuments = totalDocs;

  const jsonStr = JSON.stringify(backup);
  const rawBuf = Buffer.from(jsonStr, "utf8");
  const rawSizeKB = (rawBuf.length / 1024).toFixed(1);
  const sha256 = crypto.createHash("sha256").update(rawBuf).digest("hex");

  const compressed = zlib.gzipSync(rawBuf, { level: 9 });
  const filename = `backup-${vnDate}.json.gz`;
  fs.writeFileSync(filename, compressed);

  const gzBytes = fs.statSync(filename).size;
  const gzSizeKB = (gzBytes / 1024).toFixed(1);
  const gzSizeMB = (gzBytes / (1024 * 1024)).toFixed(2);
  const ratio = ((1 - gzBytes / rawBuf.length) * 100).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const summary = {
    filename,
    dateVN: vnDate,
    exportedAtVN: vnTimeStr,
    projectId,
    collectionsCount: collections.length,
    totalDocuments: totalDocs,
    counts: backup._meta.counts,
    rawSizeKB: Number(rawSizeKB),
    gzSizeKB: Number(gzSizeKB),
    gzSizeMB: Number(gzSizeMB),
    canAttachEmail: gzBytes < 20 * 1024 * 1024, // < 20MB an toàn cho Gmail SMTP (giới hạn 25MB)
    sha256,
    elapsedSeconds: Number(elapsed),
  };
  fs.writeFileSync("backup-summary.json", JSON.stringify(summary, null, 2), "utf8");

  if (process.env.GITHUB_OUTPUT) {
    const out = [
      `filename=${filename}`,
      `date_vn=${vnDate}`,
      `total_docs=${totalDocs}`,
      `gz_size_kb=${gzSizeKB}`,
      `gz_size_mb=${gzSizeMB}`,
      `can_attach_email=${summary.canAttachEmail}`,
      `sha256=${sha256.slice(0, 16)}`,
    ].join("\n") + "\n";
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
  }

  console.log("=".repeat(60));
  console.log(`✅ Backup hoàn tất   : ${filename}`);
  console.log(`📊 Tổng collections  : ${collections.length} | Tổng docs: ${totalDocs}`);
  console.log(`💾 JSON: ${rawSizeKB} KB → GZ: ${gzSizeKB} KB (${gzSizeMB} MB, giảm ${ratio}%)`);
  console.log(`🔐 SHA-256           : ${sha256.slice(0, 16)}...`);
  console.log(`⏱️  Thời gian chạy    : ${elapsed}s`);
  console.log("=".repeat(60));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ LỖI BACKUP:", err.message || err);
      process.exit(1);
    });
}

module.exports = { serializeFirestoreValue };
