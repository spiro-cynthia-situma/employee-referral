# Spiro Referral Apps — Error Code Registry

Every error response from the API follows the Apple App Store Connect envelope:

```json
{
  "errors": [
    {
      "status": "409",
      "code": "REFERRAL_DUPLICATE",
      "title": "Already referred",
      "detail": "This customer has already been referred.",
      "ref": "0303",
      "source": { "field": "custPhone" }
    }
  ]
}
```

`errors` is always an array. Most responses carry one entry; validation failures carry one entry per failed field.

## Fields

| Field          | Meaning                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | The HTTP status of the response, as a string. Mirrors the status line for clients that lose it (logging pipelines, proxies).                                                                 |
| `code`         | `SCREAMING_SNAKE_CASE` machine identifier. **This is the contract the frontend keys off.** Never rename a code.                                                                              |
| `title`        | Short label. Sentence case, no trailing period.                                                                                                                                              |
| `detail`       | Full user-facing sentence following the copy rules below. May be reworded freely.                                                                                                            |
| `ref`          | Stable 4-digit registry sub-code (`LLNN`), carried over from the previous numbering. **The contract for logs and support.** Never renumber or reuse; add new refs at the end of their layer. |
| `source.field` | Present when the error maps to a single form field (the payload key, e.g. `custPhone`). The frontend uses it to place the message on the right input.                                        |

**`ref` layers:** `01` request guards, `02` validation, `03` business rules, `04` database, `09` catch-all. The four-digit ref is unique across the whole registry and **shared with the sibling app** — the same ref means the same thing in both.

## Public codes vs refs

Several refs intentionally share one public `code`: the client's behaviour is identical for each member of the group, and exposing the finer distinction (which table, which layer of the stack) would leak backend structure for no client benefit. The `ref` preserves the distinction for logs and support.

| Public `code`           | Refs it covers                                                                |
| ----------------------- | ----------------------------------------------------------------------------- |
| `REFERRAL_DUPLICATE`    | `0302` (matched in `referrals`), `0303` (matched in `employee_referrals`)     |
| `REFERRAL_CHECK_FAILED` | `0401` (`referrals` query failed), `0402` (`employee_referrals` query failed) |
| `INTERNAL_ERROR`        | `0901` (unhandled route error), `0902` (unhandled middleware error)           |

## Registry

| Ref    | HTTP | Code                     | Layer         | Detail (user copy)                                                                                                      | Emitted by                 |
| ------ | ---- | ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `0101` | 403  | `ACCESS_RESTRICTED_PATH` | Request guard | You don't have permission to access this resource.                                                                      | both apps                  |
| `0102` | 429  | `RATE_LIMIT_EXCEEDED`    | Request guard | You've reached the submission limit. Try again in 15 minutes.                                                           | both apps                  |
| `0103` | 403  | `ORIGIN_NOT_ALLOWED`     | Request guard | Requests from this origin aren't allowed.                                                                               | both apps                  |
| `0104` | 400  | `REQUEST_BODY_MALFORMED` | Request guard | The request couldn't be read. Check that the body is valid JSON.                                                        | both apps                  |
| `0201` | 400  | `VALIDATION_FAILED`      | Validation    | Per-field message from the schema; fallback: Some of the information entered isn't valid. Check the form and try again. | both apps                  |
| `0202` | 400  | `REFERRAL_CODE_REQUIRED` | Validation    | A referral code is required for Customer Service referrals.                                                             | **employee-referral only** |
| `0301` | 400  | `REFERRAL_SELF`          | Business rule | You can't refer yourself. Enter the customer's own phone number.                                                        | both apps                  |
| `0302` | 409  | `REFERRAL_DUPLICATE`     | Business rule | This customer has already been referred.                                                                                | both apps                  |
| `0303` | 409  | `REFERRAL_DUPLICATE`     | Business rule | This customer has already been referred.                                                                                | both apps                  |
| `0401` | 500  | `REFERRAL_CHECK_FAILED`  | Database      | We couldn't verify this referral right now. Try again in a few minutes.                                                 | both apps                  |
| `0402` | 500  | `REFERRAL_CHECK_FAILED`  | Database      | We couldn't verify this referral right now. Try again in a few minutes.                                                 | both apps                  |
| `0403` | 502  | `REFERRAL_SAVE_FAILED`   | Database      | Your referral couldn't be saved. Try again in a few minutes.                                                            | both apps                  |
| `0901` | 500  | `INTERNAL_ERROR`         | Catch-all     | Something went wrong on our end. Try again in a few minutes.                                                            | both apps                  |
| `0902` | 500  | `INTERNAL_ERROR`         | Catch-all     | Something went wrong on our end. Try again in a few minutes.                                                            | both apps                  |

Server logs prefix the ref in brackets — e.g. `❌ [0401] Duplicate check error` — so a support ticket quoting a ref can be grepped directly.

## Ref details

### 0101 — Restricted path (`ACCESS_RESTRICTED_PATH`)

**Cause:** the request path contains `.env`, `.git`, or `.DS_Store`.
**Action:** none — these are probe requests; safe to ignore in logs unless frequent.

### 0102 — Rate limit exceeded (`RATE_LIMIT_EXCEEDED`)

