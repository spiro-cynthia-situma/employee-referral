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
    `\n⚠️ Missing environment variables:\n   ${missingEnv.join("\n   ")}`,
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
  },
);

/* ── Validation schema ───────────────────────────── */

const fullName = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).filter(Boolean).length >= 2, {
    message: "Please enter first and last name",
  });

const kenyanId = z
  .string()
  .trim()
  .regex(/^\d{7,10}$/, {
    message: "Invalid ID number",
  });

const kenyanPhone = z
  .string()
  .trim()
  .regex(/^(?:\+254|0)[17]\d{8}$/, {
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

/* ── Error registry ──────────────────────────────── */
// Full catalogue with Cause/Action notes: ERROR_CODES.md.
// `ref` is the stable 4-digit registry sub-code shared with the customer
// app — never renumber or reuse one. `code` is the frontend contract.

const ERRORS = {
  "0101": {
    status: 403,
    code: "ACCESS_RESTRICTED_PATH",
    title: "Access restricted",
    detail: "You don't have permission to access this resource.",
  },
  "0102": {
    status: 429,
    code: "RATE_LIMIT_EXCEEDED",
    title: "Too many submissions",
    detail: "You've reached the submission limit. Try again in 15 minutes.",
  },
  "0103": {
    status: 403,
    code: "ORIGIN_NOT_ALLOWED",
    title: "Origin not allowed",
    detail: "Requests from this origin aren't allowed.",
  },
  "0104": {
    status: 400,
    code: "REQUEST_BODY_MALFORMED",
    title: "Request couldn't be read",
    detail: "The request couldn't be read. Check that the body is valid JSON.",
  },
  "0201": {
    status: 400,
    code: "VALIDATION_FAILED",
    title: "Check the highlighted fields",
    detail:
      "Some of the information entered isn't valid. Check the form and try again.",
  },
  "0202": {
    status: 400,
    code: "REFERRAL_CODE_REQUIRED",
    title: "Referral code required",
    detail: "A referral code is required for Customer Service referrals.",
  },
  "0301": {
    status: 400,
    code: "REFERRAL_SELF",
    title: "Self-referral not accepted",
    detail: "You can't refer yourself. Enter the customer's own phone number.",
  },
  "0302": {
    status: 409,
    code: "REFERRAL_DUPLICATE",
    title: "Already referred",
    detail: "This customer has already been referred.",
  },
  "0303": {
    status: 409,
    code: "REFERRAL_DUPLICATE",
    title: "Already referred",
    detail: "This customer has already been referred.",
  },
  "0401": {
    status: 500,
    code: "REFERRAL_CHECK_FAILED",
    title: "Couldn't verify referral",
    detail:
      "We couldn't verify this referral right now. Try again in a few minutes.",
  },
  "0402": {
    status: 500,
    code: "REFERRAL_CHECK_FAILED",
    title: "Couldn't verify referral",
    detail:
      "We couldn't verify this referral right now. Try again in a few minutes.",
  },
  "0403": {
    status: 502,
    code: "REFERRAL_SAVE_FAILED",
    title: "Referral not saved",
    detail: "Your referral couldn't be saved. Try again in a few minutes.",
  },
  "0901": {
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Something went wrong",
    detail: "Something went wrong on our end. Try again in a few minutes.",
  },
  "0902": {
    status: 500,
    code: "INTERNAL_ERROR",
    title: "Something went wrong",
    detail: "Something went wrong on our end. Try again in a few minutes.",
  },
};

function buildError(ref, overrides = {}) {
  const def = ERRORS[ref];

  return {
    status: String(def.status),
    code: def.code,
    title: def.title,
    detail: def.detail,
    ref,
    ...overrides,
  };
}

function sendError(res, ref, overrides = {}) {
  return res
    .status(ERRORS[ref].status)
    .json({ errors: [buildError(ref, overrides)] });
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
  }),
);

/* ── Middleware ──────────────────────────────────── */

app.use(express.json());

app.use((req, res, next) => {
  if (/(\.env|\.git|\.DS_Store)/i.test(req.path)) {
    return sendError(res, "0101");
  }

  next();
});

