<<<<<<< HEAD
"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const { z } = require("zod");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const startKeepAlive = require("./keepAlive");

/* ── Validate required env vars ──────────────────── */
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);

if (missingEnv.length) {
  console.error(
    `\n⚠️ Missing environment variables:\n   ${missingEnv.join("\n   ")}`
  );
  console.error("\n   Copy .env and fill in your values.\n");
  process.exit(1);
}

/* ── Supabase client ─────────────────────────────── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
    },
  }
);

/* ── Validation schema ───────────────────────────── */

const fullName = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).filter(Boolean).length >= 2, {
    message: "Please enter first and last name",
  });

const kenyanId = z.string().trim().regex(/^\d{7,10}$/, {
  message: "Invalid ID number",
});

const kenyanPhone = z.string().trim().regex(/^(?:\+254|0)[17]\d{8}$/, {
  message: "Invalid Kenyan phone number",
});

const ReferralSchema = z.object({
  refName: fullName,
  refId: kenyanId,
  refPhone: kenyanPhone,
  custName: fullName,
  custPhone: kenyanPhone,
  department: z.string().trim().min(1, "Department is required"),

  referralCode: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === null || v === "") return undefined;
      return v;
    }),

  refereeConsent: z.boolean(),
  privacyConsent: z.boolean(),

  // NEW CONSENT FIELDS
  userConsent: z.boolean(),
  dataProcessingConsent: z.boolean(),
});

/* ── Phone normalization ─────────────────────────── */
// Kept as a top-level function (not redefined per-request) and used
// consistently everywhere we read OR write a phone number, so what
// gets queried always matches what gets stored.
function normalizeKenyanPhone(phone) {
  if (!phone) return "";

  let cleaned = phone.toString().trim().replace(/\D/g, "");

  if (cleaned.startsWith("254")) {
    cleaned = cleaned.substring(3);
  } else if (cleaned.startsWith("0")) {
    cleaned = cleaned.substring(1);
  }

  return cleaned;
}

/* ── CORS ────────────────────────────────────────── */

const ALLOWED_ORIGIN = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")
  : `http://localhost:${PORT}`;

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || origin === ALLOWED_ORIGIN) {
        return cb(null, true);
      }
      cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  })
);

/* ── Middleware ──────────────────────────────────── */

app.use(express.json());

app.use((req, res, next) => {
  if (/(\.env|\.git|\.DS_Store)/i.test(req.path)) {
    return res.status(403).end();
  }
  next();
});

app.use(express.static(path.join(__dirname)));

const referralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "Too many submissions. Please try again later.",
  },
});

/* ── POST /api/referral ──────────────────────────── */

