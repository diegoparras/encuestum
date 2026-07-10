"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { ArrowLeft, Send } from "lucide-react";
import { useI18n } from "@/lib/i18n";

// Skin conversacional (estilo Typebot) montado ENCIMA de SurveyJS: una pregunta
// por vez como burbuja de "bot", las respuestas previas como transcript de chat,
// indicador de "escribiendo…" entre preguntas y auto-avance en las de opción
// única. No reimplementa SurveyJS: reusa su modelo (validación, tipos de
// pregunta, corrección, subida de archivos y submit por onComplete). Sólo cambia
// la PRESENTACIÓN — ocultamos el chrome de SurveyJS por CSS y conducimos la
// navegación con nuestros propios botones.

interface Props {
  model: Model;
  accent: string;
  dark: boolean;
  // En la vista previa del builder va embebido en un contenedor de alto fijo;
  // en la página real ocupa todo el viewport.
  embedded?: boolean;
}

// Tipos de pregunta que avanzan solos al elegir (como en Typebot). El texto
// libre y las de selección múltiple requieren tocar "Enviar".
const AUTO_ADVANCE = new Set(["radiogroup", "rating", "boolean", "dropdown", "imagepicker"]);

function isAutoAdvance(q: any): boolean {
  if (!q || !AUTO_ADVANCE.has(q.getType?.())) return false;
  // imagepicker/checkbox con selección múltiple no debería auto-avanzar.
  if (q.multiSelect === true || q.renderAs === "checkbox") return false;
  return true;
}

function answerText(q: any, fallback: string): string {
  try {
    if (!q || q.isEmpty?.()) return "";
    const dv = q.displayValue;
    if (typeof dv === "string" && dv.trim()) return dv;
    if (Array.isArray(dv)) return dv.filter(Boolean).join(", ") || fallback;
    if (dv && typeof dv === "object") return fallback;
    return dv != null ? String(dv) : fallback;
  } catch {
    return fallback;
  }
}

