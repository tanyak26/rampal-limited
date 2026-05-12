const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const { spawnSync } = require("child_process");
const { URL } = require("url");
const { Pool } = require("pg");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    return;
  }

  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = process.env.PORT || 3000;
const INDEX_PATH = path.join(ROOT, "index.html");
const ABOUT_PATH = path.join(ROOT, "about.html");
const PRODUCTS_PATH = path.join(ROOT, "products.html");
const OFFERS_PATH = path.join(ROOT, "offers.html");
const FAQ_PATH = path.join(ROOT, "faq.html");
const ADMIN_PATH = path.join(ROOT, "admin.html");
const ROBOTS_PATH = path.join(ROOT, "robots.txt");
const SITEMAP_PATH = path.join(ROOT, "sitemap.xml");
const MIDX_ROOT = path.join(ROOT, "midx-traders");
const MIDX_ASSETS_DIR = path.join(MIDX_ROOT, "assets");
const MIDX_ADMIN_PATH = path.join(ROOT, "midx-admin.html");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "rampal-quote-requests.db");
const LEGACY_JSON_PATH = path.join(DATA_DIR, "rampal-quote-requests.json");
const NOTIFICATION_LOG_PATH = path.join(DATA_DIR, "notifications.log");
const SQLITE_BIN = "sqlite3";
const SENDMAIL_BIN = "/usr/sbin/sendmail";

const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_POSTGRES = Boolean(DATABASE_URL);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-admin-password";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || NOTIFY_EMAIL || "";
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "";
const CLIENT_AUTO_REPLY_ENABLED = String(process.env.CLIENT_AUTO_REPLY_ENABLED || "false").toLowerCase() === "true";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

const postgresSsl =
  String(process.env.PGSSLMODE || "").toLowerCase() === "disable"
    ? false
    : DATABASE_URL.includes(".render.com")
      ? { rejectUnauthorized: false }
      : false;

const pgPool = USE_POSTGRES
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: postgresSsl
    })
  : null;

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(LEGACY_JSON_PATH)) {
    fs.writeFileSync(LEGACY_JSON_PATH, "[]\n", "utf8");
  }
}

function runSql(sql, { json = false } = {}) {
  const args = [DB_PATH];

  if (json) {
    args.unshift("-json");
  }

  args.push(sql);
  const result = spawnSync(SQLITE_BIN, args, { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "sqlite3 command failed").trim());
  }

  return String(result.stdout || "").trim();
}

function runSqlSafe(sql) {
  try {
    runSql(sql);
  } catch (error) {
    const message = String(error.message || "");
    if (!message.includes("duplicate column name")) {
      throw error;
    }
  }
}

async function setupDatabase() {
  ensureStorage();

  if (USE_POSTGRES) {
    await setupPostgresDatabase();
    return;
  }

  runSql(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_date TEXT,
      package_name TEXT,
      guest_count TEXT,
      budget TEXT,
      preferred_contact TEXT,
      notification_status TEXT,
      notification_method TEXT,
      notification_reason TEXT,
      client_reply_status TEXT,
      client_reply_method TEXT,
      client_reply_reason TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      source_site TEXT NOT NULL DEFAULT 'rampal',
      location TEXT,
      message TEXT NOT NULL
    );
  `);

  runSqlSafe("ALTER TABLE enquiries ADD COLUMN package_name TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN guest_count TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN budget TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN preferred_contact TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN notification_status TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN notification_method TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN notification_reason TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN client_reply_status TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN client_reply_method TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN client_reply_reason TEXT;");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN status TEXT NOT NULL DEFAULT 'New';");
  runSqlSafe("ALTER TABLE enquiries ADD COLUMN source_site TEXT NOT NULL DEFAULT 'rampal';");

  const countOutput = runSql("SELECT COUNT(*) AS count FROM enquiries;", { json: true });
  const countRows = countOutput ? JSON.parse(countOutput) : [];
  const count = countRows.length ? Number(countRows[0].count) : 0;

  if (count === 0 && fs.existsSync(LEGACY_JSON_PATH)) {
    const legacyRows = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, "utf8"));
    for (const item of legacyRows) {
      await insertEnquiry(item);
    }
  }
}

async function setupPostgresDatabase() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_date TEXT,
      package_name TEXT,
      guest_count TEXT,
      budget TEXT,
      preferred_contact TEXT,
      notification_status TEXT,
      notification_method TEXT,
      notification_reason TEXT,
      client_reply_status TEXT,
      client_reply_method TEXT,
      client_reply_reason TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      source_site TEXT NOT NULL DEFAULT 'rampal',
      location TEXT,
      message TEXT NOT NULL
    );
  `);

  await pgPool.query("ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS source_site TEXT NOT NULL DEFAULT 'rampal';");

  const { rows } = await pgPool.query("SELECT COUNT(*)::int AS count FROM enquiries;");
  const count = rows.length ? Number(rows[0].count) : 0;

  if (count === 0 && fs.existsSync(LEGACY_JSON_PATH)) {
    const legacyRows = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, "utf8"));
    for (const item of legacyRows) {
      await insertEnquiry(item);
    }
  }
}

