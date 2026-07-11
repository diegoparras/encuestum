# Almacenamiento externo (Cloudflare R2 / S3)

Encuestum guarda dos tipos de archivos:

1. **Assets de diseño** — imágenes/audio que subís vos en el editor (portada, logo, fondo, música).
2. **Respuestas en archivo** — lo que sube el **respondiente**: videos grabados por webcam, imágenes o archivos adjuntos.

Por defecto todo va al **disco local** del contenedor (`ENCUESTUM_ASSET_DIR`, servido en `/assets`). Eso alcanza para probar, pero en producción conviene **almacenamiento externo S3-compatible** por tres razones:

- **No te explota el servidor**: los archivos grandes (videos) suben **directo del navegador al bucket** con una URL prefirmada. El backend nunca los bufferea ni los tiene en RAM.
- **Persistencia**: los deploys/reinicios no borran nada (el disco del contenedor es efímero salvo que montes un volumen).
- **Privacidad**: el bucket queda **privado** — la app sirve los archivos same-origin (`/assets/…`), la ruta del bucket nunca llega al navegador y los archivos de respuesta tienen control de acceso por organización.

> **Recomendado: Cloudflare R2** — API S3-compatible y **egress gratis** (leer los archivos desde tu server no cuesta nada).

---

## Cómo funciona (subida y servido)

```
Navegador del respondiente                Backend                     Bucket (R2/S3, PRIVADO)
        │                                    │                             │
        │ 1. POST /upload-url (tipo, tamaño) │                             │
        │───────────────────────────────────►                             │
        │              2. URL PUT prefirmada │                             │
        │◄───────────────────────────────────                             │
        │ 3. PUT del archivo (directo)                                     │
        │────────────────────────────────────────────────────────────────►
        │ 4. guarda la respuesta con la URL /assets/… (same-origin)        │
        │                                    │                             │
        │ 5. GET /assets/…  (ver el archivo) │                             │
        │───────────────────────────────────►│ 6. streaming desde el bucket│
        │◄───────────────────────────────────│◄────────────────────────────
```

- El backend valida **tipo y tamaño** antes de firmar (rechaza tipos no soportados y archivos que superan el máximo).
- La URL prefirmada **vence** (`ENCUESTUM_UPLOAD_URL_TTL`, default 900 s).
- Con storage **local** el paso 3 es un PUT al propio backend (`/api/v1/uploads/local`, token firmado); con **s3** es un PUT directo al bucket.
- **El servido es same-origin**: las URLs que ve el navegador son `/assets/…` de tu propio dominio; la app streamea desde el bucket (con soporte de **Range**, así el video hace seek). El **bucket queda privado** y su ruta nunca se expone.

### Quién puede ver qué