export function ChatSurveyView({ model, accent, dark, embedded }: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState(0);
  const [typing, setTyping] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Los handlers de eventos se registran una sola vez (deps [model]); para que
  // el auto-avance siempre use la versión fresca de advance(), la leemos por ref.
  const advanceRef = useRef<() => void>(() => {});

  const bump = () => setVersion((v) => v + 1);

  // Una pregunta por pantalla: es la base del formato conversacional. Al aplicarlo
  // SurveyJS reorganiza las páginas (una pregunta c/u), así que bump() para que el
  // conteo de progreso y el transcript se recalculen sobre las páginas nuevas.
  useEffect(() => {
    try {
      model.questionsOnPageMode = "questionPerPage";
    } catch {
      /* algunos esquemas ya vienen así */
    }
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const startTyping = (ms: number) => {
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), ms);
  };

  useEffect(() => {
    // Intro de "escribiendo…" para la primera pregunta.
    startTyping(650);

    const onPage = () => {
      bump();
      startTyping(600);
    };
    const onValue = (_s: any, opt: any) => {
      bump();
      const q = (model as any).currentSingleQuestion || model.currentPage?.questions?.[0];
      if (q && q.name === opt?.name && isAutoAdvance(q) && !q.isEmpty?.()) {
        if (advanceTimer.current) clearTimeout(advanceTimer.current);
        advanceTimer.current = setTimeout(() => {
          const cur = (model as any).currentSingleQuestion || model.currentPage?.questions?.[0];
          if (cur && cur.name === q.name && !cur.isEmpty?.()) advanceRef.current();
        }, 520);
      }
    };
    const onComplete = () => bump();

    model.onCurrentPageChanged.add(onPage);
    model.onValueChanged.add(onValue);
    model.onComplete.add(onComplete);
    return () => {
      model.onCurrentPageChanged.remove(onPage);
      model.onValueChanged.remove(onValue);
      model.onComplete.remove(onComplete);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Autoscroll al final en cada cambio (nueva pregunta, respuesta, typing).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [version, typing]);

  // En modo "questionPerPage" (v2) SurveyJS mantiene 1 página lógica pero pagina
  // pregunta por pregunta: contamos y navegamos por PREGUNTAS, no por páginas.
  function visibleQuestions(): any[] {
    try {
      return (model.getAllQuestions(false) as any[]).filter((q) => q.isVisible !== false);
    } catch {
      return [];
    }
  }
  function currentQuestion(): any {
    return (model as any).currentSingleQuestion || model.currentPage?.questions?.[0];
  }

  function advance() {
    try {
      const cur = currentQuestion();
      // Validamos SOLO la pregunta actual (no toda la página, que tiene todas).
      if (cur?.validate && !cur.validate(true)) {
        bump();
        return;
      }
      const qs = visibleQuestions();
      const idx = cur ? qs.findIndex((q) => q.name === cur.name) : 0;
      if (idx >= qs.length - 1) {
        model.completeLastPage();
      } else {
        model.nextPage();
        startTyping(600);
      }
      bump();
    } catch {
      /* SurveyJS maneja los errores de validación in-place */
    }
  }
  advanceRef.current = advance;

  function back() {
    if (typing) return;
    try {
      const qs = visibleQuestions();
      const cur = currentQuestion();
      const idx = cur ? qs.findIndex((q) => q.name === cur.name) : 0;
      if (idx > 0) {
        model.prevPage();
        bump();
      }
    } catch {
      /* ignore */
    }
  }

  // Se lee fresco en cada render (el estado `version` dispara los re-renders en
  // cada evento del modelo).
  void version;
  const allQ = visibleQuestions();
  const currentQ = currentQuestion();
  const curIdx = currentQ ? Math.max(0, allQ.findIndex((q) => q.name === currentQ.name)) : 0;
  const total = allQ.length || 1;
  const isLastQ = curIdx >= total - 1;
  const fallbackAnswer = t("public.chat.answered");

  return (
    <div className={`enc-chat${dark ? " enc-chat-dark" : ""}${embedded ? " enc-chat-embed" : ""}`}>
      <style>{chatCss(accent, dark)}</style>
      <div className="enc-chat-scroll" ref={scrollRef}>
        <div className="enc-chat-thread">
          {/* Transcript: preguntas ya respondidas como burbujas bot + usuario. */}
          {allQ.slice(0, curIdx).map((q, i) => {
            if (!q) return null;
            const a = answerText(q, fallbackAnswer);
            return (
              <React.Fragment key={q.name || i}>
                <Bubble side="bot">{q.title || q.name}</Bubble>
                {a && <Bubble side="user">{a}</Bubble>}
              </React.Fragment>
            );
          })}

          {/* Pregunta actual */}
          {typing ? (
            <Bubble side="bot">
              <Typing />
            </Bubble>
          ) : (
            currentQ && (
              <>
                <Bubble side="bot">
                  <div>{currentQ.title || currentQ.name}</div>
                  {currentQ.description && (
                    <div className="enc-chat-desc">{currentQ.description}</div>
                  )}
                </Bubble>
                <div className="enc-chat-compose">
                  {/* SurveyJS renderiza SOLO el input de la pregunta actual (el
                      título/num/nav quedan ocultos por CSS). */}
                  <Survey model={model} />
                  <div className="enc-chat-actions">
                    {curIdx > 0 && (
                      <button
                        type="button"
                        onClick={back}
                        className="enc-chat-back"
                        aria-label={t("public.chat.back")}
                        title={t("public.chat.back")}
                      >
                        <ArrowLeft size={18} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={advance}
                      className="enc-chat-send"
                      style={{ backgroundColor: accent }}
                    >
                      {isLastQ ? t("public.chat.send") : t("public.chat.next")}
                      <Send size={16} />
                    </button>
                  </div>
                </div>
              </>
            )
          )}
        </div>
      </div>
      <div className="enc-chat-progress" aria-hidden>
        {t("public.chat.progress", { n: Math.min(curIdx + 1, total), total })}
      </div>
    </div>
  );
}

function Bubble({ side, children }: { side: "bot" | "user"; children: React.ReactNode }) {
  return (
    <div className={`enc-bubble-row enc-bubble-${side}`}>
      <div className="enc-bubble">{children}</div>
    </div>
  );
}

function Typing() {
  return (
    <span className="enc-typing" aria-label="…">
      <span />
      <span />
      <span />
    </span>
  );
}

function chatCss(accent: string, dark: boolean): string {
  const botBg = dark ? "#232833" : "#ffffff";
  const botFg = dark ? "#e5e7eb" : "#1f2937";
  const composeBg = dark ? "#1c2029" : "#ffffff";
  const ring = dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.06)";
  return `
.enc-chat { position:relative; display:flex; flex-direction:column; min-height:100dvh; }
.enc-chat.enc-chat-embed { min-height:0; height:100%; }
.enc-chat-scroll { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
.enc-chat-thread {
  max-width:640px; margin:0 auto; width:100%;
  padding:24px 16px 140px; display:flex; flex-direction:column; gap:12px;
}
.enc-bubble-row { display:flex; }
.enc-bubble-row.enc-bubble-user { justify-content:flex-end; }
.enc-bubble {
  max-width:82%; padding:12px 15px; border-radius:18px; font-size:15px;
  line-height:1.45; box-shadow:0 1px 2px ${ring}; animation:enc-pop .28s cubic-bezier(.22,.61,.36,1);
  word-break:break-word; white-space:pre-wrap;
}
.enc-bubble-bot .enc-bubble {
  background:${botBg}; color:${botFg}; border-bottom-left-radius:6px;
}
.enc-bubble-user .enc-bubble {
  background:${accent}; color:#fff; border-bottom-right-radius:6px;
}
.enc-chat-desc { margin-top:4px; font-size:13px; opacity:.7; }
@keyframes enc-pop { from { opacity:0; transform:translateY(8px) scale(.98); } to { opacity:1; transform:none; } }

/* Indicador de "escribiendo…" */
.enc-typing { display:inline-flex; gap:4px; align-items:center; height:10px; }
.enc-typing span {
  width:7px; height:7px; border-radius:50%;
  background:${dark ? "#8a93a3" : "#9aa2ad"}; display:inline-block;
  animation:enc-typing 1s infinite ease-in-out;
}
.enc-typing span:nth-child(2) { animation-delay:.15s; }
.enc-typing span:nth-child(3) { animation-delay:.3s; }
@keyframes enc-typing { 0%,60%,100% { transform:translateY(0); opacity:.5; } 30% { transform:translateY(-4px); opacity:1; } }

/* Compositor: la tarjeta con el input de la pregunta actual + acciones. */
.enc-chat-compose {
  margin-top:4px; background:${composeBg}; border-radius:16px;
  box-shadow:0 2px 12px ${ring}; padding:8px 12px 12px;
}
.enc-chat-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:6px; }
.enc-chat-back {
  display:grid; place-items:center; width:40px; height:40px; border-radius:12px;
  color:${dark ? "#9aa2ad" : "#6b7280"}; background:transparent;
}
.enc-chat-back:hover { background:${dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.04)"}; }
.enc-chat-send {
  display:inline-flex; align-items:center; gap:8px; min-height:44px;
  padding:0 18px; border-radius:12px; color:#fff; font-weight:600; font-size:15px;
  box-shadow:0 6px 16px ${accent}44; transition:transform .12s, filter .12s;
}
.enc-chat-send:hover { filter:brightness(1.05); }
.enc-chat-send:active { transform:scale(.97); }

.enc-chat-progress {
  position:absolute; top:10px; left:50%; transform:translateX(-50%);
  font-size:12px; font-weight:600; letter-spacing:.02em;
  color:${dark ? "#9aa2ad" : "#6b7280"};
  background:${dark ? "rgba(28,32,41,.85)" : "rgba(255,255,255,.85)"};
  padding:3px 10px; border-radius:999px; backdrop-filter:blur(6px);
  box-shadow:0 1px 3px ${ring}; z-index:40;
}

/* Ocultar el chrome de SurveyJS: mostramos SOLO el input; título, número,
   descripción y navegación los renderizamos nosotros (o los reemplazan las
   burbujas). Los mensajes de error de validación SÍ quedan visibles. */
.enc-chat .sd-title,
.enc-chat .sd-description,
.enc-chat .sd-header,
.enc-chat .sd-page__title,
.enc-chat .sd-page__description,
.enc-chat .sd-question__header,
.enc-chat .sd-question__num,
.enc-chat .sd-navigation,
.enc-chat .sd-action-bar,
.enc-chat .sd-progress,
.enc-chat .sd-progress-buttons,
.enc-chat .sd-body__navigation { display:none !important; }
.enc-chat .sd-root-modern,
.enc-chat .sd-container-modern,
.enc-chat .sd-body,
.enc-chat .sd-page,
.enc-chat .sd-row,
.enc-chat .sd-question,
.enc-chat .sd-element__content,
.enc-chat .sd-question__content {
  background:transparent !important; box-shadow:none !important;
  margin:0 !important; padding:0 !important; min-width:0 !important;
}
.enc-chat .sd-body { max-width:100% !important; }
`;
}