async function insertEnquiry(enquiry) {
  if (USE_POSTGRES) {
    await pgPool.query(
      `
        INSERT INTO enquiries (
          id,
          created_at,
          name,
          phone,
          email,
          event_type,
          event_date,
          package_name,
          guest_count,
          budget,
          preferred_contact,
          notification_status,
          notification_method,
          notification_reason,
          client_reply_status,
          client_reply_method,
          client_reply_reason,
          status,
          source_site,
          location,
          message
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21
        );
      `,
      [
        enquiry.id,
        enquiry.createdAt,
        enquiry.name,
        enquiry.phone,
        enquiry.email,
        enquiry.eventType,
        enquiry.eventDate || "",
        enquiry.packageName || "",
        enquiry.guestCount || "",
        enquiry.budget || "",
        enquiry.preferredContact || "",
        enquiry.notificationStatus || "Pending",
        enquiry.notificationMethod || "",
        enquiry.notificationReason || "",
        enquiry.clientReplyStatus || "Pending",
        enquiry.clientReplyMethod || "",
        enquiry.clientReplyReason || "",
        enquiry.status || "New",
        enquiry.sourceSite || "rampal",
        enquiry.location || "",
        enquiry.message
      ]
    );
    return;
  }

  runSql(`
    INSERT INTO enquiries (
      id,
      created_at,
      name,
      phone,
      email,
      event_type,
      event_date,
      package_name,
      guest_count,
      budget,
      preferred_contact,
      notification_status,
      notification_method,
      notification_reason,
      client_reply_status,
      client_reply_method,
      client_reply_reason,
      status,
      source_site,
      location,
      message
    ) VALUES (
      ${sqlValue(enquiry.id)},
      ${sqlValue(enquiry.createdAt)},
      ${sqlValue(enquiry.name)},
      ${sqlValue(enquiry.phone)},
      ${sqlValue(enquiry.email)},
      ${sqlValue(enquiry.eventType)},
      ${sqlValue(enquiry.eventDate || "")},
      ${sqlValue(enquiry.packageName || "")},
      ${sqlValue(enquiry.guestCount || "")},
      ${sqlValue(enquiry.budget || "")},
      ${sqlValue(enquiry.preferredContact || "")},
      ${sqlValue(enquiry.notificationStatus || "Pending")},
      ${sqlValue(enquiry.notificationMethod || "")},
      ${sqlValue(enquiry.notificationReason || "")},
      ${sqlValue(enquiry.clientReplyStatus || "Pending")},
      ${sqlValue(enquiry.clientReplyMethod || "")},
      ${sqlValue(enquiry.clientReplyReason || "")},
      ${sqlValue(enquiry.status || "New")},
      ${sqlValue(enquiry.sourceSite || "rampal")},
      ${sqlValue(enquiry.location || "")},
      ${sqlValue(enquiry.message)}
    );
  `);
}

function normalizeSourceSite(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "midx"
    ? "midx"
    : "rampal";
}