| Prefijo en el bucket | Contenido | Acceso |
|---|---|---|
| `{org_id}/…` | Assets de diseño (fondo, logo, música) | Público — los respondientes los necesitan sin login. |
| `responses/{survey_id}/…` | Archivos de RESPUESTA (videos, adjuntos) | Solo **miembros de la organización** dueña de la encuesta (o super-admin). El que sube recibe un token firmado de 24 h en la URL para su propia vista previa. |

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_STORAGE` | `local` | `local` = disco; `s3` = bucket S3-compatible. |
| `ENCUESTUM_S3_ENDPOINT` | — | Endpoint del bucket. R2: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. |
| `ENCUESTUM_S3_BUCKET` | — | Nombre del bucket. |
| `ENCUESTUM_S3_ACCESS_KEY_ID` | — | Access key. |
| `ENCUESTUM_S3_SECRET_ACCESS_KEY` | — | Secret key. |
| `ENCUESTUM_S3_REGION` | `auto` | Región (R2 usa `auto`). |
| `ENCUESTUM_S3_PUBLIC_URL` | — | (Opcional) servir desde un **bucket público/CDN** en vez del proxy same-origin. **Ojo**: expone el dominio del bucket y desactiva el control de acceso de `responses/*`. Dejala vacía para el modo recomendado (bucket privado). |
| `ENCUESTUM_S3_PREFIX` | — | (Opcional) carpeta dentro del bucket. |
| `ENCUESTUM_UPLOAD_URL_TTL` | `900` | Vida de la URL prefirmada (segundos). |

Límites de tamaño (aplican a los dos modos):

| Variable | Default | |
|---|---|---|
| `ENCUESTUM_ASSET_MAX_IMAGE_MB` | `8` | Imágenes. |
| `ENCUESTUM_ASSET_MAX_AUDIO_MB` | `15` | Audio. |
| `ENCUESTUM_ASSET_MAX_VIDEO_MB` | `50` | Video (respuestas). |

Solo para el modo `local`:

| Variable | Default | |
|---|---|---|
| `ENCUESTUM_ASSET_DIR` | `${ENCUESTUM_DATA_DIR}/assets` | Carpeta en disco. Montá un volumen acá si usás local en producción. |

---

## Receta: Cloudflare R2 (recomendado)

1. **Creá el bucket** en el dashboard de Cloudflare → R2 → *Create bucket* (ej. `encuestum`).
2. **API Token** → R2 → *Manage R2 API Tokens* → creá un token con permiso **Object Read & Write** sobre ese bucket. Anotá `Access Key ID` y `Secret Access Key`, y tu **Account ID** (para el endpoint).
3. **Dejá el bucket PRIVADO** — no habilites *Public access* ni conectes un dominio: la app sirve los archivos same-origin y la ruta del bucket nunca se expone.
4. **Regla CORS** en el bucket (solo para que el navegador pueda hacer el **PUT** de la subida directa). En R2 → bucket → *Settings* → *CORS policy*:
   ```json
   [
     {
       "AllowedOrigins": ["https://encuestas.tudominio.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   > `AllowedOrigins` = el dominio público de tu Encuestum. Si tenés varios (o subdominios por organización), sumalos.
5. **Variables** en Encuestum (App de EasyPanel / `.env`):
   ```
   ENCUESTUM_STORAGE=s3
   ENCUESTUM_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   ENCUESTUM_S3_BUCKET=encuestum
   ENCUESTUM_S3_ACCESS_KEY_ID=<access-key>
   ENCUESTUM_S3_SECRET_ACCESS_KEY=<secret>
   ENCUESTUM_S3_REGION=auto
   ```
6. **Redeploy**. Probá subiendo un video en una encuesta con pregunta de video; debería ir directo al bucket y reproducirse desde `/assets/…` de tu dominio.

> **¿Preferís servir desde un CDN/bucket público?** Seteá `ENCUESTUM_S3_PUBLIC_URL` (dominio `pub-xxxx.r2.dev` o un *Custom Domain*) y sumá `GET` a los `AllowedMethods` del CORS. A cambio, el dominio del bucket queda expuesto y los archivos de respuesta pasan a estar protegidos solo por URL no adivinable (sin el gate por organización).

---

## Receta: Amazon S3 (u otro S3-compatible / MinIO)

Igual que R2, cambiando el endpoint y la región:

```
ENCUESTUM_STORAGE=s3
ENCUESTUM_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com   # MinIO: http://minio:9000
ENCUESTUM_S3_BUCKET=encuestum
ENCUESTUM_S3_ACCESS_KEY_ID=<access-key>
ENCUESTUM_S3_SECRET_ACCESS_KEY=<secret>
ENCUESTUM_S3_REGION=us-east-1
```

- Igual que con R2, el bucket puede quedar **privado** (la app lo sirve same-origin); solo necesita una **CORS** que permita `PUT` desde tu dominio. `S3_PUBLIC_URL` (CloudFront, etc.) es opcional y requiere lectura pública + `GET` en la CORS.
- **MinIO** (self-hosted, dentro de tu red): funciona igual; usá el endpoint interno y dejá `S3_PUBLIC_URL` vacía.

---

## Notas y troubleshooting

- **"No se pudo subir el video"** → casi siempre es **CORS del bucket** (falta tu dominio en `AllowedOrigins`, o falta el método `PUT`), o la **URL prefirmada venció** (subida muy lenta con `UPLOAD_URL_TTL` bajo). En `local`, verificá que el frontend resuelva la API contra el backend (en la imagen all-in-one es mismo-origen).
- **El video sube pero no se ve** → en el modo por defecto (bucket privado) revisá los **logs del backend** (es quien streamea desde el bucket: credenciales o endpoint mal). Un **403** en `/assets/responses/…` es el control de acceso: esos archivos solo los ven miembros de la organización con sesión iniciada (o el que subió, con su token de 24 h). Si usás `ENCUESTUM_S3_PUBLIC_URL`, revisá que los objetos sean de lectura pública y que la CORS permita `GET`.
- **Migrar de local a S3**: los archivos viejos siguen en disco (`/assets`). Copiá el contenido del `ENCUESTUM_ASSET_DIR` al bucket manteniendo las rutas (`responses/…`, etc.) si querés conservarlos; los nuevos ya van al bucket. Las URLs guardadas no cambian (`/assets/…` en ambos modos).
- **Fuentes de Google**: el panel de diseño carga tipografías desde Google Fonts (el navegador del respondiente necesita salida a internet para verlas; si no, cae a la fuente del sistema). No pasan por tu storage.

Ver también: [Configuración completa (variables)](../README.md#️-configuración-variables-de-entorno) · [Seguridad](SEGURIDAD.md).
