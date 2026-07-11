# Almacenamiento externo (Cloudflare R2 / S3)

Encuestum guarda dos tipos de archivos:

1. **Assets de diseño** — imágenes/audio que subís vos en el editor (portada, logo, fondo, música).
2. **Respuestas en archivo** — lo que sube el **respondiente**: videos grabados por webcam, imágenes o archivos adjuntos.

Por defecto todo va al **disco local** del contenedor (`ENCUESTUM_ASSET_DIR`, servido en `/assets`). Eso alcanza para probar, pero en producción conviene **almacenamiento externo S3-compatible** por tres razones:

- **No te explota el servidor**: los archivos grandes (videos) suben **directo del navegador al bucket** con una URL prefirmada. El backend nunca los toca ni los tiene en RAM/disco.
- **Persistencia**: los deploys/reinicios no borran nada (el disco del contenedor es efímero salvo que montes un volumen).
- **CDN / egress barato**: servís los archivos desde el dominio del bucket o un CDN.

> **Recomendado: Cloudflare R2** — API S3-compatible y **egress gratis** (no pagás por servir los videos).

---

## Cómo funciona (el flujo de subida)

```
Navegador del respondiente                Backend                     Bucket (R2/S3)
        │                                    │                             │
        │ 1. POST /upload-url (tipo, tamaño) │                             │
        │───────────────────────────────────►                             │
        │              2. URL PUT prefirmada │                             │
        │◄───────────────────────────────────                             │
        │ 3. PUT del archivo (directo)                                     │
        │────────────────────────────────────────────────────────────────►
        │ 4. guarda la respuesta con la URL pública del archivo            │
```

- El backend valida **tipo y tamaño** antes de firmar (rechaza tipos no soportados y archivos que superan el máximo).
- La URL prefirmada **vence** (`ENCUESTUM_UPLOAD_URL_TTL`, default 900 s).
- Con storage **local** el paso 3 es un PUT al propio backend (`/api/v1/uploads/local`, token firmado); con **s3** es un PUT directo al bucket.

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
| `ENCUESTUM_S3_PUBLIC_URL` | — | **URL pública** para SERVIR los archivos (dominio público del bucket R2 o tu CDN). |
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
3. **Acceso público de lectura** para servir los archivos. Dos opciones:
   - **Dominio r2.dev** (rápido): en el bucket → *Settings* → *Public access* → *Allow*. Te da una URL `https://pub-xxxx.r2.dev`.
   - **Dominio propio / CDN** (recomendado): conectá un *Custom Domain* (ej. `cdn.tudominio.com`) al bucket.
4. **Regla CORS** en el bucket (para que el navegador pueda hacer el PUT y el GET). En R2 → bucket → *Settings* → *CORS policy*:
   ```json
   [
     {
       "AllowedOrigins": ["https://encuestas.tudominio.com"],
       "AllowedMethods": ["PUT", "GET"],
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
   ENCUESTUM_S3_PUBLIC_URL=https://cdn.tudominio.com   # o el pub-xxxx.r2.dev
   ```
6. **Redeploy**. Probá subiendo un video en una encuesta con pregunta de video; debería ir directo al bucket.

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
ENCUESTUM_S3_PUBLIC_URL=https://encuestum.s3.us-east-1.amazonaws.com   # o tu CloudFront
```

- El bucket necesita **lectura pública** de los objetos (Bucket Policy o CloudFront) y una **CORS** que permita `PUT`/`GET` desde tu dominio (misma idea que R2).
- **MinIO** (self-hosted, dentro de tu red): funciona igual; usá el endpoint interno y su propio dominio público para `S3_PUBLIC_URL`.

---

## Notas y troubleshooting

- **"No se pudo subir el video"** → casi siempre es **CORS del bucket** (falta tu dominio en `AllowedOrigins`, o falta el método `PUT`), o la **URL prefirmada venció** (subida muy lenta con `UPLOAD_URL_TTL` bajo). En `local`, verificá que el frontend resuelva la API contra el backend (en la imagen all-in-one es mismo-origen).
- **El video sube pero no se ve** → revisá `ENCUESTUM_S3_PUBLIC_URL` (el dominio público del bucket) y que los objetos sean de **lectura pública**.
- **Migrar de local a S3**: los archivos viejos siguen en disco (`/assets`). Copiá el contenido del `ENCUESTUM_ASSET_DIR` al bucket manteniendo las rutas (`responses/…`, etc.) si querés conservarlos; los nuevos ya van al bucket.
- **Fuentes de Google**: el panel de diseño carga tipografías desde Google Fonts (el navegador del respondiente necesita salida a internet para verlas; si no, cae a la fuente del sistema). No pasan por tu storage.

Ver también: [Configuración completa (variables)](../README.md#️-configuración-variables-de-entorno) · [Seguridad](SEGURIDAD.md).
