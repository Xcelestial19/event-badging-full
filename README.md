# Event Badging System (Production Build)

**Stack:** Node.js + Express + Tailwind (CDN) + better-sqlite3 + bwip-js + QuaggaJS

## Features
- Registration (Name, Email, Company, Mobile?, Designation?, Role)
- Gap-fill numeric IDs (IDs reused after deletion)
- Barcode (Code128) auto-generated
- Camera scan & USB scan
- Printed (blue) & Checked-in (green) status
- Admin panel: search, filter, inline edit, delete, print
- CSV import (pre-reg) & CSV export
- Print Designer (layout, show/hide fields, X/Y, font, barcode size, QR)
- Layout saved to `print-layout.json`
- ENV-configurable admin password
- Persistent storage via `DATA_DIR` (works on Render disk)

## Quick Start (Local)

```bash
cp .env.sample .env   # edit ADMIN_PASSWORD if you want
npm install
npm start
```

Open: http://localhost:3000

Admin: http://localhost:3000/admin?p=YOUR_PASSWORD

## CSV Import
Upload CSV in admin panel. Expected headers:
```
name,email,company,mobile,designation,role
```
Role values: Delegate | Faculty | Organiser

## Production / Render

1. Push this project to GitHub.
2. Create a **Render Web Service**.
3. Add a **Persistent Disk** (1GB is plenty) mounted at `/data`.
4. Environment Variables:
   - `ADMIN_PASSWORD=yourStrongPassword`
   - `DATA_DIR=/data`
   - `NODE_VERSION=20` (or 22)
5. Build Command: `npm install`
6. Start Command: `npm start`

### Backups
Use:
```
npm run db:backup
```
Creates timestamped DB copy in `DATA_DIR`.

---

Good luck with your event! Reach out if you want PDF bulk print, badge templates per role, or integration with QR instead of barcode.
