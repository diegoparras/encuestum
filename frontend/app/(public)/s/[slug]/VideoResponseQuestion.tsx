"use client";

// Tipo de pregunta propio de SurveyJS: "videoresponse".
//
// Permite al respondiente GRABAR un video con la webcam (estilo Typeform) o
// subir un archivo de video. Reemplaza el uso del tipo "file" con cámara, que
// en los navegadores solo captura FOTOS y por eso el video quedaba roto.
//
// El `value` de la pregunta es un string = URL pública del video ya subido.
// Cuando no hay slug (vista previa del editor) el value es un object URL local
// y no se sube nada.

import { Question, ElementFactory, Serializer } from "survey-core";
import { ReactQuestionFactory, SurveyQuestionElementBase } from "survey-react-ui";
import { createElement, useEffect, useRef, useState } from "react";
import {
  Video,
  Circle,
  Square,
  Upload,
  RotateCcw,
  Trash2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { uploadRespondentFile } from "./uploadFile";

// ---------------------------------------------------------------------------
// Modelo de pregunta
// ---------------------------------------------------------------------------

// Tipo mínimo: el valor es siempre un string (URL) o vacío. SurveyJS se encarga
// de validar "requerido" cuando el value está vacío, así que no hace falta
// lógica extra acá.
class QuestionVideoResponseModel extends Question {
  getType() {
    return "videoresponse";
  }
}

// ---------------------------------------------------------------------------
// Renderer (clase que exige survey-react-ui) → delega en un subcomponente
// funcional para poder usar hooks sin pelear con el ciclo de vida de la clase.
// ---------------------------------------------------------------------------

class SurveyQuestionVideoResponseRenderer extends SurveyQuestionElementBase {
  constructor(props: any) {
    super(props);
  }

  get question(): QuestionVideoResponseModel {
    return this.questionBase as QuestionVideoResponseModel;
  }

  protected renderElement(): React.JSX.Element {
    return createElement(VideoRecorder, { question: this.question });
  }
}

// ---------------------------------------------------------------------------
// Componente de UI
// ---------------------------------------------------------------------------

type RecorderState =
  | "idle"
  | "preview" // cámara encendida, esperando que toques REC
  | "recording"
  | "recorded"
  | "uploading"
  | "done"
  | "error"
  | "denied";

const ACCENT = "#8faf0e"; // coral primario
const REC_RED = "#ef4444"; // rojo para grabar/detener
const MAX_SECONDS = 120; // tope de grabación (2 minutos)

// Elige el primer mimeType de video soportado por MediaRecorder.
function pickMimeType(): string | undefined {
  if (
    typeof window === "undefined" ||
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* algunos navegadores tiran al testear tipos raros; seguimos probando */
    }
  }
  return undefined;
}

