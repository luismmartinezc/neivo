require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');

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

// Comprime y reescala un video subido a algo liviano para web:
// máximo 1280px de ancho, H.264, sin audio (los reels del sitio van
// siempre en "muted"), y "faststart" para que empiece a reproducirse
// antes de terminar de descargar.
function compressVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=w=min(1280\\,iw):h=-2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-an',
      '-movflags', '+faststart',
      outputPath
    ];
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
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
app.post('/admin/save', requireAuth, upload.any(), async (req, res) => {
  try {
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

    for (const project of content.projects) {
      const titleKey = `project_title_${project.id}`;
      const metaKey = `project_meta_${project.id}`;
      const descKey = `project_desc_${project.id}`;
      if (body[titleKey] !== undefined) project.title = body[titleKey];
      if (body[metaKey] !== undefined) project.meta = body[metaKey];
      if (body[descKey] !== undefined) project.desc = body[descKey];

      const uploaded = files.find((f) => f.fieldname === `media_${project.id}`);
      if (!uploaded) continue;

      const previousMedia = project.media;

      if (uploaded.mimetype.startsWith('video/')) {
        const compressedFilename = `${path.parse(uploaded.filename).name}-web.mp4`;
        const compressedPath = path.join(UPLOADS_DIR, compressedFilename);
        try {
          await compressVideo(uploaded.path, compressedPath);
          fs.unlink(uploaded.path, () => {}); // ya no necesitamos el archivo original sin comprimir
          project.media = { type: 'video', url: `/uploads/${compressedFilename}` };
        } catch (compressErr) {
          // Si ffmpeg falla por alguna razón, no perdemos la subida:
          // usamos el archivo original sin comprimir como respaldo.
          console.error('No se pudo comprimir el video, se usa el original:', compressErr.message);
          project.media = { type: 'video', url: `/uploads/${uploaded.filename}` };
        }
      } else {
        project.media = { type: 'image', url: `/uploads/${uploaded.filename}` };
      }

      deleteMediaFile(previousMedia);
    }

    content.about.capabilities.forEach((cap) => {
      const titleKey = `cap_title_${cap.id}`;
      const detailKey = `cap_detail_${cap.id}`;
      if (body[titleKey] !== undefined) cap.title = body[titleKey];
      if (body[detailKey] !== undefined) cap.detail = body[detailKey];
    });

    writeContent(content);
    res.redirect('/admin?saved=1');
  } catch (err) {
    console.error('Error al guardar:', err);
    res.status(500).render('admin/dashboard', {
      content: readContent(),
      saved: false,
      error: 'Ocurrió un error al guardar los cambios. Intenta de nuevo.'
    });
  }
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