app.post("/api/referral", referralLimiter, async (req, res) => {
  console.log("📥 Incoming request body:", req.body);

  const parsed = ReferralSchema.safeParse(req.body);

  if (!parsed.success) {
    console.log("❌ ZOD ISSUES:", JSON.stringify(parsed.error.issues, null, 2));
    return res.status(400).json({
      error: "Validation failed.",
      issues: parsed.error.issues,
    });
  }

  const {
    refName,
    refId,
    refPhone,
    custName,
    custPhone,
    department,
    referralCode,
    refereeConsent,
    privacyConsent,
    userConsent,
    dataProcessingConsent,
  } = parsed.data;

  if (department === "customer_service" && !referralCode?.trim()) {
    return res.status(400).json({
      error: "Referral code is required for Customer Service.",
    });
  }

  const normalizedCustomerPhone = normalizeKenyanPhone(custPhone);
  const normalizedReferrerPhone = normalizeKenyanPhone(refPhone);

  console.log("=================================");
  console.log("📞 Customer phone submitted:", custPhone);
  console.log("📞 Normalized phone being checked:", normalizedCustomerPhone);
  console.log("=================================");

  // Self referral check
  if (normalizedCustomerPhone === normalizedReferrerPhone) {
    console.log("❌ Self referral detected");
    return res.status(400).json({ error: "Self referral is not accepted." });
  }

  try {
    // ===============================
    // Duplicate check — SUFFIX MATCH
    // -------------------------------
    // Existing records in the table are stored in mixed formats
    // (0792502010, +254792502010, 792502010, etc). Rather than
    // requiring an exact string match — which misses duplicates
    // whenever the stored format differs from what we normalize
    // to — we match on the last 9 digits, which are the same
    // regardless of prefix.
    //
    // "%792502010" (leading % only, nothing after) tells Postgres
    // "ends with these characters" — so it matches all of:
    //   0792502010        (ends in 792502010)
    //   +254792502010     (ends in 792502010)
    //   792502010         (ends in 792502010)
    // in a single query, with no data migration required.
    //
    // Trade-off: this does a sequential scan rather than using an
    // index (fine at ~4,000 rows; if the tables grow much larger,
    // a trigram index would speed this up, or normalizing stored
    // data would let you go back to an exact-match query).
    // ===============================

    const suffixPattern = `%${normalizedCustomerPhone}`;

    const [referralCheck, employeeCheck] = await Promise.all([
      supabase
        .from("referrals")
        .select("id, customer_phone")
        .ilike("customer_phone", suffixPattern)
        .limit(1),
      supabase
        .from("employee_referrals")
        .select("id, customer_phone")
        .ilike("customer_phone", suffixPattern)
        .limit(1),
    ]);

    if (referralCheck.error || employeeCheck.error) {
      console.error(
        "❌ Duplicate check error:",
        referralCheck.error?.message,
        employeeCheck.error?.message
      );
      return res.status(500).json({ error: "Unable to verify customer." });
    }

    if (
      (referralCheck.data && referralCheck.data.length > 0) ||
      (employeeCheck.data && employeeCheck.data.length > 0)
    ) {
      console.log(
        "❌ Duplicate found (suffix match) for",
        normalizedCustomerPhone,
        "matched:",
        referralCheck.data?.[0]?.customer_phone || employeeCheck.data?.[0]?.customer_phone
      );
      return res.status(409).json({
        error: "Sorry, Customer has already been referred.",
      });
    }

    console.log("✅ No duplicate found (suffix match) for", normalizedCustomerPhone);

    // ===============================
    // Insert
    // -------------------------------
    // NOTE: there is no DB-level unique constraint in this version —
    // by design, per your request to avoid a migration. That means
    // the ilike check above is the ONLY thing preventing a duplicate,
    // and it is not atomic: if two submissions for the same phone
    // number land close enough together, both could still pass the
    // check before either insert completes. For normal form
    // submissions (one person clicking submit once) this is not a
    // practical concern. It only becomes one under real concurrency
    // (e.g. a double-tap that fires two requests, or a retried
    // request from a flaky connection). The 23505 handling below is
    // kept as a harmless no-op safety net in case a unique index is
    // added later — it currently will not trigger.
    // ===============================

    const { data, error } = await supabase
      .from("employee_referrals")
      .insert({
        referrer_name: refName.trim(),
        referrer_id: refId.trim(),
        referrer_phone: normalizedReferrerPhone,
        customer_name: custName.trim(),
        customer_phone: normalizedCustomerPhone,
        department: department.trim(),
        referral_code: referralCode && referralCode.trim() ? referralCode.trim() : null,
        referee_consent: refereeConsent,
        privacy_consent: privacyConsent,
        user_consent: userConsent,
        data_processing_consent: dataProcessingConsent,
        status: "New",
      })
      .select();

    console.log("📦 INSERT RESULT:", data);
    console.log("❌ INSERT ERROR:", error);

    if (error) {
      // Postgres unique_violation → someone else inserted this same
      // phone number in the split-second between our check and our
      // insert. This is the case the pre-check alone can't catch.
      if (error.code === "23505") {
        console.log("❌ Duplicate caught by DB unique constraint (race)");
        return res.status(409).json({
          error: "Sorry, Customer has already been referred.",
        });
      }

      console.error("❌ Supabase error:", error.message);
      return res.status(502).json({
        error: "Could not save referral. Please try again.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Referral saved.",
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({
      error: "Server error. Please try again.",
    });
  }
});

/* ── Health check ────────────────────────────────── */

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

/* ── Start server ────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`🚀 Spiro Referral API → http://localhost:${PORT}`);
  console.log(`📊 Supabase project → ${process.env.SUPABASE_URL}`);
  startKeepAlive();
});
=======
"use strict";
 
require("dotenv").config();
 
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const { z } = require("zod");
const path = require("path");
 
const app = express();
const PORT = process.env.PORT || 3000;
const startKeepAlive = require("./keepAlive");
 
/* ── Validate required env vars ──────────────────── */
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
 
if (missingEnv.length) {
  console.error(
    `\n⚠️ Missing environment variables:\n   ${missingEnv.join("\n   ")}`
  );
  console.error("\n   Copy .env and fill in your values.\n");
  process.exit(1);
}
 
/* ── Supabase client ─────────────────────────────── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
    },
  }
);
 
/* ── Validation schema ───────────────────────────── */
 
const fullName = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).filter(Boolean).length >= 2, {
    message: "Please enter first and last name",
  });
 
const kenyanId = z.string().trim().regex(/^\d{7,10}$/, {
  message: "Invalid ID number",
});
 
const kenyanPhone = z.string().trim().regex(/^(?:\+254|0)[17]\d{8}$/, {
  message: "Invalid Kenyan phone number",
});
 
const ReferralSchema = z.object({
  refName: fullName,
  refId: kenyanId,
  refPhone: kenyanPhone,
  custName: fullName,
  custPhone: kenyanPhone,
  department: z
    .string()
    .trim()
    .min(1, "Department is required"),
 
referralCode: z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === "") return undefined;
    return v;
  }),
 
  refereeConsent: z.boolean(),
  privacyConsent: z.boolean(),
 
   // NEW CONSENT FIELDS
  userConsent: z.boolean(),
  dataProcessingConsent: z.boolean(),
});
 