function formatTime(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mm}:${ss}`;
}

function VideoRecorder({ question }: { question: QuestionVideoResponseModel }) {
  // Valor ya guardado (URL pública o object URL de vista previa).
  const savedValue = typeof question.value === "string" ? question.value : "";

  const [state, setState] = useState<RecorderState>(
    savedValue ? "done" : "idle"
  );
  const [elapsed, setElapsed] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Refs de recursos que hay que limpiar.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const livePreviewRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Object URL de la preview local: lo revocamos al reemplazarlo/desmontar.
  const objectUrlRef = useRef<string | null>(null);
  // Si el value es un object URL creado en modo vista previa, lo revocamos al
  // desmontar. Guardamos su referencia para no revocar URLs públicas.
  const previewValueUrlRef = useRef<string | null>(null);

  // Corta el stream de la cámara/micrófono si sigue activo.
  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  function clearTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function revokeObjectUrl() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  // Limpieza total al desmontar: tracks activos + object URLs.
  useEffect(() => {
    return () => {
      clearTimer();
      stopStream();
      revokeObjectUrl();
      if (previewValueUrlRef.current) {
        URL.revokeObjectURL(previewValueUrlRef.current);
        previewValueUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Conectamos el stream al <video> en vivo mientras la cámara está encendida
  // (tanto en "preview" como en "recording").
  useEffect(() => {
    if (
      (state === "preview" || state === "recording") &&
      livePreviewRef.current &&
      streamRef.current
    ) {
      livePreviewRef.current.srcObject = streamRef.current;
      livePreviewRef.current.play().catch(() => {
        /* algunos navegadores requieren gesto del usuario; ignoramos */
      });
    }
  }, [state]);

  // ----- Acciones -----

  // Paso 1: encender la cámara y mostrar el preview en vivo (todavía NO graba).
  async function startCamera() {
    setErrorMsg("");
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      setErrorMsg("Tu navegador no permite grabar video. Podés subir un archivo.");
      setState("denied");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      streamRef.current = stream;
      setState("preview");
    } catch {
      stopStream();
      setErrorMsg("No pudimos acceder a la cámara. Podés subir un archivo.");
      setState("denied");
    }
  }

  // Paso 2: empezar a grabar sobre el stream ya encendido.
  function beginRecording() {
    const stream = streamRef.current;
    if (!stream) {
      startCamera();
      return;
    }
    // La construcción/arranque del MediaRecorder puede tirar (codec no
    // soportado, stream inactivo). Nunca fallar en silencio: probamos con el
    // mimeType elegido, caemos al default del navegador, y si aun así falla
    // mostramos el error.
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream); // fallback sin mimeType
      }
    } catch (err) {
      console.error("[encuestum] MediaRecorder no disponible:", err);
      stopStream();
      setErrorMsg("Tu navegador no pudo iniciar la grabación. Podés subir un archivo.");
      setState("denied");
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = (e: any) => {
      console.error("[encuestum] error de MediaRecorder:", e?.error || e);
      clearTimer();
      stopStream();
      setErrorMsg("Falló la grabación. Probá de nuevo o subí un archivo.");
      setState("error");
    };
    recorder.onstop = () => {
      clearTimer();
      const type = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      // Cortamos la cámara: ya tenemos el blob.
      stopStream();
      if (blob.size === 0) {
        console.error("[encuestum] grabación vacía (0 bytes)");
        setErrorMsg("No se capturó video. Probá de nuevo o subí un archivo.");
        setState("error");
        return;
      }
      blobRef.current = blob;
      revokeObjectUrl();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setRecordedUrl(url);
      setState("recorded");
      // Subida automática: la respuesta queda registrada sin pasos extra. El
      // respondiente igual puede "Grabar de nuevo" o "Quitar" después.
      upload(blob as Blob & { type: string; size: number });
    };

    // Timeslice de 1s: junta datos progresivamente (más robusto en grabaciones
    // cortas y evita que el blob quede vacío).
    try {
      recorder.start(1000);
    } catch (err) {
      console.error("[encuestum] recorder.start falló:", err);
      stopStream();
      setErrorMsg("No se pudo iniciar la grabación. Podés subir un archivo.");
      setState("denied");
      return;
    }
    setElapsed(0);
    setState("recording");

    clearTimer();
    timerRef.current = setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 1;
        if (next >= MAX_SECONDS) stopRecording();
        return next;
      });
    }, 1000);
  }

  // Cancela el preview antes de grabar (apaga la cámara).
  function cancelPreview() {
    stopStream();
    setState("idle");
  }

  function stopRecording() {
    clearTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.requestData?.(); // vuelca el buffer pendiente antes de frenar
      } catch {
        /* opcional; algunos navegadores lo hacen solos en stop() */
      }
      try {
        rec.stop(); // dispara onstop → sube y registra
      } catch {
        stopStream();
        setState("idle");
      }
    }
  }

  function discardRecording() {
    revokeObjectUrl();
    setRecordedUrl(null);
    blobRef.current = null;
    chunksRef.current = [];
    setElapsed(0);
    setState("idle");
  }

  // Sube un Blob (grabación) o File (archivo elegido) y guarda la URL.
  async function upload(source: Blob & { type: string; size: number }) {
    setErrorMsg("");
    setState("uploading");
    const slug = (question.survey as any)?.getVariable?.("encSlug") as
      | string
      | undefined;

    // Vista previa del builder: no hay slug → no subimos, mostramos local.
    if (!slug) {
      revokeObjectUrl();
      const localUrl = URL.createObjectURL(source);
      previewValueUrlRef.current = localUrl;
      question.value = localUrl;
      setState("done");
      return;
    }

    try {
      const url = await uploadRespondentFile(slug, source);
      question.value = url;
      // Ya está en el servidor: liberamos las previews locales.
      revokeObjectUrl();
      setRecordedUrl(null);
      setState("done");
    } catch {
      setErrorMsg("No se pudo subir. Reintentar");
      setState("error");
      toast.error("No se pudo subir el video. Probá de nuevo.");
    }
  }

  function useRecordedVideo() {
    if (blobRef.current) {
      upload(blobRef.current as Blob & { type: string; size: number });
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files && e.target.files[0];
    // Permitir re-elegir el mismo archivo después.
    e.target.value = "";
    if (!file) return;
    upload(file as File & { type: string; size: number });
  }

  // Quita el video guardado y vuelve a empezar.
  function removeSaved() {
    if (previewValueUrlRef.current) {
      URL.revokeObjectURL(previewValueUrlRef.current);
      previewValueUrlRef.current = null;
    }
    question.value = undefined;
    discardRecording();
  }

  // ----- Render -----

  // Los webm de MediaRecorder salen con duración "Infinity" y el navegador no
  // pinta ningún cuadro ni permite buscar (preview negra). El truco estándar:
  // saltar a un tiempo enorme y volver a 0 fuerza al navegador a indexar el
  // archivo, habilita la barra de progreso y muestra el primer frame.
  function forceFirstFrame(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget;
    try {
      if (v.duration === Infinity || Number.isNaN(v.duration)) {
        const reset = () => {
          v.removeEventListener("timeupdate", reset);
          v.currentTime = 0.01;
        };
        v.addEventListener("timeupdate", reset);
        v.currentTime = 1e10;
      } else if (v.currentTime < 0.04) {
        v.currentTime = 0.05;
      }
    } catch {
      /* algunos formatos no permiten seek antes de cargar; se ignora */
    }
  }

  // El box sigue el tema de la encuesta (claro/oscuro) usando las variables CSS
  // de SurveyJS, con fallback a claro.
  const boxClass =
    "flex flex-col items-center gap-3 rounded-xl border p-4";
  const surfaceStyle: React.CSSProperties = {
    backgroundColor: "var(--sjs-editorpanel-backcolor, #ffffff)",
    borderColor: "var(--sjs-border-default, rgba(0,0,0,0.12))",
    color: "var(--sjs-general-forecolor, #1f2937)",
  };
  // Botón secundario (borde) que también sigue el tema. min-h táctil (44px)
  // para que sea cómodo de tocar en el celular.
  const ghostBtnClass =
    "inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:opacity-80";
  const ghostBtnStyle: React.CSSProperties = {
    borderColor: "var(--sjs-border-default, rgba(0,0,0,0.12))",
    color: "var(--sjs-general-forecolor-light, #525252)",
  };
  const hintStyle: React.CSSProperties = {
    color: "var(--sjs-general-forecolor-light, #9ca3af)",
  };

  // Estado final: ya hay un video guardado (o preview local del editor).
  if (state === "done" && (savedValue || recordedUrl)) {
    const src = savedValue || recordedUrl || "";
    const isPreviewOnly = !!previewValueUrlRef.current;
    return (
      <div className={boxClass} style={surfaceStyle}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          controls
          playsInline
          preload="auto"
          src={src}
          onLoadedData={forceFirstFrame}
          className="w-full max-h-56 sm:max-h-72 md:max-h-80 rounded-lg bg-black"
        />
        {isPreviewOnly && (
          <p className="text-xs" style={hintStyle}>
            Vista previa (no se sube en el editor)
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={removeSaved}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[#1e2a06]"
            style={{ backgroundColor: ACCENT }}
          >
            <RotateCcw className="h-4 w-4" />
            Grabar de nuevo
          </button>
          <button
            type="button"
            onClick={removeSaved}
            className={ghostBtnClass}
            style={ghostBtnStyle}
          >
            <Trash2 className="h-4 w-4" />
            Quitar
          </button>
        </div>
      </div>
    );
  }

  // Cámara encendida, esperando que toques REC (paso 1 de 2).
  if (state === "preview") {
    return (
      <div className={boxClass} style={surfaceStyle}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={livePreviewRef}
          autoPlay
          muted
          playsInline
          className="w-full max-h-56 sm:max-h-72 md:max-h-80 rounded-lg bg-black"
        />
        <p className="text-xs" style={hintStyle}>
          Acomodate y tocá <strong>Grabar</strong> cuando estés listo.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={beginRecording}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
            style={{ backgroundColor: REC_RED }}
          >
            <Circle className="h-4 w-4" fill="currentColor" />
            Grabar
          </button>
          <button
            type="button"
            onClick={cancelPreview}
            className={ghostBtnClass}
            style={ghostBtnStyle}
          >
            <Trash2 className="h-4 w-4" />
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  // Grabando: preview en vivo + contador + detener.
  if (state === "recording") {
    return (
      <div className={boxClass} style={surfaceStyle}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={livePreviewRef}
          autoPlay
          muted
          playsInline
          className="w-full max-h-56 sm:max-h-72 md:max-h-80 rounded-lg bg-black"
        />
        <div
          className="flex items-center gap-2 text-sm font-semibold"
          style={{ color: "var(--sjs-general-forecolor, #374151)" }}
        >
          <span
            className="inline-block h-2.5 w-2.5 animate-pulse rounded-full"
            style={{ backgroundColor: REC_RED }}
            aria-hidden
          />
          <span className="tabular-nums">
            {formatTime(elapsed)} / {formatTime(MAX_SECONDS)}
          </span>
        </div>
        <button
          type="button"
          onClick={stopRecording}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: REC_RED }}
        >
          <Square className="h-4 w-4" fill="currentColor" />
          Detener
        </button>
      </div>
    );
  }

  // Grabado: preview local + usar / descartar.
  if (state === "recorded" && recordedUrl) {
    return (
      <div className={boxClass} style={surfaceStyle}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          controls
          playsInline
          preload="auto"
          src={recordedUrl}
          onLoadedData={forceFirstFrame}
          className="w-full max-h-56 sm:max-h-72 md:max-h-80 rounded-lg bg-black"
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={useRecordedVideo}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[#1e2a06]"
            style={{ backgroundColor: ACCENT }}
          >
            <Upload className="h-4 w-4" />
            Usar este video
          </button>
          <button
            type="button"
            onClick={discardRecording}
            className={ghostBtnClass}
            style={ghostBtnStyle}
          >
            <RotateCcw className="h-4 w-4" />
            Descartar
          </button>
        </div>
      </div>
    );
  }

  // Subiendo.
  if (state === "uploading") {
    return (
      <div className={boxClass} style={surfaceStyle}>
        <div
          className="flex items-center gap-3 py-6 text-sm font-medium"
          style={{ color: "var(--sjs-general-forecolor, #525252)" }}
        >
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: ACCENT }} />
          Subiendo…
        </div>
      </div>
    );
  }

  // Error de subida: reintentar.
  if (state === "error") {
    return (
      <div className={boxClass} style={surfaceStyle}>
        <p className="text-sm" style={ghostBtnStyle}>
          {errorMsg || "No se pudo subir."}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {blobRef.current && (
            <button
              type="button"
              onClick={useRecordedVideo}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[#1e2a06]"
              style={{ backgroundColor: ACCENT }}
            >
              <RotateCcw className="h-4 w-4" />
              Reintentar
            </button>
          )}
          <button
            type="button"
            onClick={discardRecording}
            className={ghostBtnClass}
            style={ghostBtnStyle}
          >
            <Trash2 className="h-4 w-4" />
            Descartar
          </button>
        </div>
      </div>
    );
  }

  // Permisos denegados / sin cámara: solo subir archivo.
  if (state === "denied") {
    return (
      <div className={boxClass} style={surfaceStyle}>
        <p className="text-center text-sm" style={ghostBtnStyle}>
          {errorMsg ||
            "No pudimos acceder a la cámara. Podés subir un archivo."}
        </p>
        <label
          className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:opacity-80"
          style={ghostBtnStyle}
        >
          <Upload className="h-4 w-4" />
          Subir archivo
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={onFileChosen}
          />
        </label>
      </div>
    );
  }

  // idle: grabar o subir.
  return (
    <div className={boxClass} style={surfaceStyle}>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={startCamera}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-[#1e2a06]"
          style={{ backgroundColor: ACCENT }}
        >
          <Video className="h-4 w-4" />
          Grabar video
        </button>
        <label
          className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-medium hover:opacity-80"
          style={ghostBtnStyle}
        >
          <Upload className="h-4 w-4" />
          Subir archivo
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={onFileChosen}
          />
        </label>
      </div>
      <p className="flex items-center gap-1.5 text-xs" style={hintStyle}>
        <Circle className="h-3 w-3" style={{ color: REC_RED }} fill="currentColor" />
        Grabá hasta {MAX_SECONDS / 60} minutos con tu webcam
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registro (idempotente)
// ---------------------------------------------------------------------------

let registered = false;

export function registerVideoResponseQuestion(): void {
  if (registered) return;
  registered = true;

  // 1) Modelo de pregunta.
  ElementFactory.Instance.registerElement(
    "videoresponse",
    (name) => new QuestionVideoResponseModel(name)
  );

  // 2) Serialización (para que SurveyJS pueda parsear/guardar el JSON).
  Serializer.addClass(
    "videoresponse",
    [],
    () => new QuestionVideoResponseModel(""),
    "question"
  );

  // 3) Renderer React.
  ReactQuestionFactory.Instance.registerQuestion("videoresponse", (props) =>
    createElement(SurveyQuestionVideoResponseRenderer, props)
  );
}