async function readEnquiries(sourceSite = "") {
  const normalizedSource = sourceSite ? normalizeSourceSite(sourceSite) : "";

  if (USE_POSTGRES) {
    const whereClause = normalizedSource ? "WHERE source_site = $1" : "";
    const params = normalizedSource ? [normalizedSource] : [];
    const { rows } = await pgPool.query(`
      SELECT
        id,
        created_at AS "createdAt",
        name,
        phone,
        email,
        event_type AS "eventType",
        event_date AS "eventDate",
        package_name AS "packageName",
        guest_count AS "guestCount",
        budget,
        preferred_contact AS "preferredContact",
        notification_status AS "notificationStatus",
        notification_method AS "notificationMethod",
        notification_reason AS "notificationReason",
        client_reply_status AS "clientReplyStatus",
        client_reply_method AS "clientReplyMethod",
        client_reply_reason AS "clientReplyReason",
        status,
        source_site AS "sourceSite",
        location,
        message
      FROM enquiries
      ${whereClause}
      ORDER BY created_at DESC;
    `, params);

    return rows;
  }

  const whereClause = normalizedSource ? `WHERE source_site = ${sqlValue(normalizedSource)}` : "";
  const output = runSql(`
    SELECT
      id,
      created_at AS createdAt,
      name,
      phone,
      email,
      event_type AS eventType,
      event_date AS eventDate,
      package_name AS packageName,
      guest_count AS guestCount,
      budget,
      preferred_contact AS preferredContact,
      notification_status AS notificationStatus,
      notification_method AS notificationMethod,
      notification_reason AS notificationReason,
      client_reply_status AS clientReplyStatus,
      client_reply_method AS clientReplyMethod,
      client_reply_reason AS clientReplyReason,
      status,
      source_site AS sourceSite,
      location,
      message
    FROM enquiries
    ${whereClause}
    ORDER BY datetime(created_at) DESC;
  `, { json: true });

  return output ? JSON.parse(output) : [];
}

function sqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function serveHtml(request, response, filePath) {
  fs.readFile(filePath, "utf8", (error, html) => {
    if (error) {
      sendJson(response, 500, { error: "Unable to load the website." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(request.method === "HEAD" ? undefined : html);
  });
}

function serveTextFile(response, filePath, contentType) {
  fs.readFile(filePath, "utf8", (error, text) => {
    if (error) {
      sendJson(response, 500, { error: "Unable to load the requested file." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType
    });
    response.end(text);
  });
}

function sendRedirect(response, location) {
  response.writeHead(301, {
    Location: location
  });
  response.end();
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpeg" || extension === ".jpg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function getMidxPagePath(pathname) {
  const pages = new Map([
    ["/midx-traders/", "index.html"],
    ["/midx-traders/index", "index.html"],
    ["/midx-traders/index.html", "index.html"],
    ["/midx-traders/about", "about.html"],
    ["/midx-traders/about.html", "about.html"],
    ["/midx-traders/products", "products.html"],
    ["/midx-traders/products.html", "products.html"],
    ["/midx-traders/services", "services.html"],
    ["/midx-traders/services.html", "services.html"],
    ["/midx-traders/faq", "faq.html"],
    ["/midx-traders/faq.html", "faq.html"],
    ["/midx-traders/quote", "quote.html"],
    ["/midx-traders/quote.html", "quote.html"]
  ]);

  const page = pages.get(pathname);
  return page ? path.join(MIDX_ROOT, page) : "";
}

function getMidxRootPagePath(pathname) {
  const pages = new Map([
    ["/", "index.html"],
    ["/index", "index.html"],
    ["/index.html", "index.html"],
    ["/about", "about.html"],
    ["/about.html", "about.html"],
    ["/products", "products.html"],
    ["/products.html", "products.html"],
    ["/services", "services.html"],
    ["/services.html", "services.html"],
    ["/faq", "faq.html"],
    ["/faq.html", "faq.html"],
    ["/quote", "quote.html"],
    ["/quote.html", "quote.html"]
  ]);

  const page = pages.get(pathname);
  return page ? path.join(MIDX_ROOT, page) : "";
}

function isMidxHost(request) {
  const configuredDomains = String(process.env.MIDX_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  const allowedDomains = new Set([
    "midxtradersltd.com",
    "www.midxtradersltd.com",
    ...configuredDomains
  ]);

  const host = String(request.headers.host || "")
    .split(":")[0]
    .toLowerCase();

  return allowedDomains.has(host);
}

function serveStaticFile(request, response, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { error: "Asset not found." });
      return;
    }

    const mimeType = getMimeType(filePath);
    const cacheControl = path.extname(filePath).toLowerCase() === ".css"
      ? "no-cache"
      : "public, max-age=31536000, immutable";

    response.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": cacheControl
    });
    response.end(request.method === "HEAD" ? undefined : data);
  });
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sanitize(value) {
  return String(value || "").trim();
}

function validateEnquiry(payload) {
  const enquiry = {
    name: sanitize(payload.name),
    phone: sanitize(payload.phone),
    email: sanitize(payload.email),
    eventType: sanitize(payload.eventType),
    eventDate: sanitize(payload.eventDate),
    packageName: sanitize(payload.packageName),
    guestCount: sanitize(payload.guestCount),
    budget: sanitize(payload.budget),
    preferredContact: sanitize(payload.preferredContact),
    sourceSite: normalizeSourceSite(payload.sourceSite),
    location: sanitize(payload.location),
    message: sanitize(payload.message)
  };

  if (!enquiry.name || !enquiry.phone || !enquiry.email || !enquiry.eventType || !enquiry.message) {
    return { error: "Please complete all required fields before sending your quote request." };
  }

  return { enquiry };
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    const key = index >= 0 ? trimmed.slice(0, index) : trimmed;
    const value = index >= 0 ? trimmed.slice(index + 1) : "";
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getAuthorizedSession(request) {
  clearExpiredSessions();
  const token = parseCookies(request).admin_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, session };
}

function requireAdmin(request, response) {
  const authorized = getAuthorizedSession(request);
  if (!authorized) {
    sendJson(response, 401, { error: "Admin login required." });
    return null;
  }
  return authorized;
}

function logNotification(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(NOTIFICATION_LOG_PATH, line, "utf8");
}

function createSmtpConnection() {
  return new Promise((resolve, reject) => {
    const options = {
      host: SMTP_HOST,
      port: SMTP_PORT
    };

    const socket = SMTP_SECURE
      ? tls.connect({ ...options, servername: SMTP_HOST })
      : net.createConnection(options);

    const handleError = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.once("error", handleError);
    socket.once(SMTP_SECURE ? "secureConnect" : "connect", () => {
      socket.removeListener("error", handleError);
      resolve(socket);
    });
  });
}

function createSmtpReader(socket) {
  let buffer = "";
  let pending = null;

  const tryResolve = () => {
    if (!pending) return;
    const lines = buffer.split("\r\n");

    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!/^\d{3}[ -]/.test(line)) {
        continue;
      }

      const code = line.slice(0, 3);
      if (line[3] !== " ") {
        continue;
      }

      const consumed = lines.slice(0, index + 1).join("\r\n").length + 2;
      buffer = buffer.slice(consumed);
      const current = pending;
      pending = null;
      current.resolve({ code: Number(code), message: line });
      return;
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    tryResolve();
  });

  return function readResponse() {
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      tryResolve();
    });
  };
}

