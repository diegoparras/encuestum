"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accesibilidad de un diálogo modal: al abrir lleva el foco adentro, Tab y
 * Shift+Tab giran sólo entre sus controles (antes el foco se iba al editor de
 * atrás, invisible), Esc lo cierra y, al cerrar, el foco vuelve al control que
 * lo abrió. Se usa poniendo el `ref` devuelto en el panel del diálogo (con
 * `tabIndex={-1}` para poder enfocarlo si no tiene controles).
 */
export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(onClose?: () => void, active = true) {
  const ref = useRef<T>(null);
  const cerrar = useRef(onClose);
  useEffect(() => {
    cerrar.current = onClose;
  });

  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const previo = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
    if (!el.contains(document.activeElement)) {
      const autofocus = el.querySelector<HTMLElement>("[autofocus]");
      (autofocus ?? focusables()[0] ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cerrar.current) {
        e.stopPropagation();
        cerrar.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) {
        e.preventDefault();
        return;
      }
      const primero = f[0];
      const ultimo = f[f.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      if (previo && document.contains(previo)) previo.focus();
    };
  }, [active]);

  return ref;
}
