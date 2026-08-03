/**
 * Destino de redirección tras autenticarse (`?next=`).
 *
 * Lo usan login y registro para volver a donde el usuario quería ir — sobre todo
 * el flujo de invitación (`/accept-invite?token=…`), que si se pierde deja al
 * invitado en su propia organización vacía en vez de la que lo invitó.
 *
 * Solo se aceptan rutas internas: un `next` con host ajeno (o con `//`, que el
 * navegador interpreta como protocol-relative) sería un open redirect.
 */
export const DEFAULT_AFTER_AUTH = "/surveys";

export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_AFTER_AUTH;
  let value = raw.trim();
  if (!value) return DEFAULT_AFTER_AUTH;
  // Un `next` puede llegar codificado una vez (del querystring) o dos veces si
  // pasó por dos pantallas encadenadas.
  try {
    value = decodeURIComponent(value);
  } catch {
    /* no era URI-encoded: lo usamos tal cual */
  }
  // Debe ser una ruta absoluta del propio sitio: "/algo", nunca "//host" ni
  // "http://host" ni "javascript:".
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_AFTER_AUTH;
  // `\` también sirve como separador de host en varios navegadores ("/\evil.com").
  if (value.startsWith("/\\")) return DEFAULT_AFTER_AUTH;
  return value;
}