async function smtpCommand(socket, readResponse, command, expectedCodes) {
  if (command) {
    socket.write(`${command}\r\n`);
  }

  const response = await readResponse();
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP error after "${command || "greeting"}": ${response.message}`);
  }

  return response;
}

function hasSmtpConfig() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM && NOTIFY_EMAIL);
}

function hasResendConfig() {
  return Boolean(RESEND_API_KEY && RESEND_FROM && NOTIFY_EMAIL);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendNotificationEmailViaSmtp({ to, subject, body }) {
  const socket = await createSmtpConnection();
  const readResponse = createSmtpReader(socket);

  try {
    await smtpCommand(socket, readResponse, "", [220]);
    await smtpCommand(socket, readResponse, "EHLO rampallimited.local", [250]);
    await smtpCommand(socket, readResponse, `AUTH LOGIN`, [334]);
    await smtpCommand(socket, readResponse, Buffer.from(SMTP_USER).toString("base64"), [334]);
    await smtpCommand(socket, readResponse, Buffer.from(SMTP_PASS).toString("base64"), [235]);
    await smtpCommand(socket, readResponse, `MAIL FROM:<${SMTP_FROM}>`, [250]);
    await smtpCommand(socket, readResponse, `RCPT TO:<${to}>`, [250, 251]);
    await smtpCommand(socket, readResponse, "DATA", [354]);

    const headers = [
      `From: ${SMTP_FROM}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body.replace(/\n\./g, "\n..")
    ].join("\r\n");

    socket.write(`${headers}\r\n.\r\n`);
    await smtpCommand(socket, readResponse, "", [250]);
    await smtpCommand(socket, readResponse, "QUIT", [221]);
  } finally {
    socket.end();
  }
}

