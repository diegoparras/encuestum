"use client";

import React, { useEffect, useRef, useState } from "react";
import type { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { ArrowLeft, Send } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_CHAT, type ChatOptions } from "../../../(survey-builder)/builder/model";
import { resolveAssetUrl } from "../../../(survey-builder)/builder/design";
import { resolveChatSkin, type ChatTheme } from "./chatSkins";

// Skin conversacional (estilo mensajería) montado ENCIMA de SurveyJS: una
// pregunta por vez como burbuja de "bot", respuestas previas como transcript,
// y las opciones/puntaje como "quick replies" (chips tocables) en vez del input
// nativo. Reusa el modelo de SurveyJS (validación, tipos, corrección, uploads y
// submit por onComplete); sólo cambia la PRESENTACIÓN. Totalmente customizable
// vía ChatOptions (skin, identidad del bot, comportamiento).

interface Props {
  model: Model;
  accent: string;
  dark: boolean;
  options?: ChatOptions | null;
  embedded?: boolean;
  // Cierre como última burbuja del bot (modo chat con thankYou.chatMode="bubble").
  finished?: boolean;
  finishMessage?: string;
  finishCtas?: { label: string; url: string }[] | null;
}

// Tipos que se contestan tocando (chips). El texto libre usa el input nativo.
function chipItems(q: any): { items: { value: any; text: string }[]; multi: boolean } | null {
  if (!q) return null;
  const type = q.getType?.();
  const toItem = (c: any) => ({
    value: c?.value !== undefined ? c.value : c,
    text: String(c?.text ?? c?.value ?? c),
  });
  if (type === "radiogroup" || type === "dropdown" || type === "imagepicker") {
    const items = (q.choices || []).map(toItem);
    if (!items.length || items.length > 14) return null; // demasiadas → input nativo
    return { items, multi: false };
  }
  if (type === "checkbox") {
    const items = (q.choices || []).map(toItem);
    if (!items.length || items.length > 14) return null;
    return { items, multi: true };
  }
  if (type === "boolean") {
    return {
      items: [
        { value: true, text: q.labelTrue || "Sí" },
        { value: false, text: q.labelFalse || "No" },
      ],
      multi: false,
    };
  }
  if (type === "rating") {
    let vals: any[] = [];
    if (Array.isArray(q.rateValues) && q.rateValues.length) {
      vals = q.rateValues.map(toItem);
    } else {
      const min = typeof q.rateMin === "number" ? q.rateMin : 1;
      const max = typeof q.rateMax === "number" ? q.rateMax : 5;
      const step = q.rateStep && q.rateStep > 0 ? q.rateStep : 1;
      for (let v = min; v <= max; v += step) vals.push({ value: v, text: String(v) });
    }
    if (!vals.length || vals.length > 14) return null;
    return { items: vals, multi: false };
  }
  return null;
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

let _audioCtx: any = null;
function blip() {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    const ctx = _audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 640;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    o.stop(ctx.currentTime + 0.19);
  } catch {
    /* audio bloqueado: sin sonido */
  }
}

