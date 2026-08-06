# `mod_encuestum` — Fase A: conectar, lanzar y calificar

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development
> para implementar tarea por tarea. Los pasos usan checkbox (`- [ ]`).

**Goal:** que un docente agregue una actividad **Encuestum** nativa en un curso, elija
una encuesta, el alumno la responda embebida y la nota aparezca en el libro de
calificaciones de Moodle — sin `mod_lti` de por medio.

**Architecture:** el módulo no usa LTI. Moodle firma un token corto con un secreto
compartido y redirige al alumno; Encuestum lo canjea por su cookie de sesión. La nota
vuelve por un servicio web que expone el propio módulo y que llama a `grade_update()`.
El porqué —y el hecho de Moodle que lo fuerza— está en
`docs/superpowers/specs/2026-08-06-mod-encuestum-design.md`.

**Tech Stack:** PHP 8.1+ / Moodle 4.5+, FastAPI + SQLModel + Alembic, PyJWT (HS256),
httpx.

## Global Constraints

- Comentarios y docstrings **en español**, como el resto de `backend/app/`.
- Todo lo nuevo del backend vive detrás de `MOD_ENABLED` (por defecto apagado), con el
  mismo criterio que `LTI_ENABLED`: apagado, la superficie **no existe** (404, no 403).
- El backend corre contra **PostgreSQL**: `docker compose -f dev/test-db/docker-compose.yml up -d`.
  No fabricar `org_id` con `uuid.uuid4()`; usar `crear_org()` de `tests/conftest.py`.
- Nunca `request.url_for()` ni `request.base_url` — detrás del nginx de este proyecto el
  esquema sale `http://`. Usar `get_settings().public_base_url`.
- Las cookies que viajan dentro del iframe van `Secure` + `SameSite=None` **siempre**,
  también en `delete_cookie`. Reusar `_lti_cookie_kwargs()`.
- `session.rollback()` expira toda la identity map: releer de la base después.
- `ruff check .` limpio; suite sin regresiones.
- Frankenstyle: el componente es `mod_encuestum`, la carpeta `mod/encuestum`.

---

### Task 1: El sitio conectado (modelo y registro)

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/0021_mod_sites.py`
- Create: `backend/app/routers/modapi.py`
- Modify: `backend/app/main.py`, `backend/app/config.py`
- Test: `backend/tests/test_mod_registro.py`

**Interfaces:**
- Produces: modelo `MoodleSite`; `POST /api/v1/mod/connect-url` (admin, mintea token de
  30 min); `POST /mod/register` (lo llama Moodle con ese token).

**Modelo.** En `models.py`, junto a `LtiPlatform`:

```python
class MoodleSite(SQLModel, table=True):
    """Un Moodle conectado por el módulo nativo (no por LTI).

    `secret_hash`: nunca se guarda el secreto en claro. Se genera una vez, se
    devuelve una vez, y de ahí en más sólo se compara el hash -- mismo criterio
    que las contraseñas."""
    __tablename__ = "mod_sites"
    __table_args__ = (UniqueConstraint("org_id", "wwwroot", name="uq_mod_site"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(GUID, ForeignKey("organizations.id", ondelete="CASCADE"),
                         nullable=False, index=True))
    wwwroot: str = Field(sa_column=Column(String, nullable=False))
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    secret_hash: str = Field(sa_column=Column(String, nullable=False))
    # Token de servicio web de Moodle, para empujarle la nota. Es un secreto de
    # ELLOS que guardamos nosotros; va cifrado igual que el resto de las
    # credenciales salientes del producto.
    ws_token: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow))
```

Mirar cómo `LtiPlatform` declara `org_id` y copiar exactamente ese patrón (tipo de
columna GUID, índice, `ondelete`).

**Registro.** `POST /mod/register` recibe `{token, wwwroot, ws_token}`:

1. `read_purpose_token(MOD_REGISTER_PURPOSE, token)` → de ahí sale el `org_id`, **nunca**
   de un parámetro que controle quien llama. Vencido o ausente → 400.
2. `assert_public_url(wwwroot, require_https=True)` — si no, 400. Esto ya existe en
   `app/net_guard.py` y se usa igual en el registro LTI.
3. Si ya hay un sitio con ese `(org_id, wwwroot)`, se **rota** el secreto. Si el
   `wwwroot` existe pero bajo **otra** organización, 409 y no se toca nada:
   sin ese chequeo, el que registra segundo se queda con el sitio del primero.
4. Devuelve `{"secret": "<48 bytes url-safe>", "site_id": "..."}`. Se genera con
   `secrets.token_urlsafe(36)` y se guarda **hasheado**.

**Tests que importan** (los dos fallan en silencio si se rompen):

```python
async def test_no_se_puede_robar_el_sitio_de_otra_organizacion(...):
    """Registrar el mismo wwwroot desde otra org debe dar 409 y dejar el
    secreto original intacto -- si se sobreescribe, el Moodle de la escuela A
    pasa a lanzar contra los datos de la escuela B."""