function sendNotificationEmailViaResend({ to, subject, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      text: body
    });

    const request = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        let responseBody = "";

        response.on("data", (chunk) => {
          responseBody += chunk.toString("utf8");
        });

        response.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(responseBody || "{}");
          } catch {
            parsed = {};
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({
              id: parsed.id || "",
              statusCode: response.statusCode
            });
            return;
          }

          const message =
            parsed.message ||
            parsed.error ||
            responseBody ||
            "Unable to deliver email.";

          const error = new Error(`Resend API error ${response.statusCode}: ${message}`);
          error.statusCode = response.statusCode;
          reject(error);
        });
      }
    );

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function sendEmailViaSendmail(to, subject, body, enquiryId, label) {
  if (!fs.existsSync(SENDMAIL_BIN)) {
    const reason = "sendmail is not available on this host.";
    logNotification(`${label} skipped for ${enquiryId}: ${reason}`);
    return { delivered: false, reason };
  }

  const result = spawnSync(
    SENDMAIL_BIN,
    ["-t"],
    {
      input: `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`,
      encoding: "utf8"
    }
  );

  if (result.error) {
    const reason = String(result.error.message || "sendmail failed");
    logNotification(`${label} failed for ${enquiryId}: ${reason}`);
    return { delivered: false, reason };
  }

  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || "sendmail failed").trim();
    logNotification(`${label} failed for ${enquiryId}: ${reason}`);
    return { delivered: false, reason };
  }

  logNotification(`${label} delivered for ${enquiryId} to ${to} via sendmail.`);
  return { delivered: true, method: "sendmail" };
}

async function deliverEmail({ to, subject, body, enquiryId, label }) {
  let lastReason = "";

  if (hasResendConfig()) {
    try {
      const result = await sendNotificationEmailViaResend({ to, subject, body });
      logNotification(`${label} delivered for ${enquiryId} to ${to} via Resend.`);
      return {
        delivered: true,
        method: "resend",
        providerId: result.id || ""
      };
    } catch (error) {
      lastReason = String(error.message || error);
      logNotification(`Resend ${label.toLowerCase()} failed for ${enquiryId}: ${lastReason}`);

      if (Number(error.statusCode) === 429) {
        await delay(1200);

        try {
          const retryResult = await sendNotificationEmailViaResend({ to, subject, body });
          logNotification(`${label} delivered for ${enquiryId} to ${to} via Resend after retry.`);
          return {
            delivered: true,
            method: "resend",
            providerId: retryResult.id || ""
          };
        } catch (retryError) {
          lastReason = String(retryError.message || retryError);
          logNotification(`Resend retry for ${label.toLowerCase()} failed for ${enquiryId}: ${lastReason}`);
        }
      }

      return {
        delivered: false,
        method: "resend",
        reason: lastReason || "Resend could not deliver the email."
      };
    }
  }

  if (hasSmtpConfig()) {
    try {
      await sendNotificationEmailViaSmtp({ to, subject, body });
      logNotification(`${label} delivered for ${enquiryId} to ${to} via SMTP.`);
      return { delivered: true, method: "smtp" };
    } catch (error) {
      lastReason = String(error.message || error);
      logNotification(`SMTP ${label.toLowerCase()} failed for ${enquiryId}: ${lastReason}`);
    }
  }

  const fallbackResult = sendEmailViaSendmail(to, subject, body, enquiryId, label);
  if (!fallbackResult.delivered && lastReason) {
    return {
      delivered: false,
      method: fallbackResult.method || "",
      reason: lastReason
    };
  }

  return fallbackResult;
}

async function sendNotificationEmail(enquiry) {
  const siteLabel = enquiry.sourceSite === "midx" ? "MIDX TRADERS LTD" : "RAMPAL LIMITED";
  const subject = `New ${siteLabel} Quote Request: ${enquiry.eventType} - ${enquiry.name}`;
  const body = [
    `A new wholesale building materials quote request was submitted on the ${siteLabel} website.`,
    "",
    `Reference: ${enquiry.id}`,
    `Created At: ${enquiry.createdAt}`,
    `Name: ${enquiry.name}`,
    `Phone: ${enquiry.phone}`,
    `Email: ${enquiry.email}`,
    `Material Category: ${enquiry.eventType}`,
    `Needed By: ${enquiry.eventDate || "Not provided"}`,
    `Order Type: ${enquiry.packageName || "Not provided"}`,
    `Quantity: ${enquiry.guestCount || "Not provided"}`,
    `Budget Range: ${enquiry.budget || "Not provided"}`,
    `Preferred Contact: ${enquiry.preferredContact || "Not provided"}`,
    `Delivery Area: ${enquiry.location || "Not provided"}`,
    `Status: ${enquiry.status || "New"}`,
    "",
    "Material List:",
    enquiry.message
  ].join("\n");

  if (!NOTIFY_EMAIL) {
    logNotification(`Notification skipped for ${enquiry.id}: NOTIFY_EMAIL is not configured.`);
    return { delivered: false, reason: "NOTIFY_EMAIL is not configured." };
  }

  return deliverEmail({
    to: NOTIFY_EMAIL,
    subject,
    body,
    enquiryId: enquiry.id,
    label: "Notification"
  });
}

