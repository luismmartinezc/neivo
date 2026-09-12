# Neivo — sitio + panel /admin

Sitio de una página para Neivo (producción audiovisual) con un panel en
`/admin` para editar los textos y subir fotos/videos de cada proyecto sin
tocar código.

## Cómo funciona

- El diseño visual es el mismo HTML/CSS original; ahora se genera desde
  una plantilla (`views/index.ejs`) que lee el contenido de
  `data/content.json`.
- `/admin` es un panel protegido por contraseña donde puedes:
  - Editar el texto de la portada, la sección "Estudio" y "Contacto".
  - Editar título, línea de contexto y descripción de cada proyecto.
  - Subir una foto o un video (MP4) para cada proyecto — reemplaza el
    marcador de "Reel de...".
  - Añadir o eliminar proyectos y capacidades.
- Todo se guarda en `content.json` + una carpeta `uploads/`, sin base de
  datos.

## Correr en local

```bash
npm install
cp .env.example .env
# edita .env y pon una contraseña en ADMIN_PASSWORD
npm start
```

Abre `http://localhost:3000` para el sitio y
`http://localhost:3000/admin` para el panel.

## Subir a GitHub

```bash
cd neivo
git init
git add .
git commit -m "Sitio de Neivo con panel /admin"
git branch -M main
git remote add origin https://github.com/<tu-usuario>/<tu-repo>.git
git push -u origin main
```

(`node_modules`, `.env` y las fotos/videos subidos en local ya están
excluidos vía `.gitignore` — no hace falta limpiarlos a mano.)

## Desplegar en Railway

1. En Railway, crea un proyecto nuevo → **Deploy from GitHub repo** y
   selecciona el repositorio que acabas de subir. Railway detecta
   Node.js automáticamente (usa `npm start`).
2. En **Variables** del servicio, agrega:
   - `ADMIN_PASSWORD` → la contraseña para entrar a `/admin`.
   - `SESSION_SECRET` → cualquier cadena larga y aleatoria.
   - `DATA_DIR` → `/data`
3. **Importante para que las fotos/videos y los textos no se borren en
   cada deploy:** en la pestaña del servicio, agrega un **Volume** y
   móntalo en `/data`. Sin esto, cada vez que Railway reconstruye el
   contenedor perderías lo que subiste desde `/admin` (el filesystem
   normal de Railway no es persistente entre deploys).
4. Genera el dominio público desde **Settings → Networking → Generate
   Domain**, o conecta el dominio propio (como hiciste con
   delcastillogroupglobal.com) desde ahí mismo.
5. Entra a `https://tu-dominio/admin`, inicia sesión con
   `ADMIN_PASSWORD` y empieza a subir las fotos/videos reales de cada
   proyecto.

## Notas

- Los videos se muestran con autoplay silenciado y en loop (igual que
  un reel); si prefieres que no hagan autoplay, es un cambio de una
  línea en `views/index.ejs` y `views/admin/dashboard.ejs`.
- El límite de subida está puesto en 200MB por archivo
  (`server.js`, constante `limits.fileSize`) — ajústalo si tus videos
  pesan más.
- La sesión de `/admin` dura 8 horas; después hay que volver a poner
  la contraseña.
