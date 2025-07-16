const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const bwipjs = require('bwip-js');
const { createObjectCsvWriter } = require('csv-writer');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });


const DB_PATH = path.join(__dirname, 'attendees.db');
const db = new sqlite3.Database(DB_PATH);


db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS attendees (
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
  )`);
});


const LAYOUT_PATH = path.join(__dirname, 'print-layout.json');
function defaultLayout() {
  return {
    card: { width: 336, height: 210, unit: 'px', background: '#ffffff', border: true },
    fields: {
      name:{enabled:true,x:20,y:20,fontSize:20,bold:true},
      email:{enabled:true,x:20,y:55,fontSize:14,bold:false},
      company:{enabled:true,x:20,y:75,fontSize:14,bold:false},
      mobile:{enabled:true,x:20,y:95,fontSize:14,bold:false},
      designation:{enabled:true,x:20,y:115,fontSize:14,bold:false},
      role:{enabled:true,x:20,y:135,fontSize:14,bold:false},
      id:{enabled:false,x:20,y:155,fontSize:12,bold:false},
      barcode:{enabled:true,x:220,y:60,width:100,height:50,scale:1.0},
      qrcode:{enabled:false,x:220,y:120,size:80}
    }
  };
}
function loadLayout() {
  try {
    const raw = fs.readFileSync(LAYOUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Layout load failed, using defaults.', e.message);
    return defaultLayout();
  }
}
function saveLayout(layout) {
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2), 'utf8');
}


function getNextId(cb) {
  db.all(`SELECT id FROM attendees ORDER BY id`, (err, rows) => {
    if (err) return cb(err);
    let newId = 1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].id !== i + 1) {
        newId = i + 1;
        return cb(null, newId);
      }
    }
    newId = rows.length + 1;
    cb(null, newId);
  });
}


app.get('/', (req, res) => {
  res.send(`
    <html>
    <head>
      <title>Event Registration</title>
      <link rel="stylesheet" href="/style.css">
      <style>
        body{font-family:sans-serif;padding:20px;background:#f8f9fa;}
        form{max-width:420px;margin:auto;background:#fff;padding:20px;border:1px solid #ddd;border-radius:6px;}
        input,select{width:100%;margin-bottom:10px;padding:8px;border:1px solid #ccc;border-radius:4px;}
        button{padding:10px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer;width:100%;}
        button:hover{background:#0056b3;}
        .links{text-align:center;margin-top:15px;}
        .links a{margin:0 10px;}
      </style>
    </head>
    <body>
      <h2 style="text-align:center;">Register Attendee</h2>
      <form action="/register" method="POST">
        <input name="name" placeholder="Full Name" required>
        <input name="email" type="email" placeholder="Email" required>
        <input name="company" placeholder="Company" required>
        <input name="mobile" placeholder="Mobile (optional)">
        <input name="designation" placeholder="Designation (optional)">
        <select name="role" required>
          <option value="Delegate">Delegate</option>
          <option value="Faculty">Faculty</option>
          <option value="Organiser">Organiser</option>
        </select>
        <button type="submit">Register & Generate Badge</button>
      </form>
      <div class="links">
        <a href="/admin?p=${ADMIN_PASSWORD}">Admin Panel</a> | 
        <a href="/camera-scan">Camera Scan</a> | 
        <a href="/scan">USB Scan</a>
      </div>
    </body>
    </html>
  `);
});


app.post('/register', (req, res) => {
  const { name, email, company, mobile, designation, role } = req.body;
  const barcode = uuidv4();
  getNextId((err, newId) => {
    if (err) return res.send('ID allocation error.');
    db.run(
      `INSERT INTO attendees (id, name, email, company, mobile, designation, role, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, name, email, company, mobile || '', designation || '', role || 'Delegate', barcode],
      (insErr) => {
        if (insErr) return res.send('DB insert error.');
        res.redirect(`/print?id=${newId}`); // go straight to print page
      }
    );
  });
});

