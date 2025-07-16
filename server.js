/**
 * Event Badging System - Production Build
 * ---------------------------------------
 * Tailwind UI (CDN)
 * DB: better-sqlite3
 * Features:
 *  - Registration (Name, Email, Company, Mobile?, Designation?, Role: Delegate|Faculty|Organiser)
 *  - Manual gap-fill numeric IDs
 *  - Barcode generation (Code128, uuid-based)
 *  - Camera scan (QuaggaJS) + USB scan
 *  - Status color coding: Printed (blue), Checked-In (green)
 *  - Admin Panel: search, role filter, inline edit, delete, print
 *  - CSV Import (pre-reg) + Export (incl status)
 *  - Print Designer: show/hide, X/Y, font, barcode size, optional QR
 *  - Layout persisted to print-layout.json
 *  - ENV-configurable admin password + data dir
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const multer = require('multer');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const bwipjs = require('bwip-js');
const { createObjectCsvWriter } = require('csv-writer');
const Database = require('better-sqlite3');
require('dotenv').config();

// --- Config ---
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'attendees.db');
const LAYOUT_PATH = path.join(__dirname, 'print-layout.json');

// static
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// uploads temp
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// --- DB Init ---
const db = new Database(DB_PATH);

// Table: manual ID (no AUTOINCREMENT) so we can gap-fill
db.exec(`
CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY,
  name TEXT,
  email TEXT,
  company TEXT,
  mobile TEXT,
  designation TEXT,
  role TEXT DEFAULT 'Delegate',
  barcode TEXT,
  printed INTEGER DEFAULT 0,
  checked_in INTEGER DEFAULT 0
);
`);

// ----- Layout load/save -----
function defaultLayout() {
  return {
    card: { width: 336, height: 210, unit: 'px', background: '#ffffff', border: true },
    fields: {
      name:{enabled:true,x:20,y:20,fontSize:20,bold:true},
      email:{enabled:true,x:20,y:50,fontSize:14,bold:false},
      company:{enabled:true,x:20,y:72,fontSize:14,bold:false},
      mobile:{enabled:true,x:20,y:94,fontSize:14,bold:false},
      designation:{enabled:true,x:20,y:116,fontSize:14,bold:false},
      role:{enabled:true,x:20,y:138,fontSize:14,bold:false},
      id:{enabled:false,x:20,y:160,fontSize:12,bold:false},
      barcode:{enabled:true,x:230,y:60,width:90,height:45,scale:1.0},
      qrcode:{enabled:false,x:230,y:120,size:70}
    }
  };
}
function loadLayout() {
  try {
    return JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
  } catch {
    return defaultLayout();
  }
}
function saveLayout(obj) {
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

// ----- Helpers -----
function getNextId() {
  const rows = db.prepare('SELECT id FROM attendees ORDER BY id').all();
  let newId = 1;
  for (let i=0;i<rows.length;i++){
    if (rows[i].id !== i+1) return i+1;
  }
  return rows.length + 1;
}
function eHtml(str){ if(str==null) return ''; return String(str)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;'); }
function eAttr(str){ if(str==null) return ''; return String(str).replace(/"/g,'&quot;'); }
function eJs(str){ if(str==null) return ''; return String(str).replace(/'/g,"\\'").replace(/"/g,'\\"'); }

// ----- Routes -----
// Home -> static index.html (includes registration form)
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// Register -> create attendee -> redirect to print
app.post('/register', (req,res)=>{
  const { name, email, company, mobile, designation, role } = req.body;
  if (!name || !email) return res.status(400).send('Name & Email required.');
  const id = getNextId();
  const barcode = uuidv4();
  db.prepare(`INSERT INTO attendees (id,name,email,company,mobile,designation,role,barcode) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id,name,email,company,mobile||'',designation||'',role||'Delegate',barcode);
  res.redirect(`/print?id=${id}`);
});

// Admin Panel
app.get('/admin', (req,res)=>{
  // password gate (query OR Authorization Basic - simple)
  const p = req.query.p;
  if (p !== undefined && p !== ADMIN_PASSWORD) {
    return res.status(403).send('Forbidden');
  }
  if (p === undefined && ADMIN_PASSWORD) {
    // show login form
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script></head>
      <body class="h-screen flex items-center justify-center bg-gray-100">
      <form method="GET" class="bg-white p-6 rounded shadow w-80 space-y-3">
        <h2 class="text-xl font-bold mb-2">Admin Login</h2>
        <input type="password" name="p" placeholder="Password" class="w-full border px-3 py-2 rounded" />
        <button class="w-full bg-blue-600 text-white py-2 rounded">Login</button>
      </form></body></html>`);
  }

  const search = req.query.search ? req.query.search.trim() : '';
  const filterRole = req.query.role || '';
  const where = [];
  const params = {};
  if (search) {
    where.push("(name LIKE @s OR email LIKE @s OR company LIKE @s OR mobile LIKE @s OR designation LIKE @s)");
    params.s = `%${search}%`;
  }
  if (filterRole) {
    where.push("role = @r");
    params.r = filterRole;
  }
  let sql = "SELECT * FROM attendees";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY id";
  const rows = db.prepare(sql).all(params);

  const tableRows = rows.map(r=>{
    const rowColor = r.checked_in ? 'bg-green-100' : (r.printed ? 'bg-blue-100' : '');
    return `
<tr class="${rowColor}">
  <td class="px-2 py-1">
    <form method="POST" action="/update" class="inline-flex flex-wrap gap-2 items-center">
      <input name="id" value="${r.id}" readonly class="w-14 bg-gray-200 px-1 py-0.5 text-xs text-center rounded" />
      <input name="name" value="${eAttr(r.name)}" class="w-32 border px-1 py-0.5 text-xs rounded" />
      <input name="email" value="${eAttr(r.email)}" class="w-48 border px-1 py-0.5 text-xs rounded" />
      <input name="company" value="${eAttr(r.company)}" class="w-32 border px-1 py-0.5 text-xs rounded" />
      <input name="mobile" value="${eAttr(r.mobile||'')}" class="w-28 border px-1 py-0.5 text-xs rounded" />
      <input name="designation" value="${eAttr(r.designation||'')}" class="w-32 border px-1 py-0.5 text-xs rounded" />
      <select name="role" class="border px-1 py-0.5 text-xs rounded">
        <option value="Delegate" ${r.role==='Delegate'?'selected':''}>Delegate</option>
        <option value="Faculty" ${r.role==='Faculty'?'selected':''}>Faculty</option>
        <option value="Organiser" ${r.role==='Organiser'?'selected':''}>Organiser</option>
      </select>
      <input name="barcode" value="${eAttr(r.barcode)}" readonly class="w-40 bg-gray-200 px-1 py-0.5 text-xs rounded" />
      <input type="hidden" name="p" value="${eAttr(p)}" />
      <button title="Save" class="text-green-600 px-1">💾</button>
    </form>
    <a href="/print?id=${r.id}" target="_blank" title="Print" class="text-blue-600 px-1">🖨️</a>
    <form method="POST" action="/delete" class="inline" onsubmit="return confirm('Delete ${eJs(r.name)}?')">
      <input type="hidden" name="id" value="${r.id}" />
      <input type="hidden" name="p" value="${eAttr(p)}" />
      <button title="Delete" class="text-red-600 px-1">🗑️</button>
    </form>
  </td>
</tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Admin Panel</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="bg-gray-100 p-6">
  <div class="max-w-full mx-auto bg-white p-6 rounded shadow">
    <h1 class="text-2xl font-bold mb-4">Admin Panel</h1>

    <div class="flex flex-wrap gap-4 mb-4 items-center text-sm">
      <a href="/print-designer" target="_blank" class="text-purple-600 underline">🖌 Print Designer</a>
      <a href="/camera-scan" target="_blank" class="text-green-600 underline">📷 Camera Scan</a>
      <a href="/scan" target="_blank" class="text-indigo-600 underline">⌨ USB Scan</a>
      <a href="/" class="text-blue-600 underline">🏠 Home</a>
      <a href="/export-csv" class="text-teal-600 underline">⬇ Export CSV</a>
    </div>

    <form method="GET" action="/admin" class="flex flex-wrap gap-2 mb-4 text-sm">
      <input type="hidden" name="p" value="${eAttr(p)}" />
      <input name="search" placeholder="Search..." value="${eAttr(search)}" class="border px-2 py-1 rounded" />
      <select name="role" class="border px-2 py-1 rounded">
        <option value="" ${filterRole===''?'selected':''}>All Roles</option>
        <option value="Delegate" ${filterRole==='Delegate'?'selected':''}>Delegates</option>
        <option value="Faculty" ${filterRole==='Faculty'?'selected':''}>Faculty</option>
        <option value="Organiser" ${filterRole==='Organiser'?'selected':''}>Organisers</option>
      </select>
      <button class="bg-blue-600 text-white px-3 py-1 rounded">Search/Filter</button>
      <a href="/admin?p=${eAttr(p)}" class="underline text-gray-600 px-2 py-1">Reset</a>
    </form>

    <form action="/upload-csv" method="POST" enctype="multipart/form-data" class="flex gap-2 mb-6 text-sm items-center">
      <input type="file" name="csvfile" accept=".csv" required class="text-sm" />
      <button class="bg-green-600 text-white px-3 py-1 rounded">📤 Upload CSV</button>
    </form>

    <div class="text-xs mb-2 space-x-2">
      <span class="px-2 py-1 rounded bg-blue-100">Printed</span>
      <span class="px-2 py-1 rounded bg-green-100">Checked-In</span>
      <span class="px-2 py-1 rounded bg-gray-100 border">Pending</span>
    </div>

    <div class="overflow-x-auto">
      <table class="min-w-full text-left text-xs sm:text-sm">
        <tbody>
          ${tableRows || '<tr><td class="p-4 text-center text-gray-500">No attendees.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`);
});

// Update attendee
app.post('/update', (req,res)=>{
  const { id, name, email, company, mobile, designation, role, p } = req.body;
  db.prepare(`UPDATE attendees SET name=?,email=?,company=?,mobile=?,designation=?,role=? WHERE id=?`)
    .run(name,email,company,mobile||'',designation||'',role||'Delegate',id);
  res.redirect(`/admin?p=${encodeURIComponent(p)}`);
});

// Delete attendee
app.post('/delete',(req,res)=>{
  const { id, p } = req.body;
  db.prepare(`DELETE FROM attendees WHERE id=?`).run(id);
  res.redirect(`/admin?p=${encodeURIComponent(p)}`);
});

// USB scan page
app.get('/scan',(req,res)=>{
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-100 p-6">
  <div class="max-w-sm mx-auto bg-white p-6 rounded shadow text-center space-y-3">
    <h2 class="text-xl font-bold mb-2">USB Barcode Scan</h2>
    <form method="POST" action="/verify" class="space-y-2">
      <input name="barcode" autofocus autocomplete="off" placeholder="Scan barcode here" class="w-full border px-3 py-2 rounded" />
      <button class="w-full bg-blue-600 text-white py-2 rounded">Verify</button>
    </form>
    <a href="/" class="text-blue-600 underline text-sm">Back Home</a>
  </div>
</body></html>`);
});

// USB verify
app.post('/verify',(req,res)=>{
  const { barcode } = req.body;
  const row = db.prepare('SELECT * FROM attendees WHERE barcode=?').get(barcode);
  if (!row) return res.send('❌ Not found. <a href="/scan">Scan again</a>');
  db.prepare('UPDATE attendees SET checked_in=1 WHERE id=?').run(row.id);
  res.send(`<h2>✅ Verified</h2><p>Name: ${eHtml(row.name)}</p><p>Role: ${eHtml(row.role)}</p><a href="/scan">Scan another</a>`);
});

// Camera scan
app.get('/camera-scan',(req,res)=>{
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/quagga/dist/quagga.min.js"></script></head>
<body class="bg-gray-100 p-6 text-center">
  <h2 class="text-2xl font-bold mb-4">Camera Scan</h2>
  <div id="interactive" class="mx-auto w-full max-w-md aspect-video bg-black"></div>
  <div id="result" class="mt-4 text-lg">Waiting...</div>
  <script>
    Quagga.init({
      inputStream:{
        name:"Live",
        type:"LiveStream",
        target:document.querySelector('#interactive'),
        constraints:{facingMode:"environment"}
      },
      decoder:{readers:["code_128_reader"]}
    },function(err){
      if(err){console.error(err);document.getElementById('result').innerText='Camera error';return;}
      Quagga.start();
    });
    Quagga.onDetected(function(data){
      const code=data.codeResult.code;
      document.getElementById('result').innerText='Scanned: '+code;
      Quagga.stop();
      setTimeout(()=>{window.location='/verify-camera?barcode='+encodeURIComponent(code);},500);
    });
  </script>
  <a href="/" class="text-blue-600 underline text-sm">Back Home</a>
</body></html>`);
});

// verify-camera
app.get('/verify-camera',(req,res)=>{
  const { barcode } = req.query;
  const row = db.prepare('SELECT * FROM attendees WHERE barcode=?').get(barcode);
  if (!row) return res.send('❌ Not found. <a href="/camera-scan">Scan again</a>');
  db.prepare('UPDATE attendees SET checked_in=1 WHERE id=?').run(row.id);
  res.send(`<h2>✅ Verified</h2><p>Name: ${eHtml(row.name)}</p><p>Role: ${eHtml(row.role)}</p><a href="/camera-scan">Scan another</a>`);
});

// barcode-img
app.get('/barcode-img', async (req,res)=>{
  const text = req.query.data || 'EMPTY';
  const scale = Number(req.query.s) || 1;
  try {
    const png = await bwipjs.toBuffer({
      bcid:'code128',
      text,
      scale: Math.max(1, Math.floor(scale*3)),
      height: 10,
      includetext:false
    });
    res.set('Content-Type','image/png');
    res.send(png);
  } catch(e) {
    res.status(500).send('Barcode error');
  }
});

// Print badge
app.get('/print',(req,res)=>{
  const id = req.query.id;
  const layout = loadLayout();
  const row = db.prepare('SELECT * FROM attendees WHERE id=?').get(id);
  if (!row) return res.send('Attendee not found.');
  db.prepare('UPDATE attendees SET printed=1 WHERE id=?').run(id);

  function fieldHTML(val,cfg){
    if(!cfg.enabled) return '';
    const fw = cfg.bold ? 'bold':'normal';
    return `<div style="position:absolute;left:${cfg.x}px;top:${cfg.y}px;font-size:${cfg.fontSize}px;font-weight:${fw};">${eHtml(val)}</div>`;
  }
  const b = layout.fields.barcode;
  const barcodeHTML = b.enabled ? `<img src="/barcode-img?data=${encodeURIComponent(row.barcode)}&w=${b.width}&h=${b.height}&s=${b.scale}" style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;">` : '';
  const q = layout.fields.qrcode;
  const qrHTML = q.enabled ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=${q.size}x${q.size}&data=${encodeURIComponent(row.barcode)}" style="position:absolute;left:${q.x}px;top:${q.y}px;width:${q.size}px;height:${q.size}px;">` : '';

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Print Badge: ${eHtml(row.name)}</title>
<style>
@media print {
 body *{visibility:hidden}
 .badge-print, .badge-print *{visibility:visible}
 .badge-print{position:absolute;top:0;left:0}
 .print-btn{display:none!important}
}
body{background:#f1f1f1;margin:0;padding:40px;font-family:sans-serif}
.badge-print{
 position:relative;
 width:${layout.card.width}px;
 height:${layout.card.height}px;
 background:${layout.card.background};
 ${layout.card.border?'border:1px solid #000;':''}
 box-shadow:0 0 8px rgba(0,0,0,.2);
 margin:auto;
}
</style></head>
<body>
<button class="print-btn" onclick="window.print()">🖨️ Print</button>
<a class="print-btn" href="/admin?p=${ADMIN_PASSWORD}">← Back</a>
<div class="badge-print">
 ${fieldHTML(row.name, layout.fields.name)}
 ${fieldHTML(row.email, layout.fields.email)}
 ${fieldHTML(row.company, layout.fields.company)}
 ${fieldHTML(row.mobile || '—', layout.fields.mobile)}
 ${fieldHTML(row.designation || '—', layout.fields.designation)}
 ${fieldHTML(row.role || '—', layout.fields.role)}
 ${fieldHTML('ID: '+row.id, layout.fields.id)}
 ${barcodeHTML}
 ${qrHTML}
</div>
</body></html>`);
});

// Print designer
app.get('/print-designer',(req,res)=>{
  const layout = loadLayout();
  const previewId = req.query.id ? Number(req.query.id) : null;
  let attendee;
  if (previewId) attendee = db.prepare('SELECT * FROM attendees WHERE id=?').get(previewId);
  renderDesigner(res, layout, attendee);
});

app.post('/save-layout',(req,res)=>{
  try {
    saveLayout(req.body);
    res.send('OK');
  } catch(e) {
    console.error('layout save error', e);
    res.status(500).send('ERR');
  }
});

function renderDesigner(res, layout, attendee) {
  const layoutJson = JSON.stringify(layout);
  const attendeeJson = JSON.stringify(attendee || {
    id:0,
    name:'Sample Name',
    email:'sample@example.com',
    company:'Sample Co',
    mobile:'9999999999',
    designation:'Guest',
    role:'Delegate',
    barcode:'SAMPLE123'
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Print Designer</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/css/app.css">
<style>
  .badge-preview{position:relative;overflow:hidden}
  .badge-preview .badge-field{position:absolute;white-space:nowrap}
</style>
</head>
<body class="bg-gray-100 p-4">
  <div class="grid md:grid-cols-2 gap-6">
    <div>
      <h1 class="text-xl font-bold mb-2">Print Designer</h1>
      <p class="text-sm mb-4">Adjust layout. Save to apply for future prints.</p>
      <form id="layoutForm" class="space-y-4 text-sm">
        <div class="border rounded p-3">
          <h2 class="font-semibold mb-2">Card</h2>
          <div class="grid grid-cols-2 gap-2">
            <label class="block">Width(px)<input type="number" name="card.width" value="${layout.card.width}" class="w-full border px-2 py-1 rounded"/></label>
            <label class="block">Height(px)<input type="number" name="card.height" value="${layout.card.height}" class="w-full border px-2 py-1 rounded"/></label>
            <label class="block col-span-2">Background<input type="color" name="card.background" value="${layout.card.background}" class="w-full h-8 border rounded"/></label>
            <label class="inline-flex items-center gap-2 col-span-2"><input type="checkbox" name="card.border" ${layout.card.border?'checked':''}/> Show Border</label>
          </div>
        </div>

        ${fieldControl('name','Name',layout.fields.name)}
        ${fieldControl('email','Email',layout.fields.email)}
        ${fieldControl('company','Company',layout.fields.company)}
        ${fieldControl('mobile','Mobile',layout.fields.mobile)}
        ${fieldControl('designation','Designation',layout.fields.designation)}
        ${fieldControl('role','Role',layout.fields.role)}
        ${fieldControl('id','ID',layout.fields.id)}
        ${barcodeControl('barcode','Barcode',layout.fields.barcode)}
        ${qrControl('qrcode','QR Code',layout.fields.qrcode)}

        <button type="button" id="saveBtn" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">Save Layout</button>
        <span id="saveStatus" class="text-green-600 text-xs hidden">Saved!</span>
      </form>

      <hr class="my-4">
      <form method="GET" action="/print-designer" class="flex items-center gap-2 text-sm">
        <label>Preview ID:<input type="number" name="id" class="border px-2 py-1 rounded w-24"/></label>
        <button class="bg-gray-600 text-white px-3 py-1 rounded">Load</button>
      </form>
      <div class="mt-4 text-sm">
        <a href="/admin?p=${ADMIN_PASSWORD}" class="text-blue-600 underline">Back to Admin</a>
      </div>
    </div>

    <div>
      <h2 class="font-semibold mb-2">Live Preview</h2>
      <div id="badgePreview" class="badge-preview border bg-white mx-auto" style="width:${layout.card.width}px;height:${layout.card.height}px;"></div>
    </div>
  </div>

<script>
const layoutData = ${layoutJson};
const attendeeData = ${attendeeJson};

function getVal(form, path, def){
  const el = form.querySelector('[name="'+path+'"]');
  if(!el) return def;
  if(el.type === 'checkbox') return el.checked;
  if(el.type === 'number') return Number(el.value);
  return el.value;
}
function fieldFromForm(f,key,def){
  return {
    enabled:getVal(f,key+'.enabled',def.enabled),
    x:getVal(f,key+'.x',def.x),
    y:getVal(f,key+'.y',def.y),
    fontSize:getVal(f,key+'.fontSize',def.fontSize),
    bold:getVal(f,key+'.bold',def.bold)
  };
}
function barcodeFromForm(f,key,def){
  return {
    enabled:getVal(f,key+'.enabled',def.enabled),
    x:getVal(f,key+'.x',def.x),
    y:getVal(f,key+'.y',def.y),
    width:getVal(f,key+'.width',def.width),
    height:getVal(f,key+'.height',def.height),
    scale:getVal(f,key+'.scale',def.scale)
  };
}
function qrFromForm(f,key,def){
  return {
    enabled:getVal(f,key+'.enabled',def.enabled),
    x:getVal(f,key+'.x',def.x),
    y:getVal(f,key+'.y',def.y),
    size:getVal(f,key+'.size',def.size)
  };
}
function buildLayoutFromForm(){
  const f=document.getElementById('layoutForm');
  return {
    card:{
      width:getVal(f,'card.width',layoutData.card.width),
      height:getVal(f,'card.height',layoutData.card.height),
      unit:'px',
      background:getVal(f,'card.background',layoutData.card.background),
      border:getVal(f,'card.border',layoutData.card.border)
    },
    fields:{
      name:fieldFromForm(f,'name',layoutData.fields.name),
      email:fieldFromForm(f,'email',layoutData.fields.email),
      company:fieldFromForm(f,'company',layoutData.fields.company),
      mobile:fieldFromForm(f,'mobile',layoutData.fields.mobile),
      designation:fieldFromForm(f,'designation',layoutData.fields.designation),
      role:fieldFromForm(f,'role',layoutData.fields.role),
      id:fieldFromForm(f,'id',layoutData.fields.id),
      barcode:barcodeFromForm(f,'barcode',layoutData.fields.barcode),
      qrcode:qrFromForm(f,'qrcode',layoutData.fields.qrcode)
    }
  };
}
function renderPreview(){
  const layout = buildLayoutFromForm();
  const a = attendeeData;
  const badge = document.getElementById('badgePreview');
  badge.innerHTML='';
  badge.style.width = layout.card.width + 'px';
  badge.style.height = layout.card.height + 'px';
  badge.style.background = layout.card.background;
  badge.style.border = layout.card.border ? '1px solid #000' : 'none';
  if(layout.fields.name.enabled) addText(badge,a.name,'name',layout.fields.name);
  if(layout.fields.email.enabled) addText(badge,a.email,'email',layout.fields.email);
  if(layout.fields.company.enabled) addText(badge,a.company,'company',layout.fields.company);
  if(layout.fields.mobile.enabled) addText(badge,a.mobile||'—','mobile',layout.fields.mobile);
  if(layout.fields.designation.enabled) addText(badge,a.designation||'—','designation',layout.fields.designation);
  if(layout.fields.role.enabled) addText(badge,a.role||'—','role',layout.fields.role);
  if(layout.fields.id.enabled) addText(badge,'ID: '+a.id,'id',layout.fields.id);
  if(layout.fields.barcode.enabled) addBarcode(badge,a.barcode,layout.fields.barcode);
  if(layout.fields.qrcode.enabled) addQR(badge,a.barcode,layout.fields.qrcode);
}
function addText(parent,txt,key,opts){
  const el=document.createElement('div');
  el.className='badge-field';
  el.style.left=opts.x+'px';
  el.style.top=opts.y+'px';
  el.style.fontSize=opts.fontSize+'px';
  el.style.fontWeight=opts.bold?'bold':'normal';
  el.textContent=txt;
  parent.appendChild(el);
}
function addBarcode(parent,data,opts){
  const img=document.createElement('img');
  img.src='/barcode-img?data='+encodeURIComponent(data)+'&w='+opts.width+'&h='+opts.height+'&s='+opts.scale;
  img.alt='Barcode';
  img.style.position='absolute';
  img.style.left=opts.x+'px';
  img.style.top=opts.y+'px';
  img.style.width=opts.width+'px';
  img.style.height=opts.height+'px';
  parent.appendChild(img);
}
function addQR(parent,data,opts){
  const img=document.createElement('img');
  img.src='https://api.qrserver.com/v1/create-qr-code/?size='+opts.size+'x'+opts.size+'&data='+encodeURIComponent(data);
  img.alt='QR';
  img.style.position='absolute';
  img.style.left=opts.x+'px';
  img.style.top=opts.y+'px';
  img.style.width=opts.size+'px';
  img.style.height=opts.size+'px';
  parent.appendChild(img);
}
document.getElementById('layoutForm').addEventListener('input',renderPreview);
document.getElementById('saveBtn').addEventListener('click',()=>{
  const layout = buildLayoutFromForm();
  fetch('/save-layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(layout)})
    .then(r=>r.ok?r.text():Promise.reject())
    .then(()=>{
      document.getElementById('saveStatus').classList.remove('hidden');
      setTimeout(()=>document.getElementById('saveStatus').classList.add('hidden'),1500);
    })
    .catch(()=>alert('Save failed'));
});
renderPreview();
</script>
</body>
</html>`);
}

// field controls for designer
function fieldControl(key,label,o){
  return `
  <div class="border rounded p-3">
    <h3 class="font-semibold mb-2">${label}</h3>
    <div class="grid grid-cols-2 gap-2">
      <label class="inline-flex items-center gap-2 col-span-2"><input type="checkbox" name="${key}.enabled" ${o.enabled?'checked':''}/> Show</label>
      <label class="block">X<input type="number" name="${key}.x" value="${o.x}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block">Y<input type="number" name="${key}.y" value="${o.y}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block col-span-2">Font(px)<input type="number" name="${key}.fontSize" value="${o.fontSize}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="inline-flex items-center gap-2 col-span-2"><input type="checkbox" name="${key}.bold" ${o.bold?'checked':''}/> Bold</label>
    </div>
  </div>`;
}
function barcodeControl(key,label,o){
  return `
  <div class="border rounded p-3">
    <h3 class="font-semibold mb-2">${label}</h3>
    <div class="grid grid-cols-2 gap-2">
      <label class="inline-flex items-center gap-2 col-span-2"><input type="checkbox" name="${key}.enabled" ${o.enabled?'checked':''}/> Show</label>
      <label class="block">X<input type="number" name="${key}.x" value="${o.x}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block">Y<input type="number" name="${key}.y" value="${o.y}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block">Width<input type="number" name="${key}.width" value="${o.width}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block">Height<input type="number" name="${key}.height" value="${o.height}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block col-span-2">Scale<input type="number" step="0.1" name="${key}.scale" value="${o.scale}" class="w-full border px-2 py-1 rounded"/></label>
    </div>
  </div>`;
}
function qrControl(key,label,o){
  return `
  <div class="border rounded p-3">
    <h3 class="font-semibold mb-2">${label}</h3>
    <div class="grid grid-cols-2 gap-2">
      <label class="inline-flex items-center gap-2 col-span-2"><input type="checkbox" name="${key}.enabled" ${o.enabled?'checked':''}/> Show</label>
      <label class="block">X<input type="number" name="${key}.x" value="${o.x}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block">Y<input type="number" name="${key}.y" value="${o.y}" class="w-full border px-2 py-1 rounded"/></label>
      <label class="block col-span-2">Size(px)<input type="number" name="${key}.size" value="${o.size}" class="w-full border px-2 py-1 rounded"/></label>
    </div>
  </div>`;
}

// CSV Upload (pre-registered)
app.post('/upload-csv', upload.single('csvfile'), (req,res)=>{
  const filePath = req.file.path;
  const rows = [];
  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', d => rows.push(d))
    .on('end', ()=>{
      for (const r of rows) {
        const id = getNextId();
        const barcode = uuidv4();
        db.prepare(`INSERT INTO attendees (id,name,email,company,mobile,designation,role,barcode) VALUES (?,?,?,?,?,?,?,?)`)
          .run(
            id,
            r.name || '',
            r.email || '',
            r.company || '',
            r.mobile || '',
            r.designation || '',
            r.role || 'Delegate',
            barcode
          );
      }
      fs.unlinkSync(filePath);
      res.redirect(`/admin?p=${ADMIN_PASSWORD}`);
    });
});

// CSV Export
app.get('/export-csv',(req,res)=>{
  const file = path.join(__dirname, 'attendees_export.csv');
  const rows = db.prepare('SELECT * FROM attendees ORDER BY id').all();
  const writer = createObjectCsvWriter({
    path: file,
    header: [
      {id:'id',title:'ID'},
      {id:'name',title:'Name'},
      {id:'email',title:'Email'},
      {id:'company',title:'Company'},
      {id:'mobile',title:'Mobile'},
      {id:'designation',title:'Designation'},
      {id:'role',title:'Role'},
      {id:'barcode',title:'Barcode'},
      {id:'printed',title:'Printed'},
      {id:'checked_in',title:'Checked-In'}
    ]
  });
  writer.writeRecords(rows).then(()=>{
    res.download(file, 'attendees_export.csv', err=>{
      if(!err) fs.unlink(file,()=>{});
    });
  });
});

// Start
app.listen(PORT,()=>{
  console.log(`✅ Event Badging server running at http://localhost:${PORT}`);
  console.log(`DB path: ${DB_PATH}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
