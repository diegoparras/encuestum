# Subdominios propios por organización

Cada organización puede reclamar un subdominio (`acme.encuestum.com`) para que
sus encuestas y páginas públicas queden bajo su propia marca. La **parte de la
app** ya está lista; lo único que hay que configurar por fuera es **DNS + TLS**
(certificado que cubra los subdominios). Esta guía cubre eso.

## 1. Habilitar en la app

Definí el dominio base en el backend:

```
ENCUESTUM_BASE_DOMAIN=encuestum.com
```

Con eso, en **Panel → Miembros → Subdominio** los admins de cada organización
pueden reclamar/editar/quitar su subdominio. La app valida:

- 3–40 caracteres, `a-z 0-9 -`, sin guion al inicio/fin.
- No puede ser una palabra reservada (`www`, `api`, `app`, `admin`, `s`, …).
- Único en toda la plataforma (409 si ya está tomado).

Las páginas públicas (`/s/{slug}`) detectan el host: si entran por
`acme.encuestum.com`, muestran un encabezado con el nombre (y logo) de la org.

## 2. DNS

Apuntá un **comodín** al mismo destino que tu dominio principal, para no tocar
DNS cada vez que una organización reclama su subdominio.

| Tipo    | Nombre            | Valor                       |
|---------|-------------------|-----------------------------|
| `A`/`AAAA` o `CNAME` | `*.encuestum.com` | (misma IP/host que `encuestum.com`) |

- **Cloudflare**: agregá el registro `*` (proxied naranja está OK). El plan
  gratuito cubre **un** nivel de comodín (`*.encuestum.com`), suficiente acá.
- **Proveedor propio (EasyPanel/VPS con nginx/Traefik)**: `A` de `*` a la IP.

## 3. TLS (certificado comodín)

Un certificado normal de Let's Encrypt (HTTP-01) **no** cubre comodines. Para
`*.encuestum.com` necesitás **DNS-01**. Opciones:

- **Cloudflare proxied**: el certificado lo termina Cloudflare — no hacés nada.
  Es el camino más simple. (Origin cert de Cloudflare para el tramo servidor.)
- **Traefik + Let's Encrypt DNS-01**: configurá el `dnsChallenge` con el
  provider de tu DNS y `main: encuestum.com`, `sans: *.encuestum.com`.
- **EasyPanel**: agregá `encuestum.com` y `*.encuestum.com` como dominios del
  servicio; si tu DNS está en Cloudflare, usá el modo proxied.
- **certbot manual**: `certbot certonly --preferred-challenges dns -d encuestum.com -d '*.encuestum.com'`.

## 4. Ruteo al contenedor

La imagen all-in-one sirve todo en el puerto 80 (nginx interno → Next + API).
No hace falta config extra por subdominio: cualquier host que llegue al
contenedor sirve la misma app, y la app resuelve el branding por el `Host`.
Solo asegurate de que tu reverse proxy **pase el `Host` original**
(`proxy_set_header Host $host;` en nginx; en Traefik es el default).

## 5. Verificación

1. Reclamá un subdominio en el panel (ej. `acme`).
2. Abrí `https://acme.encuestum.com/s/{slug-de-una-encuesta}`.
3. Deberías ver el encabezado con el nombre de la organización y el candado TLS
   válido.

> Si el subdominio resuelve pero da error de certificado, falta el comodín en
> TLS (paso 3). Si da 404 de DNS, falta el registro comodín (paso 2).