// --- ADMIN PANEL ---
app.get('/admin', (req, res) => {
  const password = req.query.p;
  if (password !== ADMIN_PASSWORD) {
    return res.send(`
      <form method="GET" style="max-width:300px;margin:100px auto;font-family:sans-serif;">
        <h3>Admin Login</h3>
        <input type="password" name="p" placeholder="Password" style="width:100%;margin-bottom:10px;padding:8px;">
        <button type="submit" style="width:100%;padding:8px;">Login</button>
      </form>
    `);
  }

  const search = req.query.search ? req.query.search.trim() : '';
  const filterRole = req.query.role || '';
  const params = [];
  let whereClauses = [];

  if (search) {
    whereClauses.push(`(name LIKE ? OR email LIKE ? OR company LIKE ? OR mobile LIKE ? OR designation LIKE ?)`);
    for (let i=0;i<5;i++) params.push(`%${search}%`);
  }
  if (filterRole) {
    whereClauses.push(`role = ?`);
    params.push(filterRole);
  }

  let query = 'SELECT * FROM attendees';
  if (whereClauses.length) query += ' WHERE ' + whereClauses.join(' AND ');
  query += ' ORDER BY id';

  db.all(query, params, (err, rows) => {
    if (err) return res.send('❌ Error loading data.');

    const tableRows = rows.map(r => `
      <tr style="background:${r.checked_in ? '#d4edda' : (r.printed ? '#d1ecf1' : '#ffffff')};">
        <form method="POST" action="/update" class="inline">
          <td><input name="id" value="${r.id}" readonly style="width:40px;background:#eee;"></td>
          <td><input name="name" value="${escapeHtml(r.name)}" style="width:100%;"></td>
          <td><input name="email" value="${escapeHtml(r.email)}" style="width:100%;"></td>
          <td><input name="company" value="${escapeHtml(r.company)}" style="width:100%;"></td>
          <td><input name="mobile" value="${escapeHtml(r.mobile || '')}" style="width:100%;"></td>
          <td><input name="designation" value="${escapeHtml(r.designation || '')}" style="width:100%;"></td>
          <td>
            <select name="role">
              <option value="Delegate" ${r.role==='Delegate'?'selected':''}>Delegate</option>
              <option value="Faculty" ${r.role==='Faculty'?'selected':''}>Faculty</option>
              <option value="Organiser" ${r.role==='Organiser'?'selected':''}>Organiser</option>
            </select>
          </td>
          <td><input name="barcode" value="${escapeHtml(r.barcode)}" readonly style="width:100%;background:#eee;"></td>
          <td class="table-actions">
            <input type="hidden" name="p" value="${password}">
            <button type="submit" title="Save">💾</button>
            <a href="/print?id=${r.id}" target="_blank" title="Print">🖨️</a>
          </td>
        </form>
        <td>
          <form method="POST" action="/delete" class="inline" onsubmit="return confirm('Delete ${escapeJs(r.name)}?');">
            <input type="hidden" name="id" value="${r.id}">
            <input type="hidden" name="p" value="${password}">
            <button type="submit" title="Delete">🗑️</button>
          </form>
        </td>
      </tr>
    `).join('');

    res.send(`
      <html>
      <head>
        <title>Admin Panel</title>
        <link rel="stylesheet" href="/style.css">
        <style>
          body{font-family:sans-serif;padding:20px;background:#f8f9fa;}
          table{width:100%;border-collapse:collapse;margin-top:20px;font-size:14px;}
          th,td{border:1px solid #ccc;padding:4px;vertical-align:middle;}
          th{background:#e9ecef;}
          .status-legend span{padding:2px 6px;border-radius:4px;font-size:12px;margin-right:6px;}
          .printed{background:#d1ecf1;}
          .checkedin{background:#d4edda;}
          .pending{background:#f8f9fa;border:1px solid #ccc;}
          input,select{font-size:13px;}
        </style>
      </head>
      <body>
        <h2>Admin Panel</h2>
        <div class="status-legend">
          <span class="printed">Printed</span>
          <span class="checkedin">Checked-In</span>
          <span class="pending">Pending</span>
        </div>

        <div style="margin-top:10px;">
          <a href="/print-designer" target="_blank">🖌 Print Designer</a> |
          <a href="/camera-scan" target="_blank">📷 Camera Scan</a> |
          <a href="/scan" target="_blank">⌨ USB Scan</a> |
          <a href="/" target="_blank">🏠 Home</a>
        </div>

        <form method="GET" action="/admin" style="margin-top:10px;">
          <input type="hidden" name="p" value="${password}">
          <input name="search" placeholder="Search..." value="${escapeHtml(search)}" style="width:200px;">
          <select name="role">
            <option value="" ${filterRole===''?'selected':''}>All Roles</option>
            <option value="Delegate" ${filterRole==='Delegate'?'selected':''}>Delegates</option>
            <option value="Faculty" ${filterRole==='Faculty'?'selected':''}>Faculty</option>
            <option value="Organiser" ${filterRole==='Organiser'?'selected':''}>Organisers</option>
          </select>
          <button type="submit">Search/Filter</button>
          <a href="/admin?p=${password}">Reset</a>
        </form>

        <form action="/upload-csv" method="POST" enctype="multipart/form-data" style="margin-top:10px;">
          <input type="file" name="csvfile" accept=".csv" required>
          <button type="submit">📤 Upload CSV</button>
        </form>

        <a href="/export-csv">⬇ Export CSV</a>

        <table>
          <thead>
            <tr>
              <th>ID</th><th>Name</th><th>Email</th><th>Company</th><th>Mobile</th><th>Designation</th><th>Role</th><th>Barcode</th><th colspan="2">Actions</th>
            </tr>
          </thead>
          <tbody>${tableRows || '<tr><td colspan="10">No attendees.</td></tr>'}</tbody>
        </table>
      </body>
      </html>
    `);
  });
});