async def test_el_secreto_no_se_guarda_en_claro(...):
    """Lo que queda en la base no tiene que servir para firmar un lanzamiento."""
```

- [ ] Escribir los dos tests y verlos fallar.
- [ ] Modelo + migración `0021`.
- [ ] Router y endpoints.
- [ ] `MOD_ENABLED` en `config.py` con el mismo `_bool()` que `LTI_ENABLED`.
- [ ] Suite en verde; commit `feat(mod): registro de sitios Moodle del módulo nativo`.

---

### Task 2: El lanzamiento

**Files:**
- Modify: `backend/app/routers/modapi.py`
- Create: `backend/app/mod/launch.py`
- Test: `backend/tests/test_mod_launch.py`

**Interfaces:**
- Produces: `GET /mod/launch?t=<JWT>` → 302 a `/s/{slug}` con la cookie sembrada.

El JWT lo firma Moodle con el secreto compartido (HS256) y trae:

```
iss = wwwroot        exp <= iat + 120        jti (aleatorio, único)
site_id, survey_id, cmid, course_id, context_title
sub  = HMAC(secreto, user_id) -- NO el id de Moodle
name, email          (ausentes si la actividad es anónima)
roles = ["teacher"] | ["student"]
anonymous = bool
```

**Lo que hay que validar, y por qué cada cosa:**

| Validación | Si falta |
|---|---|
| Firma con el secreto de ESE `site_id` | cualquiera lanza como cualquiera |
| `exp` presente y `<= iat + 120` | un token robado sirve para siempre |
| `jti` no visto antes (cache con TTL de 120 s) | replay: repetir el mismo lanzamiento |
| La encuesta pertenece a la org del sitio | acceso cruzado entre organizaciones |
| `alg` es exactamente `HS256` | `alg: none`, o confusión de algoritmo |

El `sub` **no** es el `id` de Moodle: es `HMAC(secreto, user_id)`. Estable para el mismo
sitio, inútil fuera de él, y no revela cuántos usuarios tiene la instalación.

Reusar la cookie que ya existe (`LTI_COOKIE`, `_lti_cookie_kwargs()`): el lado público
(`_lti_context` en `routers/public.py`) ya sabe leerla y saltear el PIN. **No inventar
una cookie nueva** — habría que enseñarle a `public.py` a leer dos.

- [ ] Tests: firma inválida → 401; `exp` vencido → 401; `jti` repetido → 401; encuesta de
      otra org → 404; lanzamiento válido → 302 + cookie `Secure; SameSite=None`.
- [ ] Verificar que discriminan rompiendo cada validación.
- [ ] Commit `feat(mod): lanzamiento firmado del módulo nativo`.

---

### Task 3: La nota de vuelta

**Files:**
- Create: `backend/app/mod/grades.py`
- Modify: `backend/app/lti/ags.py` (sólo el despacho)
- Test: `backend/tests/test_mod_grades.py`

Cuando una respuesta viene de un `MoodleSite` (no de un `LtiResourceLink`), la nota se
empuja al servicio web de Moodle:

```
POST {wwwroot}/webservice/rest/server.php
  wstoken={ws_token}&wsfunction=mod_encuestum_submit_grade&moodlewsrestformat=json
  cmid=..&sub=..&grade=..&max=..&needs_review=0|1
