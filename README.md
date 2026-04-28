# RAMPAL LIMITED

Full-stack wholesale building materials website for RAMPAL LIMITED, based at 14 Featherstone Road, Southall, England UB2 5AA.

Included:

- SEO-optimized public website for timber, sheet materials, cement, aggregates, and trade building supplies
- quote request form backed by the Node API
- Postgres quote request storage on Render, with SQLite fallback for local testing
- password-protected admin dashboard at `/rampal-admin`
- CSV export for quote requests
- `robots.txt`, `sitemap.xml`, Open Graph tags, and structured data

## Local Run

```bash
npm run check
npm start
```

Open:

- `http://localhost:3000`
- `http://localhost:3000/rampal-admin`

Set `ADMIN_PASSWORD` before going live. Without it, the app uses the starter password in `server.js`.

The local `.env` file is used for the admin password and notification email. Do not upload `.env` to GitHub or Render.

## Environment

```env
ADMIN_PASSWORD=your-strong-admin-password
NOTIFY_EMAIL=quotes@example.com
RESEND_API_KEY=your-resend-api-key
RESEND_FROM=RAMPAL LIMITED <quotes@yourdomain.com>
CLIENT_AUTO_REPLY_ENABLED=false
DATABASE_URL=postgres://...
PORT=3000
```

SMTP variables are also supported if you prefer SMTP for local email testing:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=quotes@yourdomain.com
```

## Deploy On Render

This project includes `render.yaml` for Docker deployment. Create a Render Blueprint or Web Service from the repository, then set the environment variables above.

For production quote storage, create a Render Postgres database and add its internal connection string to the web service as `DATABASE_URL`. If `DATABASE_URL` is missing, the app falls back to local SQLite at `data/rampal-quote-requests.db`, which is useful on your laptop but should not be used for live customer enquiries.

After deployment, submit:

```text
https://rampallimited.com/sitemap.xml
```

If the final live domain is different, update the canonical URL, Open Graph URLs, sitemap, and `robots.txt`.

## CLI Commands

```bash
cd /Users/tanyakumari/rampal-limited
npm run check
npm start
```

Optional Render CLI flow:

```bash
brew install render
render login
render blueprint launch
```

You can also deploy from the Render website without the CLI by connecting a GitHub repository.