async function updateEnquiryNotification(enquiryId, notification) {
  if (USE_POSTGRES) {
    await pgPool.query(
      `
        UPDATE enquiries
        SET
          notification_status = $1,
          notification_method = $2,
          notification_reason = $3
        WHERE id = $4;
      `,
      [
        notification.delivered ? "Delivered" : "Failed",
        notification.method || "",
        notification.reason || "",
        enquiryId
      ]
    );
    return;
  }

  runSql(`
    UPDATE enquiries
    SET
      notification_status = ${sqlValue(notification.delivered ? "Delivered" : "Failed")},
      notification_method = ${sqlValue(notification.method || "")},
      notification_reason = ${sqlValue(notification.reason || "")}
    WHERE id = ${sqlValue(enquiryId)};
  `);
}

async function sendClientReplyEmail(enquiry) {
  if (!CLIENT_AUTO_REPLY_ENABLED) {
    return { delivered: false, reason: "Client auto-reply is disabled until a verified sending domain is connected." };
  }

  if (!enquiry.email) {
    return { delivered: false, reason: "Client email is not available." };
  }

  const siteLabel = enquiry.sourceSite === "midx" ? "MIDX TRADERS LTD" : "RAMPAL LIMITED";
  const subject = `${siteLabel} received your quote request`;
  const body = [
    `Hi ${enquiry.name || "there"},`,
    "",
    `Thank you for getting in touch with ${siteLabel}.`,
    "Your wholesale building materials quote request has been received successfully and will be reviewed shortly.",
    "",
    `Reference: ${enquiry.id}`,
    `Material Category: ${enquiry.eventType || "Not provided"}`,
    `Needed By: ${enquiry.eventDate || "Not provided"}`,
    `Order Type: ${enquiry.packageName || "Not provided"}`,
    "",
    "If you need to add quantities, delivery details, or product specifications, you can reply to this email.",
    "",
    "Regards,",
    siteLabel
  ].join("\n");

  return deliverEmail({
    to: enquiry.email,
    subject,
    body,
    enquiryId: enquiry.id,
    label: "Client reply"
  });
}

async function updateEnquiryClientReply(enquiryId, replyResult) {
  if (USE_POSTGRES) {
    await pgPool.query(
      `
        UPDATE enquiries
        SET
          client_reply_status = $1,
          client_reply_method = $2,
          client_reply_reason = $3
        WHERE id = $4;
      `,
      [
        replyResult.delivered ? "Delivered" : "Failed",
        replyResult.method || "",
        replyResult.reason || "",
        enquiryId
      ]
    );
    return;
  }

  runSql(`
    UPDATE enquiries
    SET
      client_reply_status = ${sqlValue(replyResult.delivered ? "Delivered" : "Failed")},
      client_reply_method = ${sqlValue(replyResult.method || "")},
      client_reply_reason = ${sqlValue(replyResult.reason || "")}
    WHERE id = ${sqlValue(enquiryId)};
  `);
}

