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
  let cleaned = phone.trim().replace(/\s+/g, "");

  // Remove +254
  if (cleaned.startsWith("+254")) {
    cleaned = cleaned.substring(4);
  }

  // Remove 254
  else if (cleaned.startsWith("254")) {
    cleaned = cleaned.substring(3);
  }

  // Remove leading 0
  else if (cleaned.startsWith("0")) {
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

const normalizedCustomerPhone = normalizeKenyanPhone(custPhone);
const normalizedReferrerPhone = normalizeKenyanPhone(refPhone);

console.log("Checking customer phone:", normalizedCustomerPhone);

// Self referral check
if (normalizedCustomerPhone === normalizedReferrerPhone) {
  return res.status(400).json({
    error: "Self referral is not accepted."
  });
}

// ===============================
// Check referrals table first
// ===============================

// ===============================
// Phone variants for all formats
// ===============================

const phoneVariants = [
  normalizedCustomerPhone,
  `0${normalizedCustomerPhone}`,
  `254${normalizedCustomerPhone}`,
  `+254${normalizedCustomerPhone}`,
];


// ===============================
// Check referrals table
// Prevent customer who already has a normal referral
// ===============================

const { data: existingReferralCustomer, error: referralCheckError } =
  await supabase
    .from("referrals")
    .select("id")
    .in("customer_phone", phoneVariants)
    .limit(1);


if (referralCheckError) {
  console.error(
    "❌ Referral table check error:",
    referralCheckError.message
  );

  return res.status(500).json({
    error: "Unable to verify customer."
  });
}


console.log("Existing referral customer:", existingReferralCustomer);


if (existingReferralCustomer && existingReferralCustomer.length > 0) {
  return res.status(409).json({
    error: "Sorry, Customer has already been referred."
  });
}


// ===============================
// Check employee_referrals table
// Prevent duplicate employee referrals
// ===============================

const { data: existingEmployeeReferral, error: employeeCheckError } =
  await supabase
    .from("employee_referrals")
    .select("id")
    .in("customer_phone", phoneVariants)
    .limit(1);


if (employeeCheckError) {
  console.error(
    "❌ Employee referral check error:",
    employeeCheckError.message
  );

  return res.status(500).json({
    error: "Unable to verify employee referral."
  });
}


console.log("Existing employee referral:", existingEmployeeReferral);


if (existingEmployeeReferral && existingEmployeeReferral.length > 0) {
  return res.status(409).json({
    error: "Sorry, Customer has already been referred."
  });
}

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