/* ── CORS ────────────────────────────────────────── */
 
const ALLOWED_ORIGIN = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")
  : `http://localhost:${PORT}`;
 
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || origin === ALLOWED_ORIGIN) {
        return cb(null, true);
      }
 
      cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  })
);
 
/* ── Middleware ──────────────────────────────────── */
 
app.use(express.json());
 
app.use((req, res, next) => {
  if (/(\.env|\.git|\.DS_Store)/i.test(req.path)) {
    return res.status(403).end();
  }
 
  next();
});
 
app.use(express.static(path.join(__dirname)));
 
 
const referralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "Too many submissions. Please try again later.",
  },
});
 
 
/* ── POST /api/referral ──────────────────────────── */
 
app.post("/api/referral", referralLimiter, async (req, res) => {
  console.log("📥 Incoming request body:", req.body);
 
  const parsed = ReferralSchema.safeParse(req.body);
 
 if (!parsed.success) {
  console.log(
    "❌ ZOD ISSUES:",
    JSON.stringify(parsed.error.issues, null, 2)
  );
 
  return res.status(400).json({
    error: "Validation failed.",
    issues: parsed.error.issues,
  });
}
 
 
 
 const normalizeKenyanPhone = (phone) => {
  if (!phone) return "";
 
  let cleaned = phone.toString().trim();
 
  // Remove everything except digits
  cleaned = cleaned.replace(/\D/g, "");
 
  if (cleaned.startsWith("254")) {
    cleaned = cleaned.substring(3);
  } else if (cleaned.startsWith("0")) {
    cleaned = cleaned.substring(1);
  }
 
  return cleaned;
};
 
  const {
    refName,
    refId,
    refPhone,
    custName,
    custPhone,
    department,
    referralCode,
    refereeConsent,
    privacyConsent,
    userConsent,
    dataProcessingConsent,
  } = parsed.data;
 
 
  if (department === "customer_service" && !referralCode?.trim()) {
  return res.status(400).json({
    error: "Referral code is required for Customer Service.",
  });
}
  try {
 
// ===============================
// Normalize customer phone
// ===============================
 
const normalizedCustomerPhone = normalizeKenyanPhone(custPhone);
const normalizedReferrerPhone = normalizeKenyanPhone(refPhone);
 
console.log("=================================");
console.log("📞 Customer phone submitted:", custPhone);
console.log("📞 Normalized phone being checked:", normalizedCustomerPhone);
console.log("=================================");
 
 
// Self referral check
if (normalizedCustomerPhone === normalizedReferrerPhone) {
 
  console.log("❌ Self referral detected");
 
  return res.status(400).json({
    error: "Self referral is not accepted."
  });
}
 
 
// ===============================
// Check referrals table
// ===============================
 
console.log(
  `🔍 Checking referrals table for phone: ${normalizedCustomerPhone}`
);
 
 
const { data: referrals, error: referralCheckError } = await supabase
  .from("referrals")
  .select("id, customer_phone");
 
 
if (referralCheckError) {
 
  console.error(
    "❌ Referral table check error:",
    referralCheckError.message
  );
 
  return res.status(500).json({
    error: "Unable to verify customer."
  });
}
 
 
const referralDuplicate = referrals.find(
  (record) =>
    normalizeKenyanPhone(record.customer_phone) === normalizedCustomerPhone
);
 
 
if (referralDuplicate) {
 
  console.log("❌ DUPLICATE FOUND IN referrals TABLE");
  console.log({
    existingId: referralDuplicate.id,
    existingPhone: referralDuplicate.customer_phone,
    checkedPhone: normalizedCustomerPhone
  });
 
 
  return res.status(409).json({
    error: "Sorry, Customer has already been referred."
  });
 
}
 
 
console.log(
  `✅ No duplicate found in referrals table for ${normalizedCustomerPhone}`
);
 
 
 
// ===============================
// Check employee_referrals table
// ===============================
 
console.log(
  `🔍 Checking employee_referrals table for phone: ${normalizedCustomerPhone}`
);
 
 
const { data: employeeReferrals, error: employeeCheckError } =
  await supabase
    .from("employee_referrals")
    .select("id, customer_phone");
 
 
if (employeeCheckError) {
 
  console.error(
    "❌ Employee referrals table check error:",
    employeeCheckError.message
  );
 
  return res.status(500).json({
    error: "Unable to verify employee referral."
  });
 
}
 
 
const employeeDuplicate = employeeReferrals.find(
  (record) =>
    normalizeKenyanPhone(record.customer_phone) === normalizedCustomerPhone
);
 
 
if (employeeDuplicate) {
 
  console.log("❌ DUPLICATE FOUND IN employee_referrals TABLE");
  console.log({
    existingId: employeeDuplicate.id,
    existingPhone: employeeDuplicate.customer_phone,
    checkedPhone: normalizedCustomerPhone
  });
 
 
  return res.status(409).json({
    error: "Sorry, Customer has already been referred."
  });
 
}
 
 
console.log(
  `✅ No duplicate found in employee_referrals table for ${normalizedCustomerPhone}`
);
 
    const { data, error } = await supabase
      .from("employee_referrals")
      .insert({
  referrer_name: refName.trim(),
  referrer_id: refId.trim(),
  referrer_phone: normalizedReferrerPhone,
  customer_name: custName.trim(),
  customer_phone: normalizedCustomerPhone,
 
  department: department.trim(),
 
referral_code:
    referralCode && referralCode.trim()
      ? referralCode.trim()
      : null,
  referee_consent: refereeConsent,
  privacy_consent: privacyConsent,
 
  user_consent: userConsent,
  data_processing_consent: dataProcessingConsent,
 
  status: "New",
})
      .select();
 
    console.log("📦 INSERT RESULT:", data);
    console.log("❌ INSERT ERROR:", error);
 
    if (error) {
      console.error("❌ Supabase error:", error.message);
 
      return res.status(502).json({
        error: "Could not save referral. Please try again.",
      });
    }
 
    return res.status(200).json({
      success: true,
      message: "Referral saved.",
    });
  } catch (err) {
    console.error("❌ Server error:", err);
 
    return res.status(500).json({
      error: "Server error. Please try again.",
    });
  }
});
 
/* ── Health check ────────────────────────────────── */
 
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});
 
/* ── Start server ────────────────────────────────── */
 
app.listen(PORT, () => {
  console.log(`🚀 Spiro Referral API → http://localhost:${PORT}`);
  console.log(`📊 Supabase project → ${process.env.SUPABASE_URL}`);
 
  startKeepAlive();
});
>>>>>>> e7853a0e6693bbc1b389fbf3494bb85c6797826a