function escapeHtml(str) {
  if (!str && str!==0) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function escapeJs(str) {
  if (!str && str!==0) return '';
  return String(str).replace(/'/g,"\\'").replace(/"/g,'\\"');
}


app.post('/update', (req, res) => {
  const { id, name, email, company, mobile, designation, role, p } = req.body;
  db.run(
    `UPDATE attendees SET name=?, email=?, company=?, mobile=?, designation=?, role=? WHERE id=?`,
    [name, email, company, mobile || '', designation || '', role || 'Delegate', id],
    (err) => {
      if (err) return res.send('❌ Update failed.');
      res.redirect(`/admin?p=${p}`);
    }
  );
});


app.post('/delete', (req, res) => {
  const { id, p } = req.body;
  db.run('DELETE FROM attendees WHERE id = ?', [id], (err) => {
    if (err) return res.send('❌ Delete error.');
    res.redirect(`/admin?p=${p}`);
  });
});


app.get('/scan', (req, res) => {
  res.send(`
    <html>
    <head><title>USB Scanner</title></head>
    <body style="font-family:sans-serif;padding:20px;">
      <h3>USB Barcode Scan</h3>
      <form method="POST" action="/verify">
        <input name="barcode" autofocus autocomplete="off" placeholder="Scan barcode here" style="width:300px;padding:8px;">
        <button type="submit">Verify</button>
      </form>
      <p><a href="/">Home</a></p>
    </body>
    </html>
  `);
});

 
app.post('/verify', (req, res) => {
  const { barcode } = req.body;
  db.get('SELECT * FROM attendees WHERE barcode = ?', [barcode], (err, row) => {
    if (err || !row) return res.send('❌ Not found. <a href="/scan">Scan again</a>');
    db.run('UPDATE attendees SET checked_in = 1 WHERE id = ?', [row.id]);
    res.send(`
      <h2>✅ Verified</h2>
      <p>Name: ${escapeHtml(row.name)}</p>
      <p>Role: ${escapeHtml(row.role)}</p>
      <a href="/scan">Scan another</a>
    `);
  });
});

// (QuaggaJS)
app.get('/camera-scan', (req, res) => {
  res.send(`
    <html>
    <head>
      <title>Camera Scan</title>
      <script src="https://unpkg.com/quagga/dist/quagga.min.js"></script>
      <style>
        body{font-family:sans-serif;padding:20px;text-align:center;}
        #interactive{width:100%;max-width:480px;margin:auto;}
        #result{margin-top:10px;font-size:18px;}
      </style>
    </head>
    <body>
      <h3>Camera Barcode Scan</h3>
      <div id="interactive"></div>
      <div id="result">Waiting...</div>
      <script>
        Quagga.init({
          inputStream: {
            name: "Live",
            type: "LiveStream",
            target: document.querySelector('#interactive'),
            constraints: { facingMode: "environment" }
          },
          decoder: { readers: ["code_128_reader"] }
        }, function(err){
          if(err){console.error(err);document.getElementById('result').innerText='Camera error';return;}
          Quagga.start();
        });

        Quagga.onDetected(function(data){
          const code = data.codeResult.code;
          document.getElementById('result').innerText='Scanned: '+code;
          Quagga.stop();
          setTimeout(()=>{ window.location = '/verify-camera?barcode='+encodeURIComponent(code); }, 500);
        });
      </script>
      <p><a href="/">Home</a></p>
    </body>
    </html>
  `);
});


app.get('/verify-camera', (req, res) => {
  const barcode = req.query.barcode;
  db.get('SELECT * FROM attendees WHERE barcode = ?', [barcode], (err, row) => {
    if (err || !row) return res.send('❌ Not found. <a href="/camera-scan">Scan again</a>');
    db.run('UPDATE attendees SET checked_in = 1 WHERE id = ?', [row.id]);
    res.send(`
      <h2>✅ Verified</h2>
      <p>Name: ${escapeHtml(row.name)}</p>
      <p>Role: ${escapeHtml(row.role)}</p>
      <a href="/camera-scan">Scan another</a>
    `);
  });
});


app.get('/barcode-img', async (req, res) => {
  const text = req.query.data || 'EMPTY';
  const scale = Number(req.query.s) || 1;
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'code128',
      text,
      scale: Math.max(1, Math.floor(scale * 3)),
      height: 10,
      includetext: false
    });
    res.set('Content-Type','image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send('Barcode error');
  }
});


