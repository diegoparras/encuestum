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
  | "recording"
  | "recorded"
  | "uploading"
  | "done"
  | "error"
  | "denied";

const ACCENT = "#e25a4e"; // coral primario
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

  // Cuando entramos a "recording", conectamos el stream al <video> en vivo.
  useEffect(() => {
    if (state === "recording" && livePreviewRef.current && streamRef.current) {
      livePreviewRef.current.srcObject = streamRef.current;
      livePreviewRef.current.play().catch(() => {
        /* algunos navegadores requieren gesto del usuario; ignoramos */
      });
    }
  }, [state]);

  // ----- Acciones -----

  async function startRecording() {
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

      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        clearTimer();
        const type = recorder.mimeType || mimeType || "video/webm";
        const blob = new Blob(chunksRef.current, { type });
        blobRef.current = blob;
        // Cortamos la cámara: ya tenemos el blob.
        stopStream();
        revokeObjectUrl();
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setRecordedUrl(url);
        setState("recorded");
      };

      recorder.start();
      setElapsed(0);
      setState("recording");

      // Contador + auto-stop al llegar al tope.
      clearTimer();
      timerRef.current = setInterval(() => {
        setElapsed((prev) => {
          const next = prev + 1;
          if (next >= MAX_SECONDS) {
            stopRecording();
          }
          return next;
        });
      }, 1000);
    } catch {
      // getUserMedia rechazado o sin dispositivo.
      stopStream();
      setErrorMsg(
        "No pudimos acceder a la cámara. Podés subir un archivo."
      );
      setState("denied");
    }
  }

  function stopRecording() {
    clearTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop(); // dispara onstop → pasa a "recorded"
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

  const boxClass =
    "flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4";

  // Estado final: ya hay un video guardado (o preview local del editor).
  if (state === "done" && (savedValue || recordedUrl)) {
    const src = savedValue || recordedUrl || "";
    const isPreviewOnly = !!previewValueUrlRef.current;
    return (
      <div className={boxClass}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          controls
          src={src}
          className="w-full max-h-80 rounded-lg bg-black"
        />
        {isPreviewOnly && (
          <p className="text-xs text-neutral-400">
            Vista previa (no se sube en el editor)
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={removeSaved}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ backgroundColor: ACCENT }}
          >
            <RotateCcw className="h-4 w-4" />
            Grabar de nuevo
          </button>
          <button
            type="button"
            onClick={removeSaved}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            <Trash2 className="h-4 w-4" />
            Quitar
          </button>
        </div>
      </div>
    );
  }

  // Grabando: preview en vivo + contador + detener.
  if (state === "recording") {
    return (
      <div className={boxClass}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={livePreviewRef}
          autoPlay
          muted
          playsInline
          className="w-full max-h-80 rounded-lg bg-black"
        />
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-700">
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
          className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-white"
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
      <div className={boxClass}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          controls
          src={recordedUrl}
          className="w-full max-h-80 rounded-lg bg-black"
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={useRecordedVideo}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ backgroundColor: ACCENT }}
          >
            <Upload className="h-4 w-4" />
            Usar este video
          </button>
          <button
            type="button"
            onClick={discardRecording}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
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
      <div className={boxClass}>
        <div className="flex items-center gap-3 py-6 text-sm font-medium text-neutral-600">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: ACCENT }} />
          Subiendo…
        </div>
      </div>
    );
  }

  // Error de subida: reintentar.
  if (state === "error") {
    return (
      <div className={boxClass}>
        <p className="text-sm text-neutral-600">
          {errorMsg || "No se pudo subir."}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {blobRef.current && (
            <button
              type="button"
              onClick={useRecordedVideo}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: ACCENT }}
            >
              <RotateCcw className="h-4 w-4" />
              Reintentar
            </button>
          )}
          <button
            type="button"
            onClick={discardRecording}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
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
      <div className={boxClass}>
        <p className="text-center text-sm text-neutral-600">
          {errorMsg ||
            "No pudimos acceder a la cámara. Podés subir un archivo."}
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
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
    <div className={boxClass}>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={startRecording}
          className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-white"
          style={{ backgroundColor: ACCENT }}
        >
          <Video className="h-4 w-4" />
          Grabar video
        </button>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
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
      <p className="flex items-center gap-1.5 text-xs text-neutral-400">
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
