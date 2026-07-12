# Spiro Employee Referral

A web-based employee referral form for Spiro. Employees refer prospective customers and earn a KSh 1,500 cash reward (sent via M-Pesa) once the referred customer successfully joins Spiro. The app is a single-page frontend served by a Node.js/Express backend that validates submissions and stores them in Supabase.

## Features

- Responsive referral form UI with a cash reward banner (2X Earn Program)
- Server-side validation with Zod:
  - Full names must include first and last name
  - Kenyan national ID format (7–10 digits)
  - Kenyan phone number format (`+254` or `0`, followed by `7`/`1` and 8 digits)
  - Referral code is optional, but **required when the department is Customer Service**
  - Four consent checkboxes: referee, privacy, user, and data processing consent
- Supabase integration — referrals are inserted into the `employee_referrals` table with status `New`
- Rate limiting on submissions (10 requests per 15 minutes per IP)
- CORS locked to the deployed origin (`RENDER_EXTERNAL_URL`) or `http://localhost:<PORT>` locally
- Blocks requests for sensitive paths (`.env`, `.git`, `.DS_Store`)
- Health check endpoint plus a keep-alive ping (production only) to prevent Render free-tier spin-down

## Tech Stack

- Frontend: HTML, CSS, JavaScript (single `index.html`, served statically by Express)
- Backend: Node.js (18+), Express
- Validation: Zod
- Database: Supabase (`@supabase/supabase-js`)
- Deployment: Render
- Tooling: nodemon (dev), Prettier (formatting)

## Project Structure

- `index.html` — frontend referral form and reward banner
- `server.js` — Express server, validation schema, and API routes
- `keepAlive.js` — pings `/api/health` every 10 minutes in production to keep the Render instance awake
- `package.json` — scripts and dependencies
- `render.yaml` — Render deployment configuration

## Prerequisites

- Node.js 18 or newer
- npm
- A Supabase project with an `employee_referrals` table

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root:

```env
PORT=3000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
RENDER_EXTERNAL_URL=https://your-app.onrender.com
```

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required — the server exits on startup if either is missing. `PORT` defaults to 3000. `RENDER_EXTERNAL_URL` is only needed in production (CORS origin and keep-alive pings).

## Running Locally

Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The app is served at `http://localhost:3000`.

Format the codebase with Prettier:

```bash
npm run format        # write changes
npm run format:check  # check only
```

## API Endpoints

### `GET /api/health`

Returns `{ "status": "ok" }`. Used for monitoring and keep-alive pings.

### `POST /api/referral`

Submits a referral. Rate limited to 10 requests per 15 minutes per IP.

Request body:

| Field                   | Type    | Notes                                              |
| ----------------------- | ------- | -------------------------------------------------- |
| `refName`               | string  | Referrer's full name (first and last)              |
| `refId`                 | string  | Referrer's Kenyan ID number (7–10 digits)          |
| `refPhone`              | string  | Referrer's Kenyan phone number                     |
| `custName`              | string  | Customer's full name (first and last)              |
| `custPhone`             | string  | Customer's Kenyan phone number                     |
| `department`            | string  | Referrer's department                              |
| `referralCode`          | string? | Optional; required if department is `customer_service` |
| `refereeConsent`        | boolean | Referee consent                                    |
| `privacyConsent`        | boolean | Privacy policy consent                             |
| `userConsent`           | boolean | User consent                                       |
| `dataProcessingConsent` | boolean | Data processing consent                            |

Responses:

- `200` — `{ "success": true, "message": "Referral saved." }`
- `400` — validation failure (includes Zod `issues`) or missing referral code for Customer Service
- `429` — rate limit exceeded
- `502` — Supabase insert failed
- `500` — unexpected server error

## Supabase Notes

The backend inserts into a table named `employee_referrals` with these columns:

- `referrer_name`
- `referrer_id`
- `referrer_phone`
- `customer_name`
- `customer_phone`
- `department`
- `referral_code` (nullable)
- `referee_consent`
- `privacy_consent`
- `user_consent`
- `data_processing_consent`
- `status` (set to `New` on insert)

The server uses the Supabase **service role key**, so keep it server-side only and never expose it to the frontend.

## Deployment

The project deploys to Render using `render.yaml` (web service, `npm install` build, `node server.js` start). Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `RENDER_EXTERNAL_URL` in the Render dashboard; `NODE_ENV=production` is set by the config. In production, the keep-alive helper pings the health endpoint every 10 minutes to prevent the free-tier instance from spinning down.