app.get('/print', (req, res) => {
  const id = req.query.id;
  const layout = loadLayout();
  db.get('SELECT * FROM attendees WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.send('Attendee not found.');
    
    db.run('UPDATE attendees SET printed = 1 WHERE id = ?', [id]);

    function fieldHTML(val, cfg){
      if(!cfg.enabled) return '';
      const fw = cfg.bold ? 'bold':'normal';
      return `<div style="position:absolute;left:${cfg.x}px;top:${cfg.y}px;font-size:${cfg.fontSize}px;font-weight:${fw};">${escapeHtml(val)}</div>`;
    }
    const b = layout.fields.barcode;
    const barcodeHTML = b.enabled ? `
      <img src="/barcode-img?data=${encodeURIComponent(row.barcode)}&w=${b.width}&h=${b.height}&s=${b.scale}"
           style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;">
    ` : '';
    const q = layout.fields.qrcode;
    const qrHTML = q.enabled ? `
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=${q.size}x${q.size}&data=${encodeURIComponent(row.barcode)}"
           style="position:absolute;left:${q.x}px;top:${q.y}px;width:${q.size}px;height:${q.size}px;">
    ` : '';

    res.send(`
      <html>
      <head>
        <title>Print Badge: ${escapeHtml(row.name)}</title>
        <style>
          @media print {
            body * { visibility:hidden; }
            .badge-print, .badge-print * { visibility:visible; }
            .badge-print { position:absolute; top:0; left:0; }
            .print-btn { display:none !important; }
          }
          body{background:#f1f1f1;margin:0;padding:40px;font-family:sans-serif;}
          .print-btn{margin-bottom:10px;}
          .badge-print{
            position:relative;
            width:${layout.card.width}px;
            height:${layout.card.height}px;
            background:${layout.card.background};
            ${layout.card.border?'border:1px solid #000;':''}
            box-shadow:0 0 8px rgba(0,0,0,.2);
            margin:auto;
          }
        </style>
      </head>
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
      </body>
      </html>
    `);
  });
});

// print configure
app.get('/print-designer', (req, res) => {
  const layout = loadLayout();
  const previewId = req.query.id ? Number(req.query.id) : null;
  if (previewId) {
    db.get('SELECT * FROM attendees WHERE id = ?', [previewId], (err, row) => {
      renderDesigner(res, layout, row);
    });
  } else {
    renderDesigner(res, layout, null);
  }
});