async function handleCreateEnquiry(request, response) {
  try {
    const body = await collectRequestBody(request);
    const payload = JSON.parse(body || "{}");
    const { enquiry, error } = validateEnquiry(payload);

    if (error) {
      sendJson(response, 400, { error });
      return;
    }

    const savedEnquiry = {
      id: "ENQ-" + Date.now(),
      createdAt: new Date().toISOString(),
      status: "New",
      notificationStatus: "Pending",
      notificationMethod: "",
      notificationReason: "",
      clientReplyStatus: "Pending",
      clientReplyMethod: "",
      clientReplyReason: "",
      ...enquiry
    };

    await insertEnquiry(savedEnquiry);
    const notification = await sendNotificationEmail(savedEnquiry);
    await delay(800);
    const clientReply = await sendClientReplyEmail(savedEnquiry);
    await updateEnquiryNotification(savedEnquiry.id, notification);
    await updateEnquiryClientReply(savedEnquiry.id, clientReply);
    savedEnquiry.notificationStatus = notification.delivered ? "Delivered" : "Failed";
    savedEnquiry.notificationMethod = notification.method || "";
    savedEnquiry.notificationReason = notification.reason || "";
    savedEnquiry.clientReplyStatus = clientReply.delivered ? "Delivered" : "Failed";
    savedEnquiry.clientReplyMethod = clientReply.method || "";
    savedEnquiry.clientReplyReason = clientReply.reason || "";

    sendJson(response, 201, {
      message: "Your quote request has been sent successfully.",
      enquiry: savedEnquiry,
      notification,
      clientReply
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: "The quote request data was not valid JSON." });
      return;
    }

    sendJson(response, 500, { error: error.message || "Unable to save the quote request." });
  }
}

async function handleListAdminEnquiries(request, response) {
  if (!requireAdmin(request, response)) {
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const enquiries = await readEnquiries(url.searchParams.get("source") || "");
    sendJson(response, 200, { enquiries });
  } catch (error) {
    sendJson(response, 500, { error: "Unable to load quote requests." });
  }
}

async function handleUpdateEnquiryStatus(request, response) {
  if (!requireAdmin(request, response)) {
    return;
  }

  try {
    const body = await collectRequestBody(request);
    const payload = JSON.parse(body || "{}");
    const enquiryId = sanitize(payload.id);
    const status = sanitize(payload.status);
    const allowedStatuses = new Set(["New", "Contacted", "Quoted", "Closed"]);

    if (!enquiryId || !allowedStatuses.has(status)) {
      sendJson(response, 400, { error: "A valid quote request id and status are required." });
      return;
    }

    if (USE_POSTGRES) {
      await pgPool.query(
        `
          UPDATE enquiries
          SET status = $1
          WHERE id = $2;
        `,
        [status, enquiryId]
      );
    } else {
      runSql(`
        UPDATE enquiries
        SET status = ${sqlValue(status)}
        WHERE id = ${sqlValue(enquiryId)};
      `);
    }

    sendJson(response, 200, { message: "Quote request status updated." });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: "The status payload was not valid JSON." });
      return;
    }

    sendJson(response, 500, { error: "Unable to update quote request status." });
  }
}

function toCsv(value) {
  const stringValue = String(value || "");
  return `"${stringValue.replace(/"/g, '""')}"`;
}

async function handleExportEnquiries(request, response) {
  if (!requireAdmin(request, response)) {
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const sourceSite = url.searchParams.get("source") || "";
    const enquiries = await readEnquiries(sourceSite);
    const header = [
      "id",
      "createdAt",
      "sourceSite",
      "status",
      "name",
      "phone",
      "email",
      "materialCategory",
      "neededBy",
      "orderType",
      "quantity",
      "budgetRange",
      "preferredContact",
      "notificationStatus",
      "notificationMethod",
      "notificationReason",
      "clientReplyStatus",
      "clientReplyMethod",
      "clientReplyReason",
      "deliveryArea",
      "materialList"
    ];
    const rows = enquiries.map((item) => [
      item.id,
      item.createdAt,
      item.sourceSite,
      item.status,
      item.name,
      item.phone,
      item.email,
      item.eventType,
      item.eventDate,
      item.packageName,
      item.guestCount,
      item.budget,
      item.preferredContact,
      item.notificationStatus,
      item.notificationMethod,
      item.notificationReason,
      item.clientReplyStatus,
      item.clientReplyMethod,
      item.clientReplyReason,
      item.location,
      item.message
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map(toCsv).join(","))
      .join("\n");
    const filename = sourceSite ? `${normalizeSourceSite(sourceSite)}-quote-requests.csv` : "rampal-quote-requests.csv";

    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    });
    response.end(csv);
  } catch (error) {
    sendJson(response, 500, { error: "Unable to export quote requests." });
  }
}

