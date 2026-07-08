// Normalized builder model and the converters that keep it in sync with the
// standard SurveyJS JSON we persist. The builder edits this friendly shape; we
// serialize to SurveyJS on save and deserialize on load, so the same survey can
// always be opened in the "JSON avanzado" escape hatch or rendered publicly.

export type QuestionType =
  | "text"
  | "email"
  | "comment"
  | "radiogroup"
  | "checkbox"
  | "dropdown"
  | "rating"
  | "boolean";

export interface Choice {
  id: string;
  text: string;
}

export interface RubricItem {
  id: string;
  label: string;
  points: number;
}

export interface BuilderQuestion {
  id: string; // internal, stable across reorders (never persisted)
  type: QuestionType;
  name: string; // SurveyJS field name → response/data column
  title: string;
  description?: string;
  isRequired: boolean;
  placeholder?: string;
  choices?: Choice[]; // radiogroup | checkbox | dropdown
  rateMin?: number; // rating
  rateMax?: number; // rating
  minRateDescription?: string;
  maxRateDescription?: string;
  labelTrue?: string; // boolean
  labelFalse?: string; // boolean

  // ---- Evaluation (only meaningful when the survey is an assessment) ----
  gradable?: boolean;
  points?: number;
  grader?: "auto" | "llm";
  // deterministic (grader = auto)
  correctText?: string[]; // radiogroup/dropdown/text/email/comment: acceptable values
  correctChoices?: string[]; // checkbox: correct option texts
  correctBool?: boolean; // boolean
  correctNumber?: number; // rating
  tolerance?: number; // rating
  partialCredit?: boolean; // checkbox
  caseSensitive?: boolean; // text
  // LLM (grader = llm)
  modelAnswer?: string;
  keyConcepts?: string[];
  rubric?: RubricItem[];
}

export interface EvaluationSettings {
  enabled: boolean;
  feedbackTiming: "immediate" | "onComplete" | "never";
  passingScore: number;
  showScoreToRespondent: boolean;
  doublePass: boolean;
  reviewThreshold: number;
  integrity: {
    shuffleQuestions: boolean;
    shuffleChoices: boolean;
    timeLimitSec: number | null;
    maxAttempts: number;
  };
}

export const DEFAULT_EVALUATION: EvaluationSettings = {
  enabled: false,
  feedbackTiming: "onComplete",
  passingScore: 60,
  showScoreToRespondent: true,
  doublePass: false,
  reviewThreshold: 0.6,
  integrity: {
    shuffleQuestions: false,
    shuffleChoices: false,
    timeLimitSec: null,
    maxAttempts: 1,
  },
};

export interface BuilderState {
  title: string;
  description: string;
  accent: string;
  onePerPage: boolean; // Typeform-style one question per screen
  questions: BuilderQuestion[];
  evaluation: EvaluationSettings;
  // SurveyJS elements the visual builder can't represent (e.g. matrix, panel,
  // file upload). Carried verbatim and re-appended on save so opening a survey
  // in the visual editor never silently drops advanced JSON.
  passthrough: Record<string, any>[];
}

export interface QuestionTypeMeta {
  type: QuestionType;
  label: string;
  hint: string;
  hasChoices: boolean;
}

// Order here is the order shown in the "add question" palette.
export const QUESTION_TYPES: QuestionTypeMeta[] = [
  { type: "text", label: "Texto corto", hint: "Una línea", hasChoices: false },
  { type: "comment", label: "Texto largo", hint: "Párrafo", hasChoices: false },
  { type: "email", label: "Email", hint: "Con validación", hasChoices: false },
  { type: "radiogroup", label: "Opción única", hint: "Elegir una", hasChoices: true },
  { type: "checkbox", label: "Opción múltiple", hint: "Elegir varias", hasChoices: true },
  { type: "dropdown", label: "Desplegable", hint: "Lista larga", hasChoices: true },
  { type: "rating", label: "Escala / NPS", hint: "0 a 10", hasChoices: false },
  { type: "boolean", label: "Sí / No", hint: "Booleano", hasChoices: false },
];

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = Object.fromEntries(
  QUESTION_TYPES.map((q) => [q.type, q.label])
) as Record<QuestionType, string>;

