require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'messages.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const KEY_FILE = path.join(DATA_DIR, 'modkey.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');
if (!fs.existsSync(PENDING_FILE)) fs.writeFileSync(PENDING_FILE, '[]', 'utf8');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    cb(null, extOk && mimeOk);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.json());

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function readMessages() { return readJson(DB_FILE); }
function writeMessages(m) { writeJson(DB_FILE, m); }
function readPending() { return readJson(PENDING_FILE); }
function writePending(p) { writeJson(PENDING_FILE, p); }

function getModKey() {
  if (process.env.MODERATION_KEY) return process.env.MODERATION_KEY;
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  const key = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(KEY_FILE, key, 'utf8');
  return key;
}
const MOD_KEY = getModKey();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const SB_URL = process.env.SUPABASE_URL || null;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || null;
const USE_SB = !!(SB_URL && SB_KEY);

function sbHeaders(json) {
  const h = {
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function sbList() {
  const r = await fetch(`${SB_URL}/rest/v1/messages?select=id,author,content,image,created_at&order=created_at.desc`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`SB list ${r.status}`);
  return r.json();
}

async function sbInsert(msg) {
  const r = await fetch(`${SB_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: sbHeaders(true),
    body: JSON.stringify({ id: msg.id, author: msg.author, content: msg.content, image: msg.image, created_at: msg.createdAt })
  });
  if (!r.ok) throw new Error(`SB insert ${r.status}: ${await r.text()}`);
}

async function sbUploadImage(fileBuffer, mime, ext) {
  const name = uuidv4() + ext;
  const r = await fetch(`${SB_URL}/storage/v1/object/images/${name}`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': mime },
    body: fileBuffer
  });
  if (!r.ok) throw new Error(`SB upload ${r.status}: ${await r.text()}`);
  return `${SB_URL}/storage/v1/object/public/images/${name}`;
}

async function ensureBucket() {
  try {
    await fetch(`${SB_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: sbHeaders(true),
      body: JSON.stringify({ id: 'images', name: 'images', public: true })
    });
  } catch {}
}

app.get('/api/messages', async (req, res) => {
  try {
    if (USE_SB) return res.json(await sbList());
  } catch (err) {
    console.error('Supabase list failed:', err.message);
  }
  const messages = readMessages();
  messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(messages);
});

app.post('/api/messages', upload.single('image'), async (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) {
    return res.status(400).json({ error: 'Name and message are required' });
  }

  const msg = {
    id: uuidv4(),
    author: author.trim().slice(0, 50),
    content: content.trim().slice(0, 1000),
    image: req.file ? `/uploads/${req.file.filename}` : null,
    createdAt: new Date().toISOString()
  };

  if (!DISCORD_WEBHOOK_URL) {
    if (USE_SB) {
      try {
        if (req.file) {
          msg.image = await sbUploadImage(
            fs.readFileSync(req.file.path),
            req.file.mimetype,
            path.extname(req.file.originalname).toLowerCase()
          );
        }
        await sbInsert(msg);
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(201).json({ ...msg, pending: false });
      } catch (err) {
        console.error('Supabase store failed:', err.message);
      }
    }
    const messages = readMessages();
    messages.push(msg);
    writeMessages(messages);
    return res.status(201).json({ ...msg, pending: false });
  }

  const pending = readPending();
  pending.push(msg);
  writePending(pending);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    await sendToDiscord(msg, baseUrl);
    res.status(201).json({ ...msg, pending: true });
  } catch (err) {
    console.error('Discord webhook failed:', err.message);
    res.status(502).json({ error: 'Message received but notification failed' });
  }
});

async function sendToDiscord(msg, baseUrl) {
  const acceptUrl = `${baseUrl}/api/mod/accept?id=${msg.id}&key=${MOD_KEY}`;
  const rejectUrl = `${baseUrl}/api/mod/reject?id=${msg.id}&key=${MOD_KEY}`;
  const ext = msg.image ? path.extname(msg.image) : '';

  const embed = {
    color: 0x8b5cf6,
    title: '📨 New message pending approval',
    description: msg.content.slice(0, 1000),
    fields: [
      { name: '👤 Author', value: msg.author.slice(0, 1024), inline: true },
      { name: 'Approve / Reject', value: `[✅ Accept](${acceptUrl})  |  [❌ Reject](${rejectUrl})` }
    ],
    footer: { text: `#${msg.id.slice(0, 8)} • ${new Date(msg.createdAt).toLocaleString()}` }
  };

  const form = new FormData();
  if (msg.image) {
    const absPath = path.join(__dirname, 'uploads', path.basename(msg.image));
    if (fs.existsSync(absPath)) {
      const buf = fs.readFileSync(absPath);
      const filename = `preview${ext}`;
      form.append('files[0]', new Blob([buf]), filename);
      embed.image = { url: `attachment://${filename}` };
    }
  }
  form.append('payload_json', JSON.stringify({ embeds: [embed] }));

  const resp = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
  if (!resp.ok) {
    throw new Error(`Discord ${resp.status}: ${await resp.text()}`);
  }
}

function keyMatches(given) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(MOD_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function modPage(title, color, sub) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:40px 48px;text-align:center;max-width:400px}
h1{margin:0 0 12px;font-size:1.5rem}
p{color:#71717a;margin:0;font-size:.9rem}
</style></head>
<body><div class="card"><h1 style="color:${color}">${title}</h1><p>${sub}</p></div></body></html>`;
}

app.get('/api/mod/accept', async (req, res) => {
  const { id, key } = req.query;
  if (!id || !keyMatches(key)) return res.status(401).send(modPage('Unauthorized', '#ed4245', 'Invalid link or key.'));
  const pending = readPending();
  const idx = pending.findIndex((p) => p.id === id);
  if (idx === -1) return res.send(modPage('Already handled', '#757575', 'This message was already approved or rejected.'));
  const msg = pending[idx];
  pending.splice(idx, 1);
  writePending(pending);

  if (USE_SB) {
    try {
      let image = msg.image;
      if (image && image.startsWith('/uploads/')) {
        const abs = path.join(__dirname, 'uploads', path.basename(image));
        if (fs.existsSync(abs)) {
          const buf = fs.readFileSync(abs);
          const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(image).toLowerCase()] || 'application/octet-stream';
          image = await sbUploadImage(buf, mime, path.extname(image));
          try { fs.unlinkSync(abs); } catch {}
        }
      }
      await sbInsert({ ...msg, image });
      return res.send(modPage('✅ Approved', '#57f287', 'The message is now live on your page.'));
    } catch (err) {
      console.error('Supabase approve failed:', err.message);
    }
  }

  const messages = readMessages();
  messages.push(msg);
  writeMessages(messages);
  res.send(modPage('✅ Approved', '#57f287', 'The message is now live on your page.'));
});

app.get('/api/mod/reject', (req, res) => {
  const { id, key } = req.query;
  if (!id || !keyMatches(key)) return res.status(401).send(modPage('Unauthorized', '#ed4245', 'Invalid link or key.'));
  const pending = readPending();
  const idx = pending.findIndex((p) => p.id === id);
  if (idx === -1) return res.send(modPage('Already handled', '#757575', 'This message was already approved or rejected.'));
  pending.splice(idx, 1);
  writePending(pending);
  res.send(modPage('❌ Rejected', '#ed4245', 'The message was removed.'));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max 5MB.' });
    }
  }
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  if (USE_SB) ensureBucket();
  console.log(`Server running on port ${PORT}`);
});