**Cause:** more than 10 `POST /api/referral` requests from one IP within 15 minutes.
**Action:** wait for the window to reset. If legitimate users hit this (e.g. shared office IP), raise `max` in the limiter config in `server.js`. Requires `app.set("trust proxy", 1)` on Render, otherwise every visitor shares the proxy's IP and one bucket.

### 0103 — Origin not allowed (`ORIGIN_NOT_ALLOWED`)

**Cause:** a cross-origin request whose `Origin` header doesn't match `RENDER_EXTERNAL_URL` (production) or `http://localhost:<PORT>` (local).
**Action:** if this fires for the real site, `RENDER_EXTERNAL_URL` is misconfigured (check for trailing slash or wrong scheme).

### 0104 — Malformed request body (`REQUEST_BODY_MALFORMED`)

**Cause:** `Content-Type: application/json` with a body that fails to parse.
**Action:** client-side bug or hand-crafted request; the form never sends this.

### 0201 — Schema validation failed (`VALIDATION_FAILED`)

**Cause:** the body failed the Zod `ReferralSchema`. The response contains one error object per failed field; each carries the schema message in `detail` and the field name in `source.field`. Both apps now use this same shape (previously `fields` in the customer app, `issues` here).
**Action:** fix the listed fields. Via the form this should be unreachable — client validation mirrors the schema.

### 0202 — Referral code required (`REFERRAL_CODE_REQUIRED`)

**Cause:** `department` is `customer_service` and `referralCode` is empty. Reserved in the customer app so the registries stay aligned.
**Action:** provide the referral code. `source.field` is `referralCode`.

### 0301 — Self-referral (`REFERRAL_SELF`)

**Cause:** referrer and customer phone numbers are identical after normalization (`+254`/`254`/`0` prefixes stripped).
**Action:** enter the customer's own number. `source.field` is `custPhone`.

### 0302 — Customer already referred, `referrals` table (`REFERRAL_DUPLICATE`)

**Cause:** the customer's phone matches an existing row in the customer app's `referrals` table (normalized or legacy format).
**Action:** expected duplicate rejection — no action. High volume may indicate users retrying with the same customer.

### 0303 — Customer already referred, `employee_referrals` table (`REFERRAL_DUPLICATE`)

**Cause:** same as 0302 but matched in the employee referral app's table.
**Action:** as above.

### 0401 — Duplicate check failed, `referrals` table (`REFERRAL_CHECK_FAILED`)

**Cause:** the Supabase query against `referrals` returned an error (connectivity, permissions, schema drift).
**Action:** check server logs (`❌ [0401] Duplicate check error`) and Supabase status. Retryable.

### 0402 — Duplicate check failed, `employee_referrals` table (`REFERRAL_CHECK_FAILED`)

**Cause:** the Supabase query against `employee_referrals` returned an error.
**Action:** check server logs (`❌ [0402] Employee referral check error`) and Supabase status. Retryable.

### 0403 — Insert failed (`REFERRAL_SAVE_FAILED`)

**Cause:** the Supabase insert (into `referrals` in the customer app, `employee_referrals` here) returned an error after all checks passed.
**Action:** check server logs (`❌ [0403] Supabase insert error`) — usually a constraint violation or Supabase outage. Retryable.

### 0901 — Unhandled route error (`INTERNAL_ERROR`)

**Cause:** an exception thrown inside the `/api/referral` handler that no specific branch caught.
**Action:** check server logs (`❌ [0901] Server error`) — this is always a bug or infrastructure failure worth investigating.

### 0902 — Unhandled middleware error (`INTERNAL_ERROR`)

**Cause:** an error reached the final Express error handler and wasn't a known CORS or JSON-parse failure.
**Action:** check server logs (`❌ [0902] Unhandled middleware error`).

## Adding a new code

1. Pick the layer prefix (`01`–`04`, `09`) and the next unused `NN` **across both apps** for the `ref`.
2. Pick a `SCREAMING_SNAKE_CASE` public `code`. Reuse an existing public code only if the client's correct behaviour is genuinely identical to the existing group; otherwise mint a new one.
3. Add the entry to the `ERRORS` map in `server.js` and respond via `sendError()` (or `buildError()` for multi-error responses).
4. Add it to this file **in both repos** with a Cause/Action entry, and note it in the collapsing table if it shares a public code.

**Copy rules** — `title`: short label, sentence case, no trailing period. `detail`: sentence case ending in a period; say what happened and what to do next; no "Sorry", no exclamation marks, no internal jargon (table names, "Zod", "Supabase"); blame the situation, not the user; give a concrete retry hint for transient failures.

## Migration from the numeric format

The previous `<HTTP status>.<LLNN>` codes map 1:1 onto refs — old `409.0303` is now `code: "REFERRAL_DUPLICATE", ref: "0303"`. The old flat body `{ "error": "...", "code": "409.0303" }` is replaced entirely by the `errors` array envelope; frontends must read `errors[0].detail` (or route by `code`/`source.field`) instead of `error`. Frontend and backend for each app ship from the same repo and deploy together, so the envelope switch is safe per-app as long as both files land in one deploy.