export function typeHasChoices(type: QuestionType): boolean {
  return QUESTION_TYPES.find((q) => q.type === type)?.hasChoices ?? false;
}

const ESCRIBA_CORAL = "#e25a4e";

// Curated Escriba-suite palette (coral accent first) + neutral-diverse options.
export const ACCENT_PALETTE: { name: string; value: string }[] = [
  { name: "Coral Escriba", value: ESCRIBA_CORAL },
  { name: "Terracota", value: "#e06a3a" },
  { name: "Salmón", value: "#ef8175" },
  { name: "Violeta", value: "#8b5cf6" },
  { name: "Índigo", value: "#4f46e5" },
  { name: "Azul", value: "#3b82f6" },
  { name: "Esmeralda", value: "#10b981" },
  { name: "Ámbar", value: "#f59e0b" },
  { name: "Rosa", value: "#ec4899" },
  { name: "Grafito", value: "#334155" },
];

let _seq = 0;
function uid(prefix: string): string {
  _seq += 1;
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* fall through */
  }
  return `${prefix}_${_seq.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function newChoice(text: string): Choice {
  return { id: uid("c"), text };
}

export function newRubricItem(label: string, points: number): RubricItem {
  return { id: uid("r"), label, points };
}

// A fresh question with sensible, immediately-usable defaults per type.
export function createQuestion(type: QuestionType, index: number): BuilderQuestion {
  const base: BuilderQuestion = {
    id: uid("q"),
    type,
    name: `${type}_${index + 1}`,
    title: defaultTitle(type),
    isRequired: false,
  };

  if (typeHasChoices(type)) {
    base.choices = [newChoice("Opción 1"), newChoice("Opción 2"), newChoice("Opción 3")];
  }
  if (type === "rating") {
    base.rateMin = 0;
    base.rateMax = 10;
    base.minRateDescription = "Nada probable";
    base.maxRateDescription = "Muy probable";
  }
  if (type === "boolean") {
    base.labelTrue = "Sí";
    base.labelFalse = "No";
  }
  if (type === "comment") {
    base.placeholder = "Escribí tu respuesta…";
  }
  return base;
}

// Convert an AI-generated question into a builder question, wiring its answer
// key / rubric so it's gradable out of the box (author reviews before saving).
export function generatedToQuestion(gen: any, index: number): BuilderQuestion {
  const rawType = String(gen?.type || "comment");
  const type: QuestionType = (
    ["radiogroup", "checkbox", "comment", "text", "boolean", "rating"].includes(rawType)
      ? rawType
      : "comment"
  ) as QuestionType;

  const q = createQuestion(type, index);
  q.title = gen?.title || q.title;
  q.gradable = true;
  q.points = Number(gen?.points) || 1;

  const choiceTexts: string[] = Array.isArray(gen?.choices) ? gen.choices.map(String) : [];
  if (typeHasChoices(type) && choiceTexts.length) {
    q.choices = choiceTexts.map((t) => newChoice(t));
  }

  const correctIdx: number[] = Array.isArray(gen?.correctIndices)
    ? gen.correctIndices
    : [];

  if (type === "radiogroup" || type === "dropdown") {
    q.grader = "auto";
    q.correctText = correctIdx.length ? [choiceTexts[correctIdx[0]]].filter(Boolean) : [];
  } else if (type === "checkbox") {
    q.grader = "auto";
    q.correctChoices = correctIdx.map((i) => choiceTexts[i]).filter(Boolean);
  } else if (type === "boolean") {
    q.grader = "auto";
    q.correctBool = String(gen?.modelAnswer).toLowerCase().includes("true");
  } else if (type === "rating") {
    q.grader = "auto";
    q.correctNumber = Number(gen?.modelAnswer) || undefined;
  } else {
    q.grader = "llm";
    q.modelAnswer = gen?.modelAnswer || "";
    q.keyConcepts = Array.isArray(gen?.keyConcepts) ? gen.keyConcepts : [];
    q.rubric = Array.isArray(gen?.rubric)
      ? gen.rubric.map((r: any) => newRubricItem(r.label ?? "", Number(r.points) || 0))
      : [];
  }
  return q;
}

function defaultTitle(type: QuestionType): string {
  switch (type) {
    case "text":
      return "¿Cuál es tu respuesta?";
    case "email":
      return "¿Cuál es tu email?";
    case "comment":
      return "Contanos más";
    case "radiogroup":
      return "Elegí una opción";
    case "checkbox":
      return "Elegí las que apliquen";
    case "dropdown":
      return "Seleccioná una opción";
    case "rating":
      return "¿Qué tan probable es que nos recomiendes?";
    case "boolean":
      return "¿Estás de acuerdo?";
    default:
      return "Pregunta";
  }
}

// ---- Serialization: builder → SurveyJS JSON --------------------------------

function questionToElement(q: BuilderQuestion): Record<string, any> {
  const el: Record<string, any> = {
    type: q.type === "email" ? "text" : q.type,
    name: q.name,
    title: q.title,
  };
  if (q.description) el.description = q.description;
  if (q.isRequired) el.isRequired = true;
  if (q.type === "email") {
    el.inputType = "email";
    el.autocomplete = "email";
    el.validators = [{ type: "email" }];
  }
  if (q.placeholder) el.placeholder = q.placeholder;
  if (typeHasChoices(q.type)) {
    el.choices = (q.choices ?? []).map((c) => c.text).filter((t) => t.trim() !== "");
  }
  if (q.type === "rating") {
    el.rateMin = q.rateMin ?? 0;
    el.rateMax = q.rateMax ?? 10;
    if (q.minRateDescription) el.minRateDescription = q.minRateDescription;
    if (q.maxRateDescription) el.maxRateDescription = q.maxRateDescription;
  }
  if (q.type === "boolean") {
    el.labelTrue = q.labelTrue ?? "Sí";
    el.labelFalse = q.labelFalse ?? "No";
  }
  return el;
}

export function builderToSchema(state: BuilderState): Record<string, any> {
  return {
    title: state.title || undefined,
    description: state.description || undefined,
    showQuestionNumbers: "off",
    questionsOnPageMode: state.onePerPage ? "questionPerPage" : "singlePage",
    showProgressBar: state.onePerPage ? "top" : "off",
    progressBarType: "questions",
    widthMode: "responsive",
    completedHtml: "<h3>¡Gracias por responder! 🙌</h3>",
    pages: [
      {
        name: "page1",
        elements: [
          ...state.questions.map(questionToElement),
          ...(state.passthrough ?? []),
        ],
      },
    ],
  };
}

// ---- Deserialization: SurveyJS JSON → builder ------------------------------

function elementToQuestion(el: Record<string, any>, index: number): BuilderQuestion | null {
  const rawType = el?.type as string;
  const isEmail = rawType === "text" && el?.inputType === "email";
  const type: QuestionType = (isEmail ? "email" : rawType) as QuestionType;

  const supported: QuestionType[] = [
    "text",
    "email",
    "comment",
    "radiogroup",
    "checkbox",
    "dropdown",
    "rating",
    "boolean",
  ];
  if (!supported.includes(type)) return null;

  const q: BuilderQuestion = {
    id: uid("q"),
    type,
    name: el.name || `${type}_${index + 1}`,
    title: el.title || el.name || `Pregunta ${index + 1}`,
    description: el.description || undefined,
    isRequired: !!el.isRequired,
    placeholder: el.placeholder || undefined,
  };

  if (typeHasChoices(type) && Array.isArray(el.choices)) {
    q.choices = el.choices.map((c: any) =>
      newChoice(typeof c === "object" ? c.text ?? c.value ?? "" : String(c))
    );
  }
  if (type === "rating") {
    q.rateMin = typeof el.rateMin === "number" ? el.rateMin : 0;
    q.rateMax = typeof el.rateMax === "number" ? el.rateMax : 10;
    q.minRateDescription = el.minRateDescription || undefined;
    q.maxRateDescription = el.maxRateDescription || undefined;
  }
  if (type === "boolean") {
    q.labelTrue = el.labelTrue || "Sí";
    q.labelFalse = el.labelFalse || "No";
  }
  return q;
}

export function schemaToBuilder(
  schema: Record<string, any> | null | undefined,
  fallbackTitle: string,
  accent: string,
  evaluation?: Record<string, any> | null
): BuilderState {
  const s = schema && typeof schema === "object" ? schema : {};
  const pages = Array.isArray(s.pages) ? s.pages : [];
  const elements: any[] = pages.flatMap((p: any) =>
    Array.isArray(p?.elements) ? p.elements : []
  );

  const questions: BuilderQuestion[] = [];
  const passthrough: Record<string, any>[] = [];
  elements.forEach((el, i) => {
    const q = elementToQuestion(el, i);
    if (q) questions.push(q);
    else if (el && typeof el === "object") passthrough.push(el);
  });

  hydrateGrading(questions, evaluation);

  return {
    title: s.title || fallbackTitle || "",
    description: s.description || "",
    accent,
    onePerPage: s.questionsOnPageMode !== "singlePage",
    questions,
    evaluation: hydrateEvaluationSettings(evaluation),
    passthrough,
  };
}

function hydrateEvaluationSettings(
  evaluation?: Record<string, any> | null
): EvaluationSettings {
  if (!evaluation || typeof evaluation !== "object") {
    return { ...DEFAULT_EVALUATION, integrity: { ...DEFAULT_EVALUATION.integrity } };
  }
  return {
    enabled: !!evaluation.enabled,
    feedbackTiming: evaluation.feedbackTiming ?? "onComplete",
    passingScore: evaluation.passingScore ?? 60,
    showScoreToRespondent: evaluation.showScoreToRespondent ?? true,
    doublePass: !!evaluation.doublePass,
    reviewThreshold: evaluation.reviewThreshold ?? 0.6,
    integrity: {
      shuffleQuestions: !!evaluation.integrity?.shuffleQuestions,
      shuffleChoices: !!evaluation.integrity?.shuffleChoices,
      timeLimitSec: evaluation.integrity?.timeLimitSec ?? null,
      maxAttempts: evaluation.integrity?.maxAttempts ?? 1,
    },
  };
}

// Copy saved per-question grading config back onto the builder questions.
function hydrateGrading(
  questions: BuilderQuestion[],
  evaluation?: Record<string, any> | null
) {
  const cfgs = evaluation?.questions;
  if (!cfgs || typeof cfgs !== "object") return;
  for (const q of questions) {
    const c = cfgs[q.name];
    if (!c) continue;
    q.gradable = !!c.gradable;
    q.points = c.points ?? 1;
    q.grader = c.grader ?? "auto";
    q.caseSensitive = !!c.caseSensitive;
    q.partialCredit = !!c.partialCredit;
    q.tolerance = c.tolerance ?? 0;
    const correct = c.correct;
    if (q.type === "checkbox") {
      q.correctChoices = Array.isArray(correct) ? correct.map(String) : [];
    } else if (q.type === "boolean") {
      q.correctBool = !!correct;
    } else if (q.type === "rating") {
      q.correctNumber = typeof correct === "number" ? correct : undefined;
    } else {
      q.correctText = Array.isArray(correct)
        ? correct.map(String)
        : correct != null
        ? [String(correct)]
        : [];
    }
    q.modelAnswer = c.modelAnswer ?? "";
    q.keyConcepts = Array.isArray(c.keyConcepts) ? c.keyConcepts : [];
    q.rubric = Array.isArray(c.rubric)
      ? c.rubric.map((r: any) => newRubricItem(r.label ?? "", Number(r.points) || 0))
      : [];
  }
}

// Build the server-side evaluation payload (answer keys + rubrics + settings).
export function builderToEvaluation(
  state: BuilderState
): Record<string, any> | null {
  if (!state.evaluation.enabled) {
    // Persist a disabled flag so turning it off is saved explicitly.
    return { ...state.evaluation, questions: {} };
  }
  const questions: Record<string, any> = {};
  for (const q of state.questions) {
    if (!q.gradable) continue;
    const cfg: Record<string, any> = {
      gradable: true,
      title: q.title,
      points: q.points ?? 1,
      grader: q.grader ?? "auto",
      required: q.isRequired,
    };
    if (q.grader === "llm") {
      cfg.modelAnswer = q.modelAnswer ?? "";
      cfg.keyConcepts = q.keyConcepts ?? [];
      cfg.rubric = (q.rubric ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        points: r.points,
      }));
    } else {
      if (q.type === "checkbox") {
        cfg.correct = q.correctChoices ?? [];
        cfg.partialCredit = !!q.partialCredit;
      } else if (q.type === "boolean") {
        cfg.correct = !!q.correctBool;
      } else if (q.type === "rating") {
        cfg.correct = q.correctNumber ?? null;
        cfg.tolerance = q.tolerance ?? 0;
      } else {
        cfg.correct = q.correctText ?? [];
        cfg.caseSensitive = !!q.caseSensitive;
      }
    }
    questions[q.name] = cfg;
  }
  return { ...state.evaluation, questions };
}

// ---- Accent → SurveyJS theme ------------------------------------------------

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function shade(hex: string, percent: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const f = percent / 100;
  const t = percent < 0 ? 0 : 255;
  const p = Math.abs(f);
  const r = clampByte((t - rgb.r) * p + rgb.r);
  const g = clampByte((t - rgb.g) * p + rgb.g);
  const b = clampByte((t - rgb.b) * p + rgb.b);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** Best-effort luminance check to keep label text readable on the accent. */
export function readableForeground(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "#ffffff";
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.62 ? "#1f2937" : "#ffffff";
}

// A compact SurveyJS theme derived from a single accent color. Applied both in
// the builder preview and in the public renderer (which calls applyTheme).
export function accentToTheme(accent: string): Record<string, any> {
  const fore = readableForeground(accent);
  return {
    themeName: "escriba",
    colorPalette: "light",
    isPanelless: true,
    cssVariables: {
      "--sjs-primary-backcolor": accent,
      "--sjs-primary-backcolor-dark": shade(accent, -12),
      "--sjs-primary-backcolor-light": rgba(accent, 0.1),
      "--sjs-primary-forecolor": fore,
      "--sjs-primary-forecolor-light": rgba(fore, 0.35),
      "--sjs-general-backcolor-dim": "#f6f6f7",
      "--sjs-corner-radius": "12px",
      "--sjs-base-unit": "8px",
    },
  };
}

export interface Palette {
  accent: string;
  fg: string; // readable text color on the accent
  dark: string; // darker accent (hover / emphasis)
  strong: string; // strongest shade (headings on tint)
  light: string; // very light tint (backgrounds)
  soft: string; // soft border / divider
  ring: string; // subtle ring
}

// A full, cohesive palette derived from a single accent — used by the reports
// and insights so everything tracks "the color chosen from the deck".
export function derivePalette(accent: string): Palette {
  const safe = parseHex(accent) ? accent : ESCRIBA_CORAL;
  return {
    accent: safe,
    fg: readableForeground(safe),
    dark: shade(safe, -14),
    strong: shade(safe, -30),
    light: rgba(safe, 0.08),
    soft: rgba(safe, 0.18),
    ring: rgba(safe, 0.32),
  };
}

export function themeToAccent(theme: Record<string, any> | null | undefined): string {
  const v = theme?.cssVariables?.["--sjs-primary-backcolor"];
  if (typeof v === "string" && parseHex(v)) return v;
  return ESCRIBA_CORAL;
}

export const DEFAULT_ACCENT = ESCRIBA_CORAL;