```

**Tres cosas que no son obvias:**

1. **La escala la define Moodle.** El `grade_item` del módulo tiene su `grademax`; hay que
   mandar la nota en esa escala. Mismo problema que ya resolvió `get_lineitem_max()` para
   AGS: se lee y se reescala, no se asume 100.
2. **`anonymous` corta antes de pedir nada.** Igual que `_deliver` hoy. Publicar una nota
   por alumno es identificarlo.
3. **`assert_public_url` en cada envío**, no sólo al registrar: el `wwwroot` guardado pudo
   quedar apuntando a otro lado.

Reusar el disparador que ya existe (`schedule_score`): cambia el transporte, no el
momento. Una respuesta pertenece a un vínculo LTI **o** a un sitio del módulo, nunca a
los dos.

- [ ] Tests: se reescala a la escala de Moodle; anónimo no genera NINGUNA llamada
      saliente; un 500 de Moodle no propaga (la respuesta del alumno ya está guardada).
- [ ] Commit `feat(mod): publicación de notas al servicio web de Moodle`.

---

### Task 4: El esqueleto del plugin

**Files (repo nuevo `moodle-mod_encuestum`):**
- `version.php`, `db/install.xml`, `db/access.php`, `lib.php`, `mod_form.php`,
  `view.php`, `settings.php`, `lang/en/mod_encuestum.php`, `lang/es/mod_encuestum.php`,
  `pix/icon.svg`, `classes/privacy/provider.php`

`version.php`: `component = 'mod_encuestum'`, `requires = 2024100700`,
`supported = [405, 500]`, `MATURITY_ALPHA` mientras no esté completo.

`db/install.xml` — tabla `encuestum`: `id, course, name, intro, introformat, survey_id
(char 36), survey_title, anonymous (int 1), grade (int), timemodified`.

**La Privacy API acá NO es `null_provider`**, a diferencia de `local_encuestum`: el módulo
manda nombre y email del alumno a un sistema externo. Hay que declarar
`\core_privacy\local\metadata\provider` con un `external_location_link`, y decir
exactamente qué se manda.

- [ ] El plugin instala en el Moodle del entorno Docker (`admin/cli/upgrade.php`,
      **nunca como root** — crea cachés que el servidor web no puede escribir y Moodle
      responde 500 en todo).
- [ ] Commit inicial.

---

### Task 5: Conexión y lanzamiento desde Moodle

**Files:** `settings.php`, `classes/connect.php`, `launch.php`, `view.php`

- Ajustes: campo "URL de conexión" (la que genera Encuestum) + botón *Conectar*.
  Al conectar: crea un token de servicio web para el usuario de servicio, hace el `POST
  /mod/register` con `wwwroot` + ese token, y guarda el secreto que vuelve.
- `view.php`: arma el JWT y embebe `/mod/launch?t=...` en un iframe.
- El docente ve además un selector de encuesta en `mod_form.php`, que consulta a Encuestum
  con el mismo secreto.

> El botón lee la URL **guardada**, no la que está en pantalla. Mismo tropiezo que
> documenta `docs/INSTALAR-PLUGIN-VPS.md` para `local_encuestum`: hay que guardar antes.

- [ ] Commit.

---

### Task 6: El servicio web de notas

**Files:** `db/services.php`, `classes/external/submit_grade.php`, `lib.php`

`mod_encuestum_submit_grade(cmid, sub, grade, max, needs_review)`:

1. Valida el token (lo hace Moodle) y la capacidad `mod/encuestum:receivegrade`.
2. Resuelve el alumno desde `sub` recorriendo los inscriptos del curso y comparando
   `HMAC(secreto, user_id)` — el `sub` es opaco a propósito.
3. `grade_update('mod/encuestum', $courseid, 'mod', 'encuestum', $instance, 0, $grades)`.

**Un alumno no inscripto no recibe nota**: si el `sub` no matchea a nadie del curso, error,
no un `grade_update` a ciegas.

- [ ] Commit.

---

### Task 7: De punta a punta contra el Docker

- [ ] Montar `mod/encuestum` en `dev/moodle/docker-compose.yml` junto al `local/`.
- [ ] Conectar, crear una actividad, elegir encuesta, responder como alumno y confirmar la
      nota en el libro de calificaciones.
- [ ] Repetir con la actividad marcada anónima: sin atribución y **sin** nota.
- [ ] Documentar en `docs/MOODLE.md` cuándo conviene cada plugin.

---

## Cierre

- [ ] `cd backend && python -m pytest -q` en verde.
- [ ] Los dos plugins instalados a la vez no duplican "Encuestum" en el selector de
      actividades (decidir quién cede y documentarlo).
