// Simple DB backup script
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || __dirname + '/../data';
const DB_PATH = path.join(DATA_DIR, 'attendees.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('No DB file found at', DB_PATH);
  process.exit(1);
}
const ts = new Date().toISOString().replace(/[:.]/g,'-');
const out = path.join(DATA_DIR, `attendees-backup-${ts}.db`);
fs.copyFileSync(DB_PATH, out);
console.log('Backed up DB to', out);