function renderDesigner(res, layout, attendee) {
  const layoutJson = JSON.stringify(layout);
  const attendeeJson = JSON.stringify(attendee || {
    id: 0,
    name: 'Sample Name',
    email: 'sample@example.com',
    company: 'Sample Co',
    mobile: '9999999999',
    designation: 'Guest',
    role: 'Delegate',
    barcode: 'SAMPLE123'
  });

  res.send(`
    <html>
    <head>
      <title>Print Designer</title>
      <meta charset="utf-8" />
      <style>
        body{font-family:sans-serif;margin:20px;display:flex;gap:40px;flex-wrap:wrap;}
        fieldset{margin-bottom:10px;padding:10px;}
        label{display:block;font-size:14px;margin-bottom:4px;}
        input[type="number"]{width:80px;}
        .preview-wrapper{flex:1;min-width:360px;}
        .form-wrapper{width:320px;max-width:100%;}
        .badge-preview{position:relative;margin-top:10px;background:#fdfdfd;border:1px solid #ccc;overflow:hidden;}
        .badge-field{position:absolute;white-space:nowrap;}
        .badge-field img{max-width:100%;max-height:100%;}
        #saveStatus{font-size:12px;color:green;display:none;}
        @media (max-width:600px){body{flex-direction:column;}}
      </style>
    </head>
    <body>
      <div class="form-wrapper">
        <h2>Print Designer</h2>
        <p>Show/hide fields, change positions, sizes, colors.</p>
        <form id="layoutForm">
          <fieldset>
            <legend>Card</legend>
            <label>Width(px): <input type="number" name="card.width" value="${layout.card.width}" /></label>
            <label>Height(px): <input type="number" name="card.height" value="${layout.card.height}" /></label>
            <label>Background: <input type="color" name="card.background" value="${layout.card.background}" /></label>
            <label><input type="checkbox" name="card.border" ${layout.card.border?'checked':''}/> Show Border</label>
          </fieldset>

          ${fieldControl('name','Name',layout.fields.name)}
          ${fieldControl('email','Email',layout.fields.email)}
          ${fieldControl('company','Company',layout.fields.company)}
          ${fieldControl('mobile','Mobile',layout.fields.mobile)}
          ${fieldControl('designation','Designation',layout.fields.designation)}
          ${fieldControl('role','Role',layout.fields.role)}
          ${fieldControl('id','ID',layout.fields.id)}
          ${barcodeControl('barcode','Barcode',layout.fields.barcode)}
          ${qrControl('qrcode','QR Code',layout.fields.qrcode)}

          <button type="button" id="saveBtn">💾 Save Layout</button>
          <div id="saveStatus">Saved!</div>
        </form>

        <hr/>
        <form method="GET" action="/print-designer">
          <label>Preview attendee ID: <input type="number" name="id" /></label>
          <button type="submit">Load Preview</button>
        </form>
      </div>

      <div class="preview-wrapper">
        <h3>Live Preview</h3>
        <div id="badgePreview" class="badge-preview"></div>
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
            enabled:getVal(f, key+'.enabled', def.enabled),
            x:getVal(f, key+'.x', def.x),
            y:getVal(f, key+'.y', def.y),
            fontSize:getVal(f, key+'.fontSize', def.fontSize),
            bold:getVal(f, key+'.bold', def.bold)
          };
        }
        function barcodeFromForm(f,key,def){
          return {
            enabled:getVal(f, key+'.enabled', def.enabled),
            x:getVal(f, key+'.x', def.x),
            y:getVal(f, key+'.y', def.y),
            width:getVal(f, key+'.width', def.width),
            height:getVal(f, key+'.height', def.height),
            scale:getVal(f, key+'.scale', def.scale)
          };
        }
        function qrFromForm(f,key,def){
          return {
            enabled:getVal(f, key+'.enabled', def.enabled),
            x:getVal(f, key+'.x', def.x),
            y:getVal(f, key+'.y', def.y),
            size:getVal(f, key+'.size', def.size)
          };
        }
        function buildLayoutFromForm(){
          const f = document.getElementById('layoutForm');
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
          if(layout.fields.mobile.enabled) addText(badge,a.mobile || '—','mobile',layout.fields.mobile);
          if(layout.fields.designation.enabled) addText(badge,a.designation || '—','designation',layout.fields.designation);
          if(layout.fields.role.enabled) addText(badge,a.role || '—','role',layout.fields.role);
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
          img.alt='QR Code';
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
          fetch('/save-layout',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(layout)
          }).then(r=>r.ok?r.text():Promise.reject()).then(()=>{
            const s=document.getElementById('saveStatus');
            s.style.display='block';
            setTimeout(()=>{s.style.display='none';},1500);
          }).catch(()=>alert('Save failed'));
        });

        renderPreview();
      </script>
    </body>
    </html>
  `);
}