app.use(express.static(path.join(__dirname)));

const referralLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { errors: [buildError("0102")] },
});

/* ── POST /api/referral ──────────────────────────── */

app.post("/api/referral", referralLimiter, async (req, res) => {
  console.log("📥 Incoming request body:", req.body);

  const parsed = ReferralSchema.safeParse(req.body);

  if (!parsed.success) {
    console.log(
      "❌ [0201] ZOD ISSUES:",
      JSON.stringify(parsed.error.issues, null, 2),
    );

    const errors = parsed.error.issues.map((issue) => {
      const field = issue.path[0];

      return buildError("0201", {
        detail: issue.message || ERRORS["0201"].detail,
        ...(field ? { source: { field: String(field) } } : {}),
      });
    });

    return res.status(400).json({ errors });
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
    return sendError(res, "0202", { source: { field: "referralCode" } });
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

      return sendError(res, "0301", { source: { field: "custPhone" } });
    }

    // ===============================
    // Check referrals table
    // ===============================

    console.log(
      `🔍 Checking referrals table for phone: ${normalizedCustomerPhone}`,
    );

    const { data: referrals, error: referralCheckError } = await supabase
      .from("referrals")
      .select("id, customer_phone");

    if (referralCheckError) {
      console.error(
        "❌ [0401] Duplicate check error:",
        referralCheckError.message,
      );

      return sendError(res, "0401");
    }

    const referralDuplicate = referrals.find(
      (record) =>
        normalizeKenyanPhone(record.customer_phone) === normalizedCustomerPhone,
    );

    if (referralDuplicate) {
      console.log("❌ DUPLICATE FOUND IN referrals TABLE");
      console.log({
        existingId: referralDuplicate.id,
        existingPhone: referralDuplicate.customer_phone,
        checkedPhone: normalizedCustomerPhone,
      });

      return sendError(res, "0302", { source: { field: "custPhone" } });
    }

    console.log(
      `✅ No duplicate found in referrals table for ${normalizedCustomerPhone}`,
    );

    // ===============================
    // Check employee_referrals table
    // ===============================

    console.log(
      `🔍 Checking employee_referrals table for phone: ${normalizedCustomerPhone}`,
    );

    const { data: employeeReferrals, error: employeeCheckError } =
      await supabase.from("employee_referrals").select("id, customer_phone");

    if (employeeCheckError) {
      console.error(
        "❌ [0402] Employee referrals table check error:",
        employeeCheckError.message,
      );

      return sendError(res, "0402");
    }

    const employeeDuplicate = employeeReferrals.find(
      (record) =>
        normalizeKenyanPhone(record.customer_phone) === normalizedCustomerPhone,
    );

    if (employeeDuplicate) {
      console.log("❌ DUPLICATE FOUND IN employee_referrals TABLE");
      console.log({
        existingId: employeeDuplicate.id,
        existingPhone: employeeDuplicate.customer_phone,
        checkedPhone: normalizedCustomerPhone,
      });

      return sendError(res, "0303", { source: { field: "custPhone" } });
    }

    console.log(
      `✅ No duplicate found in employee_referrals table for ${normalizedCustomerPhone}`,
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
          referralCode && referralCode.trim() ? referralCode.trim() : null,
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
      console.error("❌ [0403] Supabase insert error:", error.message);

      return sendError(res, "0403");
    }

    return res.status(200).json({
      success: true,
      message: "Referral saved.",
    });
  } catch (err) {
    console.error("❌ [0901] Server error:", err);

    return sendError(res, "0901");
  }
});

/* ── Health check ────────────────────────────────── */

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});

/* ── Middleware error handler ────────────────────── */

app.use((err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.message === "Not allowed by CORS") {
    return sendError(res, "0103");
  }

  if (err.type === "entity.parse.failed") {
    return sendError(res, "0104");
  }

  console.error("❌ [0902] Unhandled middleware error:", err);

  return sendError(res, "0902");
});

/* ── Start server ────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`🚀 Spiro Referral API → http://localhost:${PORT}`);
  console.log(`📊 Supabase project → ${process.env.SUPABASE_URL}`);

  startKeepAlive();
});