async function handleAdminLogin(request, response) {
  try {
    const body = await collectRequestBody(request);
    const payload = JSON.parse(body || "{}");
    const password = sanitize(payload.password);

    if (!password || password !== ADMIN_PASSWORD) {
      sendJson(response, 401, { error: "Incorrect admin password." });
      return;
    }

    const token = createSession();
    sendJson(
      response,
      200,
      {
        message: "Admin login successful."
      },
      {
        "Set-Cookie": `admin_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
      }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(response, 400, { error: "The login payload was not valid JSON." });
      return;
    }

    sendJson(response, 500, { error: "Unable to process admin login." });
  }
}

function handleAdminLogout(request, response) {
  const token = parseCookies(request).admin_session;
  if (token) {
    sessions.delete(token);
  }

  sendJson(
    response,
    200,
    { message: "Logged out." },
    { "Set-Cookie": "admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" }
  );
}

function handleAdminSession(request, response) {
  const authorized = getAuthorizedSession(request);
  sendJson(response, 200, {
    authenticated: Boolean(authorized),
    usingDefaultPassword: ADMIN_PASSWORD === "change-me-admin-password"
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (isMidxHost(request) && (request.method === "GET" || request.method === "HEAD")) {
    if (url.pathname.startsWith("/assets/")) {
      const assetPath = path.normalize(path.join(MIDX_ROOT, url.pathname.slice(1)));
      if (!assetPath.startsWith(MIDX_ASSETS_DIR)) {
        sendJson(response, 403, { error: "Forbidden." });
        return;
      }
      serveStaticFile(request, response, assetPath);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      serveStaticFile(request, response, path.join(MIDX_ASSETS_DIR, "favicon.svg"));
      return;
    }

    const midxRootPagePath = getMidxRootPagePath(url.pathname);
    if (midxRootPagePath) {
      serveHtml(request, response, midxRootPagePath);
      return;
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/assets/")) {
    const assetPath = path.normalize(path.join(ROOT, url.pathname.slice(1)));
    const assetsRoot = path.join(ROOT, "assets");
    if (!assetPath.startsWith(assetsRoot)) {
      sendJson(response, 403, { error: "Forbidden." });
      return;
    }
    serveStaticFile(request, response, assetPath);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/midx-traders") {
    sendRedirect(response, "/midx-traders/");
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/midx-traders/assets/")) {
    const requestedAsset = url.pathname.slice("/midx-traders/".length);
    const assetPath = path.normalize(path.join(MIDX_ROOT, requestedAsset));
    if (!assetPath.startsWith(MIDX_ASSETS_DIR)) {
      sendJson(response, 403, { error: "Forbidden." });
      return;
    }
    serveStaticFile(request, response, assetPath);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/midx-traders/")) {
    const midxPagePath = getMidxPagePath(url.pathname);
    if (midxPagePath) {
      serveHtml(request, response, midxPagePath);
      return;
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/favicon.ico") {
    serveStaticFile(request, response, path.join(ROOT, "assets", "rampal", "favicon-512.png"));
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    serveHtml(request, response, INDEX_PATH);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/about") {
    serveHtml(request, response, ABOUT_PATH);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/products") {
    serveHtml(request, response, PRODUCTS_PATH);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/offers") {
    serveHtml(request, response, OFFERS_PATH);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/faq") {
    serveHtml(request, response, FAQ_PATH);
    return;
  }

  if (request.method === "GET" && url.pathname === "/rampal-admin") {
    serveHtml(request, response, ADMIN_PATH);
    return;
  }

  if (request.method === "GET" && url.pathname === "/midx-admin") {
    serveHtml(request, response, MIDX_ADMIN_PATH);
    return;
  }

  if (request.method === "GET" && url.pathname === "/robots.txt") {
    serveTextFile(response, ROBOTS_PATH, "text/plain; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/sitemap.xml") {
    serveTextFile(response, SITEMAP_PATH, "application/xml; charset=utf-8");
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/enquiries") {
    await handleCreateEnquiry(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "RAMPAL LIMITED API" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/enquiries") {
    await handleListAdminEnquiries(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/enquiries/status") {
    await handleUpdateEnquiryStatus(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/export") {
    await handleExportEnquiries(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    await handleAdminLogin(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    handleAdminLogout(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/session") {
    handleAdminSession(request, response);
    return;
  }

  sendJson(response, 404, { error: "Route not found." });
});

setupDatabase()
  .then(() => {
    server.listen(PORT, () => {
      const storage = USE_POSTGRES ? "Postgres" : "SQLite";
      console.log(`RAMPAL LIMITED website running on http://localhost:${PORT} with ${storage} storage`);
    });
  })
  .catch((error) => {
    console.error("Unable to start RAMPAL LIMITED website:", error);
    process.exit(1);
  });