// server side injection 
function fieldControl(key,label,o){
  return `
  <fieldset>
    <legend>${label}</legend>
    <label><input type="checkbox" name="${key}.enabled" ${o.enabled?'checked':''}/> Show</label>
    <label>X: <input type="number" name="${key}.x" value="${o.x}" /></label>
    <label>Y: <input type="number" name="${key}.y" value="${o.y}" /></label>
    <label>Font(px): <input type="number" name="${key}.fontSize" value="${o.fontSize}" /></label>
    <label><input type="checkbox" name="${key}.bold" ${o.bold?'checked':''}/> Bold</label>
  </fieldset>`;
}
function barcodeControl(key,label,o){
  return `
  <fieldset>
    <legend>${label}</legend>
    <label><input type="checkbox" name="${key}.enabled" ${o.enabled?'checked':''}/> Show</label>
    <label>X: <input type="number" name="${key}.x" value="${o.x}" /></label>
    <label>Y: <input type="number" name="${key}.y" value="${o.y}" /></label>
    <label>Width(px): <input type="number" name="${key}.width" value="${o.width}" /></label>
    <label>Height(px): <input type="number" name="${key}.height" value="${o.height}" /></label>
    <label>Scale: <input type="number" step="0.1" name="${key}.scale" value="${o.scale}" /></label>
  </fieldset>`;
}
function qrControl(key,label,o){
  return `
  <fieldset>
    <legend>${label}</legend>
    <label><input type="checkbox" name="${key}.enabled" ${o.enabled?'checked':''}/> Show</label>
    <label>X: <input type="number" name="${key}.x" value="${o.x}" /></label>
    <label>Y: <input type="number" name="${key}.y" value="${o.y}" /></label>
    <label>Size(px): <input type="number" name="${key}.size" value="${o.size}" /></label>
  </fieldset>`;
}

// layout save kar bc
app.post('/save-layout', (req, res) => {
  try {
    saveLayout(req.body);
    res.send('OK');
  } catch (e) {
    console.error('Layout save error:', e);
    res.status(500).send('ERR');
  }
});

// upload excel
app.post('/upload-csv', upload.single('csvfile'), (req, res) => {
  const filePath = req.file.path;
  const rows = [];
  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', d => rows.push(d))
    .on('end', () => {
    
      const insertNext = () => {
        const r = rows.shift();
        if (!r) {
          fs.unlinkSync(filePath);
          return res.redirect(`/admin?p=${ADMIN_PASSWORD}`);
        }
        getNextId((err, newId) => {
          if (err) return res.send('ID allocation error.');
          const barcode = uuidv4();
          db.run(
            `INSERT INTO attendees (id,name,email,company,mobile,designation,role,barcode) VALUES (?,?,?,?,?,?,?,?)`,
            [
              newId,
              r.name || '',
              r.email || '',
              r.company || '',
              r.mobile || '',
              r.designation || '',
              r.role || 'Delegate',
              barcode
            ],
            (insErr) => {
              if (insErr) console.error('Insert error:', insErr.message);
              insertNext();
            }
          );
        });
      };
      insertNext();
    });
});

// excel file download
app.get('/export-csv', (req, res) => {
  const file = path.join(__dirname, 'attendees_export.csv');
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
  db.all('SELECT * FROM attendees ORDER BY id', [], (err, rows) => {
    if (err) return res.send('Export error.');
    writer.writeRecords(rows).then(()=>{
      res.download(file, 'attendees_export.csv', (dlErr)=>{
        if (!dlErr) fs.unlink(file,()=>{});
      });
    });
  });
});

//server start karne ke liye
app.listen(PORT, () => {
  console.log(`✅ Event Badging server running at http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
