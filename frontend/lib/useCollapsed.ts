"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Secciones plegables que recuerdan su estado entre visitas.
 *
 * El builder tiene mucho panel: la paleta de 15 tipos de pregunta se come el
 * lado izquierdo y deja la lista apretada abajo, y el lado derecho apila varios
 * bloques de ajustes. Poder cerrar lo que no se está usando es la diferencia
 * entre trabajar cómodo o pelearse con el scroll — pero sólo sirve si la
 * elección persiste; si cada recarga vuelve a abrir todo, molesta más de lo que
 * ayuda.
 *
 * La clave es por usuario/navegador, no por encuesta: es una preferencia de
 * cómo trabaja cada uno, no un dato de la encuesta.
 */
export function useCollapsed(key: string, defaultCollapsed = false) {
  const storageKey = `encuestum.collapsed.${key}`;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) setCollapsed(raw === "1");
    } catch {
      /* storage no disponible */
    }
    loaded.current = true;
  }, [storageKey]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [storageKey]);

  return [collapsed, toggle] as const;
}
