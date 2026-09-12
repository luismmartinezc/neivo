require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const app = express();

// --- Paths -----------------------------------------------------------
// DATA_DIR should point at a persistent Railway Volume in production
// (e.g. DATA_DIR=/data), so uploaded media and edited text survive
// redeploys. Locally it defaults to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONTENT_PATH = path.join(DATA_DIR, 'content.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Seed content.json on first boot (e.g. fresh volume) from the file
// checked into the repo.
if (!fs.existsSync(CONTENT_PATH)) {
  const seedPath = path.join(__dirname, 'data', 'content.json');
  fs.copyFileSync(seedPath, CONTENT_PATH);
}

function readContent() {
  return JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
}

function writeContent(content) {
  fs.writeFileSync(CONTENT_PATH, JSON.stringify(content, null, 2));
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

// --- App setup ---------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.urlencoded({ extended: true }));

const SESSION_SECRET = process.env.SESSION_SECRET || 'neivo-dev-secret-change-me';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB, generous for short video reels
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes o videos.'));
    }
  }
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/admin/login');
}

function deleteMediaFile(media) {
  if (!media || !media.url) return;
  const filename = path.basename(media.url);
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.unlink(filePath, () => {}); // ignore errors (already gone, etc.)
}

// --- Public site ---------------------------------------------------------
app.get('/', (req, res) => {
  const content = readContent();
  res.render('index', { content });
});

// --- Admin: auth ---------------------------------------------------------
app.get('/admin', requireAuth, (req, res) => {
  const content = readContent();
  res.render('admin/dashboard', {
    content,
    saved: req.query.saved === '1',
    error: null
  });
});

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const password = req.body.password || '';
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return res.render('admin/login', {
      error: 'ADMIN_PASSWORD no está configurada en el servidor.'
    });
  }

  if (password === expected) {
    req.session.authed = true;
    return res.redirect('/admin');
  }

  res.render('admin/login', { error: 'Contraseña incorrecta.' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Admin: save all text + replace media -------------------------------
app.post('/admin/save', requireAuth, upload.any(), (req, res) => {
  const content = readContent();
  const body = req.body;
  const files = req.files || [];

  content.hero.tagline = body.hero_tagline ?? content.hero.tagline;
  content.hero.location = body.hero_location ?? content.hero.location;
  content.hero.disciplines = body.hero_disciplines ?? content.hero.disciplines;
  content.hero.availability = body.hero_availability ?? content.hero.availability;

  content.about.statement = body.about_statement ?? content.about.statement;

  content.contact.email = body.contact_email ?? content.contact.email;
  content.contact.instagramHandle = body.contact_instagramHandle ?? content.contact.instagramHandle;
  content.contact.instagramUrl = body.contact_instagramUrl ?? content.contact.instagramUrl;

  content.projects.forEach((project) => {
    const titleKey = `project_title_${project.id}`;
    const metaKey = `project_meta_${project.id}`;
    const descKey = `project_desc_${project.id}`;
    if (body[titleKey] !== undefined) project.title = body[titleKey];
    if (body[metaKey] !== undefined) project.meta = body[metaKey];
    if (body[descKey] !== undefined) project.desc = body[descKey];

    const uploaded = files.find((f) => f.fieldname === `media_${project.id}`);
    if (uploaded) {
      deleteMediaFile(project.media);
      project.media = {
        type: uploaded.mimetype.startsWith('video/') ? 'video' : 'image',
        url: `/uploads/${uploaded.filename}`
      };
    }
  });

  content.about.capabilities.forEach((cap) => {
    const titleKey = `cap_title_${cap.id}`;
    const detailKey = `cap_detail_${cap.id}`;
    if (body[titleKey] !== undefined) cap.title = body[titleKey];
    if (body[detailKey] !== undefined) cap.detail = body[detailKey];
  });

  writeContent(content);
  res.redirect('/admin?saved=1');
});

// --- Admin: add / delete projects ---------------------------------------
app.post('/admin/projects/add', requireAuth, (req, res) => {
  const content = readContent();
  content.projects.push({
    id: newId('project'),
    title: 'Nuevo proyecto',
    meta: 'Tipo de trabajo, año',
    desc: 'Descripción breve del proyecto.',
    media: null
  });
  writeContent(content);
  res.redirect('/admin');
});

app.post('/admin/projects/:id/delete', requireAuth, (req, res) => {
  const content = readContent();
  const idx = content.projects.findIndex((p) => p.id === req.params.id);
  if (idx !== -1) {
    deleteMediaFile(content.projects[idx].media);
    content.projects.splice(idx, 1);
    writeContent(content);
  }
  res.redirect('/admin');
});

// --- Admin: add / delete capabilities ------------------------------------
app.post('/admin/capabilities/add', requireAuth, (req, res) => {
  const content = readContent();
  content.about.capabilities.push({
    id: newId('cap'),
    title: 'Nueva capacidad',
    detail: 'Detalle'
  });
  writeContent(content);
  res.redirect('/admin');
});

app.post('/admin/capabilities/:id/delete', requireAuth, (req, res) => {
  const content = readContent();
  const idx = content.about.capabilities.findIndex((c) => c.id === req.params.id);
  if (idx !== -1) {
    content.about.capabilities.splice(idx, 1);
    writeContent(content);
  }
  res.redirect('/admin');
});

// --- Error handling for multer (e.g. bad file type / too large) --------
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).render('admin/dashboard', {
      content: readContent(),
      saved: false,
      error: err.message || 'Ocurrió un error al guardar.'
    });
  }
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Neivo corriendo en el puerto ${PORT}`);
});