export function ChatSurveyView({
  model,
  accent,
  dark,
  options,
  embedded,
  finished,
  finishMessage,
  finishCtas,
}: Props) {
  const { t } = useI18n();
  const opts: ChatOptions = { ...DEFAULT_CHAT, ...(options || {}) };
  const th = resolveChatSkin(opts, accent, dark);
  const useChips = opts.quickReplies !== false;

  const [version, setVersion] = useState(0);
  const [typing, setTyping] = useState(true);
  const [finishTyping, setFinishTyping] = useState(true);
  const [pending, setPending] = useState<any>(null); // selección multi antes de enviar
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceRef = useRef<() => void>(() => {});
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    try {
      model.questionsOnPageMode = "questionPerPage";
    } catch {
      /* ya viene así */
    }
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const startTyping = (ms: number) => {
    if (!opts.typingIndicator) {
      setTyping(false);
      if (opts.sound) blip();
      return;
    }
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      setTyping(false);
      if (opts.sound) blip();
    }, ms);
  };

  useEffect(() => {
    startTyping(650);
    const onValue = (_s: any, opt: any) => {
      bump();
      if (useChips) return; // los chips manejan su propio avance
      const q = (model as any).currentSingleQuestion || model.currentPage?.questions?.[0];
      if (q && q.name === opt?.name && !q.isEmpty?.() && chipItems(q)?.multi === false) {
        if (advanceTimer.current) clearTimeout(advanceTimer.current);
        if (opts.autoAdvance) {
          advanceTimer.current = setTimeout(() => {
            const cur = (model as any).currentSingleQuestion || model.currentPage?.questions?.[0];
            if (cur && cur.name === q.name && !cur.isEmpty?.()) advanceRef.current();
          }, opts.autoAdvanceMs ?? 520);
        }
      }
    };
    const onComplete = () => bump();
    model.onValueChanged.add(onValue);
    model.onComplete.add(onComplete);
    return () => {
      model.onValueChanged.remove(onValue);
      model.onComplete.remove(onComplete);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [version, typing, finishTyping]);

  // Al terminar, un breve "escribiendo…" antes de la burbuja final de gracias.
  useEffect(() => {
    if (!finished) return;
    if (!opts.typingIndicator) {
      setFinishTyping(false);
      if (opts.sound) blip();
      return;
    }
    setFinishTyping(true);
    const id = setTimeout(() => {
      setFinishTyping(false);
      if (opts.sound) blip();
    }, 700);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

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
      if (cur?.validate && !cur.validate(true)) {
        bump();
        return;
      }
      const qs = visibleQuestions();
      const idx = cur ? qs.findIndex((q) => q.name === cur.name) : 0;
      setPending(null);
      if (idx >= qs.length - 1) {
        model.completeLastPage();
      } else {
        model.nextPage();
        startTyping(600);
      }
      bump();
    } catch {
      /* SurveyJS muestra los errores in-place */
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
        setPending(null);
        model.prevPage();
        bump();
      }
    } catch {
      /* ignore */
    }
  }

  // Chip de opción única: setea el valor y avanza (con un pequeño resalte).
  function pickSingle(q: any, value: any) {
    try {
      q.value = value;
      bump();
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => advanceRef.current(), 380);
    } catch {
      /* ignore */
    }
  }
  // Chip multi: acumula selección; se confirma con "Enviar".
  function toggleMulti(q: any, value: any) {
    const arr: any[] = Array.isArray(pending) ? [...pending] : Array.isArray(q.value) ? [...q.value] : [];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(value);
    setPending(arr);
    try {
      q.value = arr;
    } catch {
      /* ignore */
    }
    bump();
  }

  void version;
  const allQ = visibleQuestions();
  const currentQ = currentQuestion();
  const curIdx = currentQ ? Math.max(0, allQ.findIndex((q) => q.name === currentQ.name)) : 0;
  const total = allQ.length || 1;
  const isLastQ = curIdx >= total - 1;
  const fallbackAnswer = t("public.chat.answered");
  const chips = useChips ? chipItems(currentQ) : null;
  const showHeader = opts.showHeader !== false && (th.botName || th.botAvatar);

  // Cómo mostrar una pregunta de escala/NPS: escala en fila, slider, o chips.
  const isRating = currentQ?.getType?.() === "rating";
  const ratingStyle = opts.ratingStyle || "scale";
  const rMin = typeof currentQ?.rateMin === "number" ? currentQ.rateMin : 1;
  const rMax = typeof currentQ?.rateMax === "number" ? currentQ.rateMax : 5;
  const rStep = currentQ?.rateStep && currentQ.rateStep > 0 ? currentQ.rateStep : 1;
  let renderMode: "chips" | "scale" | "slider" | "input";
  if (isRating) {
    if (ratingStyle === "slider") renderMode = "slider";
    else if (ratingStyle === "chips") renderMode = chips ? "chips" : "slider";
    else renderMode = chips ? "scale" : "slider"; // "scale" por defecto
  } else {
    renderMode = chips ? "chips" : "input";
  }
  const showSend = renderMode === "input" || renderMode === "slider" || (renderMode === "chips" && !!chips?.multi);

  const density = opts.density === "compact" ? 8 : 12;

  return (
    <div
      className={`enc-chat enc-chat-${opts.skin}${th.layout === "channel" ? " enc-chat-channel" : ""}${
        embedded ? " enc-chat-embed" : ""
      }`}
    >
      <style>{chatCss(th, density)}</style>

      {showHeader && (
        <div className="enc-chat-header">
          <Avatar avatar={th.botAvatar} />
          <div className="enc-chat-hmeta">
            <div className="enc-chat-hname">{th.botName}</div>
            {(th.botStatus || th.online) && (
              <div className="enc-chat-hstatus">
                {th.online && <span className="enc-chat-dot" />}
                {th.botStatus}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="enc-chat-scroll" ref={scrollRef}>
        <div className="enc-chat-thread">
          {/* Transcript (al terminar mostramos TODAS las respondidas) */}
          {(finished ? allQ : allQ.slice(0, curIdx)).map((q, i) => {
            if (!q) return null;
            const a = answerText(q, fallbackAnswer);
            return (
              <React.Fragment key={q.name || i}>
                <Row side="bot" th={th}>
                  {q.title || q.name}
                </Row>
                {a && (
                  <Row side="user" th={th} receipts={opts.readReceipts}>
                    {a}
                  </Row>
                )}
              </React.Fragment>
            );
          })}

          {/* Burbuja final de agradecimiento (cierre en chat) */}
          {finished &&
            (finishTyping ? (
              <Row side="bot" th={th}>
                <Typing />
              </Row>
            ) : (
              <>
                <Row side="bot" th={th}>
                  {finishMessage}
                </Row>
                {finishCtas && finishCtas.filter((c) => c.label && c.url).length > 0 && (
                  <div className="enc-chat-chips">
                    {finishCtas
                      .filter((c) => c.label && c.url)
                      .map((c, i) => (
                        <a
                          key={i}
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="enc-chip"
                        >
                          {c.label}
                        </a>
                      ))}
                  </div>
                )}
              </>
            ))}

          {/* Pregunta actual */}
          {!finished &&
            (typing ? (
            <Row side="bot" th={th}>
              <Typing />
            </Row>
          ) : (
            currentQ && (
              <>
                <Row side="bot" th={th}>
                  <div>{currentQ.title || currentQ.name}</div>
                  {currentQ.description && <div className="enc-chat-desc">{currentQ.description}</div>}
                </Row>

                {renderMode === "scale" && chips ? (
                  <div>
                    <div className="enc-scale">
                      {chips.items.map((it, i) => (
                        <button
                          key={i}
                          type="button"
                          className={`enc-scale-btn${currentQ.value === it.value ? " enc-scale-on" : ""}`}
                          onClick={() => pickSingle(currentQ, it.value)}
                        >
                          {it.text}
                        </button>
                      ))}
                    </div>
                    {(currentQ.minRateDescription || currentQ.maxRateDescription) && (
                      <div className="enc-scale-labels">
                        <span>{currentQ.minRateDescription}</span>
                        <span>{currentQ.maxRateDescription}</span>
                      </div>
                    )}
                  </div>
                ) : renderMode === "slider" ? (
                  <div className="enc-slider-wrap">
                    <div className="enc-slider-val">
                      {typeof currentQ.value === "number" ? currentQ.value : "—"}
                    </div>
                    <input
                      type="range"
                      className="enc-slider"
                      min={rMin}
                      max={rMax}
                      step={rStep}
                      value={typeof currentQ.value === "number" ? currentQ.value : rMin}
                      onChange={(e) => {
                        currentQ.value = Number(e.target.value);
                        bump();
                      }}
                    />
                    <div className="enc-slider-labels">
                      <span>{currentQ.minRateDescription ?? rMin}</span>
                      <span>{currentQ.maxRateDescription ?? rMax}</span>
                    </div>
                  </div>
                ) : renderMode === "chips" && chips ? (
                  <div className="enc-chat-chips">
                    {chips.items.map((it, i) => {
                      const selected = chips.multi
                        ? Array.isArray(currentQ.value) && currentQ.value.includes(it.value)
                        : currentQ.value === it.value;
                      return (
                        <button
                          key={i}
                          type="button"
                          className={`enc-chip${selected ? " enc-chip-on" : ""}`}
                          onClick={() =>
                            chips.multi ? toggleMulti(currentQ, it.value) : pickSingle(currentQ, it.value)
                          }
                        >
                          {it.text}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="enc-chat-compose">
                    {/* SurveyJS renderiza SOLO el input (título/num/nav ocultos por CSS). */}
                    <Survey model={model} />
                  </div>
                )}

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
                  {/* En escala/chip único, el toque ya envía: solo mostramos el
                      botón cuando hace falta confirmar (texto, slider, multi). */}
                  {showSend && (
                    <button type="button" onClick={advance} className="enc-chat-send">
                      {isLastQ ? t("public.chat.send") : t("public.chat.next")}
                      <Send size={16} />
                    </button>
                  )}
                </div>
              </>
            )
            ))}
        </div>
      </div>

      {!finished && (
        <div className="enc-chat-progress" aria-hidden>
          {t("public.chat.progress", { n: Math.min(curIdx + 1, total), total })}
        </div>
      )}
    </div>
  );
}

function Avatar({ avatar }: { avatar: string }) {
  const isImg = /^(https?:|\/)/.test(avatar);
  return (
    <div className="enc-chat-avatar">
      {isImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={resolveAssetUrl(avatar)} alt="" />
      ) : (
        <span>{avatar}</span>
      )}
    </div>
  );
}

function Row({
  side,
  th,
  receipts,
  children,
}: {
  side: "bot" | "user";
  th: ChatTheme;
  receipts?: boolean;
  children: React.ReactNode;
}) {
  if (th.layout === "channel") {
    // Estilo Slack/Discord: avatar + nombre + texto, siempre a la izquierda.
    return (
      <div className="enc-msg">
        <Avatar avatar={side === "user" ? "🙂" : th.botAvatar} />
        <div className="enc-msg-body">
          <div className="enc-msg-name">{side === "user" ? "Vos" : th.botName}</div>
          <div className="enc-msg-text">{children}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`enc-bubble-row enc-bubble-${side}`}>
      <div className="enc-bubble">
        {children}
        {side === "user" && receipts && <span className="enc-receipt">✓✓</span>}
      </div>
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

function chatCss(th: ChatTheme, gap: number): string {
  const font = th.fontFamily ? `font-family:${th.fontFamily};` : "";
  const bgPattern = th.pattern ? `background-image:${th.pattern};` : "";
  return `
.enc-chat { position:relative; display:flex; flex-direction:column; min-height:100dvh; overflow-x:hidden; ${font} background:${th.pageBg}; ${bgPattern} }
.enc-chat.enc-chat-embed { min-height:0; height:100%; }
.enc-chat-scroll { flex:1; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; }
.enc-chat-thread { max-width:640px; margin:0 auto; width:100%; min-width:0; box-sizing:border-box; padding:20px 16px 56px; display:flex; flex-direction:column; gap:${gap}px; }
/* Inputs a 16px: evita el zoom automático de iOS al enfocar en el celular. */
.enc-chat input, .enc-chat textarea, .enc-chat select, .enc-chat .sd-input { font-size:16px !important; }

/* Header */
.enc-chat-header { display:flex; align-items:center; gap:10px; padding:10px 16px; background:${th.headerBg}; color:${th.headerFg}; box-shadow:0 1px 6px rgba(0,0,0,.08); position:relative; z-index:5; }
.enc-chat-hname { font-weight:600; font-size:15px; }
.enc-chat-hstatus { font-size:12px; color:${th.headerSubFg}; display:flex; align-items:center; gap:5px; }
.enc-chat-dot { width:7px; height:7px; border-radius:50%; background:#22c55e; display:inline-block; }
.enc-chat-avatar { width:38px; height:38px; border-radius:50%; overflow:hidden; display:grid; place-items:center; font-size:20px; background:rgba(127,127,127,.18); flex:0 0 auto; }
.enc-chat-avatar img { width:100%; height:100%; object-fit:cover; }

/* Burbujas */
.enc-bubble-row { display:flex; }
.enc-bubble-row.enc-bubble-user { justify-content:flex-end; }
.enc-bubble { max-width:82%; padding:10px 14px; border-radius:${th.radius}px; font-size:15px; line-height:1.45; box-shadow:0 1px 1px rgba(0,0,0,.06); word-break:break-word; white-space:pre-wrap; animation:enc-pop .26s cubic-bezier(.22,.61,.36,1); position:relative; }
.enc-bubble-bot .enc-bubble { background:${th.botBubbleBg}; color:${th.botBubbleFg}; ${th.tails ? `border-bottom-left-radius:${Math.min(6, th.radius)}px;` : ""} }
.enc-bubble-user .enc-bubble { background:${th.userBubbleBg}; color:${th.userBubbleFg}; ${th.tails ? `border-bottom-right-radius:${Math.min(6, th.radius)}px;` : ""} }
.enc-chat-desc { margin-top:4px; font-size:13px; opacity:.7; }
.enc-receipt { margin-left:6px; font-size:11px; opacity:.85; color:${th.receiptColor}; }
@keyframes enc-pop { from { opacity:0; transform:translateY(8px) scale(.98); } to { opacity:1; transform:none; } }

/* Layout canal (Slack/Discord) */
.enc-msg { display:flex; gap:10px; align-items:flex-start; }
.enc-msg-name { font-weight:600; font-size:14px; color:${th.botBubbleFg}; margin-bottom:2px; }
.enc-msg-text { font-size:15px; line-height:1.45; color:${th.botBubbleFg}; white-space:pre-wrap; word-break:break-word; }
.enc-chat-channel .enc-chat-thread { gap:${gap + 4}px; }

/* Typing */
.enc-typing { display:inline-flex; gap:4px; align-items:center; height:10px; }
.enc-typing span { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.5; display:inline-block; animation:enc-typing 1s infinite ease-in-out; }
.enc-typing span:nth-child(2){ animation-delay:.15s; } .enc-typing span:nth-child(3){ animation-delay:.3s; }
@keyframes enc-typing { 0%,60%,100%{ transform:translateY(0); opacity:.4; } 30%{ transform:translateY(-4px); opacity:1; } }

/* Quick replies (chips) */
.enc-chat-chips { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:2px; }
.enc-chip { padding:9px 15px; border-radius:999px; font-size:15px; font-weight:500; min-height:40px; background:${th.chipBg}; color:${th.chipFg}; border:1.5px solid ${th.chipBorder}; box-shadow:0 1px 2px rgba(0,0,0,.05); transition:transform .1s, filter .1s; }
.enc-chip:hover { filter:brightness(1.04); }
.enc-chip:active { transform:scale(.96); }
.enc-chip.enc-chip-on { background:${th.chipActiveBg}; color:${th.chipActiveFg}; border-color:${th.chipActiveBg}; }

/* Escala/NPS en una sola fila (siempre entra, se lee de izquierda a derecha) */
.enc-scale { display:flex; gap:6px; }
.enc-scale-btn { flex:1 1 0; min-width:0; height:44px; border-radius:10px; border:1.5px solid ${th.chipBorder}; background:${th.chipBg}; color:${th.chipFg}; font-weight:600; font-size:14px; transition:transform .1s, filter .1s; }
.enc-scale-btn:hover { filter:brightness(1.05); }
.enc-scale-btn:active { transform:scale(.93); }
.enc-scale-btn.enc-scale-on { background:${th.chipActiveBg}; color:${th.chipActiveFg}; border-color:${th.chipActiveBg}; }
.enc-scale-labels, .enc-slider-labels { display:flex; justify-content:space-between; font-size:11px; margin-top:5px; color:${th.headerSubFg}; }

/* Slider de escala/NPS */
.enc-slider-wrap { display:flex; flex-direction:column; gap:4px; padding:6px 2px; }
.enc-slider-val { text-align:center; font-size:24px; font-weight:700; color:${th.sendBg}; min-height:30px; }
.enc-slider { width:100%; height:8px; accent-color:${th.sendBg}; cursor:pointer; }

/* Compositor (input nativo para texto) */
.enc-chat-compose { margin-top:2px; background:${th.composerBg}; border-radius:16px; box-shadow:0 2px 12px rgba(0,0,0,.06); padding:8px 12px; }
.enc-chat-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:8px; }
.enc-chat-back { display:grid; place-items:center; width:40px; height:40px; border-radius:12px; color:${th.headerSubFg}; background:transparent; }
.enc-chat-back:hover { background:rgba(127,127,127,.12); }
.enc-chat-send { display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:0 18px; border-radius:12px; background:${th.sendBg}; color:${th.sendFg}; font-weight:600; font-size:15px; box-shadow:0 6px 16px rgba(0,0,0,.12); transition:transform .12s, filter .12s; }
.enc-chat-send:hover { filter:brightness(1.06); } .enc-chat-send:active { transform:scale(.97); }

.enc-chat-progress { position:absolute; top:${th.botName ? "62px" : "10px"}; left:50%; transform:translateX(-50%); font-size:12px; font-weight:600; color:${th.headerSubFg}; background:${th.botBubbleBg}; padding:3px 10px; border-radius:999px; box-shadow:0 1px 3px rgba(0,0,0,.08); z-index:4; }

/* Ocultar el chrome de SurveyJS: sólo el input. Errores de validación visibles. */
.enc-chat .sd-title, .enc-chat .sd-description, .enc-chat .sd-header, .enc-chat .sd-page__title, .enc-chat .sd-page__description, .enc-chat .sd-question__header, .enc-chat .sd-question__num, .enc-chat .sd-navigation, .enc-chat .sd-action-bar, .enc-chat .sd-progress, .enc-chat .sd-progress-buttons, .enc-chat .sd-body__navigation { display:none !important; }
.enc-chat .sd-root-modern, .enc-chat .sd-container-modern, .enc-chat .sd-body, .enc-chat .sd-page, .enc-chat .sd-row, .enc-chat .sd-question, .enc-chat .sd-element__content, .enc-chat .sd-question__content { background:transparent !important; box-shadow:none !important; margin:0 !important; padding:0 !important; min-width:0 !important; }
.enc-chat .sd-body { max-width:100% !important; }

/* ── Celular (≤640px): SÓLO aditivo, el desktop queda intacto ─────────────── */
@media (max-width:640px) {
  .enc-chat-thread { padding:16px 12px calc(28px + env(safe-area-inset-bottom)); }
  .enc-chat-header { padding:9px 12px; }
  .enc-chat-avatar { width:34px; height:34px; font-size:18px; }
  .enc-bubble { max-width:86%; }
  .enc-chat-compose { padding:8px 10px; }
  .enc-chip { padding:9px 13px; min-height:42px; }
  .enc-chat-send { flex:0 0 auto; }
  /* Chips numéricos (rating): que la escala se lea de izquierda a derecha. */
  .enc-chat-chips.enc-chips-scale { justify-content:flex-start; }
}
`;
}
