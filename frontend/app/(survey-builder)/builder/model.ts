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
  | "boolean"
  | "imagepicker"
  | "videoresponse"
  | "matrix"
  | "ranking"
  | "date"
  | "fileupload"
  | "section"; // separador con título: agrupa las preguntas que le siguen

export interface Choice {
  id: string;
  text: string;
  imageUrl?: string; // imagepicker: image shown for this option
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
  maxLength?: number; // text | comment: max characters allowed (0/undef = sin límite)
  choices?: Choice[]; // radiogroup | checkbox | dropdown
  rateMin?: number; // rating
  rateMax?: number; // rating
  minRateDescription?: string;
  maxRateDescription?: string;
  ratePresentation?: RatePresentation; // rating: how the scale is drawn
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

  // Optional media shown above the question. imageUrl is an asset URL; videoUrl
  // may be a YouTube/Vimeo/mp4 URL or an uploaded video asset.
  imageUrl?: string;
  videoUrl?: string;

  // imagepicker: allow selecting more than one image.
  multiSelect?: boolean;

  // Per-question style overrides (undefined = follow the global design):
  boxOpacity?: number; // 0..1 box transparency for THIS question only
  align?: "left" | "center"; // alignment for THIS question only

  // ---- matrix (grilla de opción única) ----
  matrixRows?: Choice[]; // filas de la grilla (cada una recibe una respuesta)
  matrixColumns?: Choice[]; // columnas = opciones únicas por fila

  // ---- date (fecha) ----
  dateMin?: string; // fecha mínima permitida (YYYY-MM-DD), opcional
  dateMax?: string; // fecha máxima permitida (YYYY-MM-DD), opcional

  // ---- fileupload (subir archivo genérico) ----
  fileMultiple?: boolean; // permitir subir varios archivos
  fileAccept?: string; // tipos aceptados (ej. ".pdf,.docx"); vacío = cualquiera

  // Conditional logic: show this question only when the rule holds.
  visibilityRule?: VisibilityRule;

  // Branching: when the answer matches, jump ahead (or finish the survey).
  branching?: BranchRule[];
}

// A branching (skip-logic) rule attached to a question: if the answer matches,
// jump to a later question/section or end the survey right there.
export interface BranchRule {
  id: string;
  operator: LogicOperator;
  value: string; // ignored for empty/notempty
  target: string; // question name to jump to, or "__end__" to finish
}

export const BRANCH_END = "__end__";

// How a rating/NPS scale is presented to the respondent.
export type RatePresentation =
  | "numbers" // classic number row (default)
  | "buttons" // rectangles / pill buttons
  | "buttons-color" // rectangles tinted red→green across the scale
  | "stars" // star rating
  | "smileys" // smiley faces
  | "smileys-color"; // smiley faces tinted red→green

export const RATE_PRESENTATIONS: { id: RatePresentation; label: string }[] = [
  { id: "numbers", label: "Números" },
  { id: "buttons", label: "Rectángulos" },
  { id: "buttons-color", label: "Rectángulos de colores" },
  { id: "stars", label: "Estrellas" },
  { id: "smileys", label: "Caritas" },
  { id: "smileys-color", label: "Caritas de colores" },
];

export type LogicOperator = "=" | "<>" | "contains" | ">" | "<" | "empty" | "notempty";

export interface VisibilityRule {
  questionName: string; // the question this depends on (SurveyJS name)
  operator: LogicOperator;
  value: string; // ignored for empty/notempty
}

export type Strictness = "indulgente" | "equilibrado" | "estricto";
export type FeedbackTone = "motivador" | "neutral" | "directo";

// Teacher-built grading style for the LLM corrector (the "AI grading" wizard).
export interface AiCriteria {
  enabled: boolean;
  strictness: Strictness;
  focus: string[]; // e.g. ["contenido","claridad","originalidad","ortografía"]
  tone: FeedbackTone;
  instructions: string; // free-text extra guidance
}

export const DEFAULT_AI_CRITERIA: AiCriteria = {
  enabled: false,
  strictness: "equilibrado",
  focus: [],
  tone: "neutral",
  instructions: "",
};

export interface EvaluationSettings {
  enabled: boolean;
  feedbackTiming: "immediate" | "onComplete" | "never";
  passingScore: number;
  showScoreToRespondent: boolean;
  doublePass: boolean;
  reviewThreshold: number;
  aiCriteria: AiCriteria;
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
  aiCriteria: { ...DEFAULT_AI_CRITERIA },
  integrity: {
    shuffleQuestions: false,
    shuffleChoices: false,
    timeLimitSec: null,
    maxAttempts: 1,
  },
};

export interface AudioSettings {
  url: string;
  loop: boolean;
  autoplay: boolean; // best-effort; browsers may require a tap first
  volume: number; // 0..1
}

// Visual design of the survey: typography, colors, media and music. Persisted
// inside the SurveyJS theme object (native fields + an `_encuestum` block).
export type PageTransition =
  | "none"
  | "fade"
  | "slide" // desliza desde abajo
  | "slide-left" // desliza lateral
  | "zoom"
  | "flip" // voltea levemente en 3D
  | "blur"; // entra desenfocado

export const PAGE_TRANSITIONS: { id: PageTransition; label: string }[] = [
  { id: "none", label: "Ninguna" },
  { id: "fade", label: "Fundido" },
  { id: "slide", label: "Deslizar ↑" },
  { id: "slide-left", label: "Deslizar ←" },
  { id: "zoom", label: "Zoom" },
  { id: "flip", label: "Voltear" },
  { id: "blur", label: "Desenfoque" },
];

// ── Modo conversacional (chat) ───────────────────────────────────────────────
// Skins de apariencia del chat. Cada uno define un punto de partida (colores,
// forma de burbuja, fondo, layout) que después se puede retocar.
export type ChatSkin =
  | "encuestum"
  | "whatsapp"
  | "telegram"
  | "imessage"
  | "messenger"
  | "slack"
  | "discord"
  | "terminal"
  | "minimal";

export const CHAT_SKINS: { id: ChatSkin; label: string }[] = [
  { id: "encuestum", label: "Encuestum" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "telegram", label: "Telegram" },
  { id: "imessage", label: "iMessage" },
  { id: "messenger", label: "Messenger" },
  { id: "slack", label: "Slack" },
  { id: "discord", label: "Discord" },
  { id: "terminal", label: "Terminal" },
  { id: "minimal", label: "Minimal" },
];

// Toda la personalización del chat. Se guarda en theme._encuestum.chatOptions.
export interface ChatOptions {
  skin: ChatSkin;
  // Identidad del "bot" / header del chat
  showHeader?: boolean;
  botName?: string;
  botAvatar?: string; // emoji, o URL de asset (imagen)
  botStatus?: string; // subtítulo ("en línea", "responde al instante"…)
  // Burbujas (overrides sobre el skin)
  botBubbleColor?: string;
  userBubbleColor?: string;
  bubbleRadius?: number; // px (0-24)
  tails?: boolean; // colita en las burbujas
  density?: "compact" | "cozy";
  timestamps?: boolean;
  readReceipts?: boolean; // tildes ✓✓
  // Cómo se muestra una pregunta de escala/NPS en el chat.
  ratingStyle?: "scale" | "slider" | "chips";
  // Comportamiento
  quickReplies?: boolean; // opciones/puntaje como chips tocables (no dropdown)
  typingIndicator?: boolean;
  typeOn?: boolean; // efecto de tipeo letra por letra
  autoAdvance?: boolean;
  autoAdvanceMs?: number; // delay del auto-avance (300-1500)
  sound?: boolean; // sonido al llegar cada mensaje
  enterToSend?: boolean;
}

export const DEFAULT_CHAT: ChatOptions = {
  skin: "encuestum",
  showHeader: true,
  botName: "",
  botAvatar: "",
  botStatus: "",
  tails: true,
  density: "cozy",
  ratingStyle: "scale",
  quickReplies: true,
  typingIndicator: true,
  typeOn: false,
  autoAdvance: true,
  autoAdvanceMs: 520,
  sound: false,
  timestamps: false,
  readReceipts: false,
  enterToSend: true,
};

// ── Pantalla de agradecimiento (al completar) ────────────────────────────────
// Íconos predefinidos; también se puede usar un emoji o una imagen (asset URL).
export type ThankYouIcon = "check" | "heart" | "star" | "party" | "trophy" | "none";

export const THANKYOU_ICONS: ThankYouIcon[] = ["check", "heart", "star", "party", "trophy", "none"];

export interface ThankYouCta {
  label: string;
  url: string;
}

// Efecto de festejo al aparecer la pantalla de gracias.
export type CelebrationEffect =
  | "none"
  | "confetti"
  | "emoji"
  | "fireworks"
  | "balloons"
  | "car";

export const CELEBRATIONS: CelebrationEffect[] = [
  "none",
  "confetti",
  "emoji",
  "fireworks",
  "balloons",
  "car",
];

export interface ThankYouConfig {
  title?: string; // encabezado arriba del mensaje (admite tokens {pregunta})
  icon?: string; // ThankYouIcon | emoji | asset URL de imagen
  confetti?: boolean; // LEGACY: si true y no hay `celebration`, equivale a "confetti"
  celebration?: CelebrationEffect; // efecto de festejo al completar
  celebrationEmoji?: string; // emoji para la lluvia (celebration="emoji")
  layout?: "card" | "minimal" | "hero";
  // Colores propios (opcionales; si faltan, hereda el tema de la encuesta)
  bgColor?: string;
  cardColor?: string;
  textColor?: string;
  iconColor?: string;
  image?: string; // imagen/GIF arriba del mensaje (asset URL)
  ctas?: ThankYouCta[]; // botones de acción
  share?: boolean; // fila de "compartir"
  shareText?: string;
  redirectCountdown?: number; // seg. de cuenta regresiva antes de redirigir (0 = salto directo)
  chatMode?: "bubble" | "screen"; // en modo chat: última burbuja o pantalla completa
}

export const DEFAULT_THANKYOU: ThankYouConfig = {
  title: "",
  icon: "check",
  confetti: false,
  celebration: "none",
  celebrationEmoji: "🎉",
  layout: "card",
  ctas: [],
  share: false,
  redirectCountdown: 0,
  chatMode: "bubble",
};

// Pantalla de estado personalizable (analizando / cerrada). Todo opcional: lo
// que quede vacío usa el default (mensaje traducido, colores del tema).
export interface StateScreenConfig {
  title?: string; // encabezado grande (opcional)
  message?: string; // texto principal
  emoji?: string; // emoji/ícono grande (opcional)
  bgColor?: string; // color de fondo (pisa el del tema)
  bgImage?: string; // imagen de fondo a pantalla completa (asset URL)
  textColor?: string; // color del texto (auto por fondo si se omite)
  spinner?: boolean; // "analizando": mostrar el spinner (default true)
  showReason?: boolean; // "cerrada": mostrar además el motivo automático (default true)
}

export interface DesignSettings {
  fontFamily: string; // one of FONT_OPTIONS ids
  mode?: "light" | "dark"; // color scheme of the survey (default light)
  textColor?: string; // question title/description/main text color (overrides mode default)
  transparentQuestions?: boolean; // remove the white card behind questions so the background shows through
  // Surface (color + opacity) of the question/input boxes — for glass looks.
  questionColor?: string; // hex color of the boxes (default white/dark by mode)
  questionOpacity?: number; // 0..1 opacity of the boxes (default 1)
  glass?: boolean; // frosted-glass blur behind the boxes
  // Text typed inside inputs/textareas. Default: auto-readable on the box color
  // (so a white glass box gets dark text even if the question titles are white).
  inputTextColor?: string;
  buttonColor?: string; // navigation buttons color (default: the accent)
  buttonShadow?: boolean; // drop shadow under the navigation buttons
  // Draw a subtle framed container around each question (great separator when
  // the boxes are transparent over a background).
  questionSeparator?: boolean;
  alignment?: "left" | "center"; // title/questions/buttons alignment
  pageTransition?: PageTransition; // screen transition in one-question-per-page
  chat?: boolean; // conversational (Typebot-style) chat skin for the respondent
  chatOptions?: ChatOptions; // customización del modo chat (skin, bot, comportamiento)
  thankYou?: ThankYouConfig; // pantalla de agradecimiento (ícono, confeti, CTAs, colores…)
  grading?: StateScreenConfig; // pantalla mientras se procesa/corrige (evaluaciones con IA)
  closed?: StateScreenConfig; // pantalla cuando la encuesta está cerrada (fecha/cupo/manual)
  backgroundColor?: string;
  backgroundImage?: string; // asset URL (relative /assets/…)
  backgroundOpacity: number; // 0..1
  coverImage?: string; // header/cover image (asset URL)
  logo?: string; // logo shown above the title (asset URL)
  audio?: AudioSettings | null; // background music
}

export const DEFAULT_DESIGN: DesignSettings = {
  fontFamily: "system",
  mode: "light",
  backgroundOpacity: 1,
  audio: null,
};

export interface FontOption {
  id: string;
  label: string;
  css: string; // CSS font-family value
  google?: string; // Google Fonts CSS2 spec (family:wght@...) for curated fonts
  family?: string; // raw Google family name for arbitrary (searched) fonts
  category: "sans" | "serif" | "display" | "mono" | "handwriting";
}

// A broad catalog of Google Fonts families the user can search and apply. Loaded
// on demand (see loadFont) via the tolerant v1 CSS API so missing weights never
// break the stylesheet. The curated FONT_OPTIONS above stay as quick picks.
export const GOOGLE_FONT_FAMILIES: string[] = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Raleway",
  "Nunito", "Nunito Sans", "Work Sans", "DM Sans", "Rubik", "Manrope", "Karla",
  "Mulish", "Quicksand", "Josefin Sans", "Barlow", "Barlow Condensed", "Oswald",
  "Bebas Neue", "Anton", "Archivo", "Archivo Black", "Space Grotesk", "Sora",
  "Outfit", "Figtree", "Plus Jakarta Sans", "Lexend", "Public Sans", "Red Hat Display",
  "Red Hat Text", "IBM Plex Sans", "IBM Plex Serif", "IBM Plex Mono", "Fira Sans",
  "Fira Code", "Source Sans 3", "Source Serif 4", "Source Code Pro", "PT Sans",
  "PT Serif", "Noto Sans", "Noto Serif", "Cabin", "Hind", "Titillium Web",
  "Dosis", "Comfortaa", "Kanit", "Prompt", "Mukta", "Heebo", "Assistant",
  "Signika", "Exo 2", "Teko", "Chivo", "Jost", "Urbanist", "Epilogue", "Onest",
  "Schibsted Grotesk", "Bricolage Grotesque", "Instrument Sans", "Hanken Grotesk",
  "Albert Sans", "Be Vietnam Pro", "Overpass", "Saira", "Saira Condensed",
  "Lora", "Merriweather", "Playfair Display", "PT Serif Caption", "Bitter",
  "Crimson Text", "Crimson Pro", "EB Garamond", "Cormorant", "Cormorant Garamond",
  "Libre Baskerville", "Libre Franklin", "Spectral", "Zilla Slab", "Roboto Slab",
  "Arvo", "Domine", "Frank Ruhl Libre", "Newsreader", "Fraunces", "Petrona",
  "Alegreya", "Alegreya Sans", "Vollkorn", "Cardo", "Neuton", "Gelasio",
  "DM Serif Display", "DM Serif Text", "Abril Fatface", "Bodoni Moda",
  "Marcellus", "Cinzel", "Philosopher", "Yeseva One", "Prata", "Rozha One",
  "Oxygen", "Muli", "Questrial", "Varela Round", "Baloo 2", "Fredoka",
  "Righteous", "Pacifico", "Lobster", "Caveat", "Dancing Script", "Satisfy",
  "Great Vibes", "Sacramento", "Kalam", "Shadows Into Light", "Indie Flower",
  "Permanent Marker", "Amatic SC", "Patrick Hand", "Gochi Hand", "Courgette",
  "Cookie", "Parisienne", "Allura", "Yellowtail", "Cabin Sketch",
  "Space Mono", "JetBrains Mono", "Roboto Mono", "Inconsolata", "Ubuntu Mono",
  "Ubuntu", "Rajdhani", "Orbitron", "Michroma", "Audiowide", "Russo One",
  "Chakra Petch", "Syne", "Unbounded", "Clash Display", "Gantari", "Geist",
  "Playpen Sans", "Gloock", "Della Respira", "Big Shoulders Display",
];

// Build a FontOption for an arbitrary Google family the user searched for.
function _familyFallback(css: string): string {
  const l = css.toLowerCase();
  if (/(display|black|fat|one$| one$)/.test(l)) return "sans-serif";
  return "sans-serif";
}

export function fontFromFamily(family: string): FontOption {
  return {
    id: family,
    label: family,
    css: `"${family}", ${_familyFallback(family)}`,
    family,
    category: "sans",
  };
}

// Curated typefaces. "system" needs no network; the rest load from Google Fonts.
export const FONT_OPTIONS: FontOption[] = [
  { id: "system", label: "Sistema", css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', category: "sans" },
  { id: "inter", label: "Inter", css: '"Inter", sans-serif', google: "Inter:wght@400;500;600;700", category: "sans" },
  { id: "poppins", label: "Poppins", css: '"Poppins", sans-serif', google: "Poppins:wght@400;500;600;700", category: "sans" },
  { id: "montserrat", label: "Montserrat", css: '"Montserrat", sans-serif', google: "Montserrat:wght@400;500;600;700", category: "sans" },
  { id: "nunito", label: "Nunito", css: '"Nunito", sans-serif', google: "Nunito:wght@400;600;700;800", category: "sans" },
  { id: "dmsans", label: "DM Sans", css: '"DM Sans", sans-serif', google: "DM+Sans:wght@400;500;700", category: "sans" },
  { id: "spacegrotesk", label: "Space Grotesk", css: '"Space Grotesk", sans-serif', google: "Space+Grotesk:wght@400;500;700", category: "sans" },
  { id: "lora", label: "Lora", css: '"Lora", serif', google: "Lora:wght@400;500;600;700", category: "serif" },
  { id: "merriweather", label: "Merriweather", css: '"Merriweather", serif', google: "Merriweather:wght@400;700", category: "serif" },
  { id: "playfair", label: "Playfair Display", css: '"Playfair Display", serif', google: "Playfair+Display:wght@400;600;700", category: "display" },
  { id: "caveat", label: "Caveat", css: '"Caveat", cursive', google: "Caveat:wght@400;600;700", category: "handwriting" },
  { id: "jetbrains", label: "JetBrains Mono", css: '"JetBrains Mono", monospace', google: "JetBrains+Mono:wght@400;500;700", category: "mono" },
];

export function fontById(id: string): FontOption {
  const curated = FONT_OPTIONS.find((f) => f.id === id);
  if (curated) return curated;
  // An arbitrary Google family (searched by the user) → synthesize its option.
  if (id && id !== "system") return fontFromFamily(id);
  return FONT_OPTIONS[0];
}

export function fontCssFamily(id: string): string {
  return fontById(id).css;
}

// One-click complete looks: accent + font + background. Applied over the current
// design, preserving any uploaded media (cover/logo/background image/audio).
export interface ThemePreset {
  id: string;
  name: string;
  accent: string;
  fontFamily: string;
  backgroundColor: string;
  mode?: "light" | "dark";
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: "coral", name: "Coral", accent: "#e25a4e", fontFamily: "inter", backgroundColor: "#fff7f5" },
  { id: "editorial", name: "Editorial", accent: "#1f2937", fontFamily: "playfair", backgroundColor: "#faf6ef" },
  { id: "vibrante", name: "Vibrante", accent: "#ec4899", fontFamily: "poppins", backgroundColor: "#fdf2f8" },
  { id: "corporativo", name: "Corporativo", accent: "#1d4ed8", fontFamily: "inter", backgroundColor: "#f5f8ff" },
  { id: "naturaleza", name: "Naturaleza", accent: "#10b981", fontFamily: "nunito", backgroundColor: "#f0fdf4" },
  { id: "atardecer", name: "Atardecer", accent: "#f59e0b", fontFamily: "montserrat", backgroundColor: "#fffbeb" },
  { id: "indigo", name: "Índigo", accent: "#4f46e5", fontFamily: "dmsans", backgroundColor: "#f5f5ff" },
  { id: "menta", name: "Menta", accent: "#14b8a6", fontFamily: "spacegrotesk", backgroundColor: "#f0fdfa" },
  { id: "grafito", name: "Grafito", accent: "#334155", fontFamily: "inter", backgroundColor: "#f8fafc" },
  { id: "creativo", name: "Creativo", accent: "#8b5cf6", fontFamily: "caveat", backgroundColor: "#faf5ff" },
  { id: "medianoche", name: "Medianoche", accent: "#6366f1", fontFamily: "inter", backgroundColor: "#12151b", mode: "dark" },
  { id: "neon", name: "Neón", accent: "#22d3ee", fontFamily: "spacegrotesk", backgroundColor: "#0f1117", mode: "dark" },
  { id: "carbon", name: "Carbón", accent: "#f97316", fontFamily: "montserrat", backgroundColor: "#17181c", mode: "dark" },
];

export function applyThemePreset(design: DesignSettings, preset: ThemePreset): DesignSettings {
  return {
    ...design,
    fontFamily: preset.fontFamily,
    backgroundColor: preset.backgroundColor,
    mode: preset.mode ?? "light",
    // A preset defines its own scheme; clear any manual text-color override so
    // the mode's readable default applies.
    textColor: undefined,
  };
}

export interface BuilderState {
  title: string;
  description: string;
  accent: string;
  onePerPage: boolean; // Typeform-style one question per screen
  showProgress: boolean; // show "Pregunta X de Y" (only meaningful with onePerPage)
  opensAt: string | null; // ISO datetime; la encuesta no abre hasta este momento
  closesAt: string | null; // ISO datetime; auto-close after this moment
  maxResponses: number | null; // auto-close after this many responses
  thankyouMessage: string; // mensaje de agradecimiento al terminar (vacío = por defecto)
  gradingMessage: string; // texto mientras se procesa/corrige la respuesta (vacío = por defecto)
  redirectUrl: string; // al enviar, se redirige a esta URL (vacío = sin redirección)
  questions: BuilderQuestion[];
  evaluation: EvaluationSettings;
  design: DesignSettings;
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
  { type: "imagepicker", label: "Opción con imágenes", hint: "Elegir por imagen", hasChoices: true },
  { type: "videoresponse", label: "Respuesta en video", hint: "Grabar o subir", hasChoices: false },
  // La matriz maneja su propio editor de filas/columnas, así que hasChoices: false.
  { type: "matrix", label: "Matriz", hint: "Grilla de opción única", hasChoices: false },
  { type: "ranking", label: "Ranking", hint: "Ordenar opciones", hasChoices: true },
  { type: "date", label: "Fecha", hint: "Selector de fecha", hasChoices: false },
  { type: "fileupload", label: "Subir archivo", hint: "Adjuntar archivo", hasChoices: false },
  { type: "section", label: "Sección", hint: "Agrupa preguntas", hasChoices: false },
];

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = Object.fromEntries(
  QUESTION_TYPES.map((q) => [q.type, q.label])
) as Record<QuestionType, string>;

export function typeHasChoices(type: QuestionType): boolean {
  return QUESTION_TYPES.find((q) => q.type === type)?.hasChoices ?? false;
}

// Acento de marca de Encuestum (oliva-limón). Es también el default de las
// encuestas nuevas; el usuario puede elegir cualquier color de la paleta.
const ESCRIBA_CORAL = "#8faf0e";

// Curated palette (Encuestum accent first) + neutral-diverse options.
export const ACCENT_PALETTE: { name: string; value: string }[] = [
  { name: "Oliva Encuestum", value: ESCRIBA_CORAL },
  { name: "Coral", value: "#e25a4e" },
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
    // imagepicker arranca con 2 (cada opción lleva imagen, dos alcanzan para
    // empezar); el resto de los tipos de opción, con 3.
    base.choices =
      type === "imagepicker"
        ? [newChoice("Opción 1"), newChoice("Opción 2")]
        : [newChoice("Opción 1"), newChoice("Opción 2"), newChoice("Opción 3")];
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
  if (type === "matrix") {
    base.matrixRows = [newChoice("Fila 1"), newChoice("Fila 2")];
    base.matrixColumns = [
      newChoice("Columna 1"),
      newChoice("Columna 2"),
      newChoice("Columna 3"),
    ];
  }
  if (type === "ranking") {
    base.choices = [newChoice("Opción 1"), newChoice("Opción 2"), newChoice("Opción 3")];
  }
  if (type === "fileupload") {
    base.fileMultiple = false;
    base.fileAccept = "";
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
    case "section":
      return "Nueva sección";
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
    case "imagepicker":
      return "Elegí una imagen";
    case "videoresponse":
      return "Grabá o subí tu respuesta en video";
    case "matrix":
      return "Valorá cada fila";
    case "ranking":
      return "Ordená las opciones por preferencia";
    case "date":
      return "Elegí una fecha";
    case "fileupload":
      return "Subí un archivo";
    default:
      return "Pregunta";
  }
}

// ---- Serialization: builder → SurveyJS JSON --------------------------------

// Turn a visibility rule into a SurveyJS `visibleIf` expression.
export function ruleToExpr(rule: VisibilityRule): string {
  const q = `{${rule.questionName}}`;
  const esc = (v: string) => String(v).replace(/'/g, "\\'");
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  switch (rule.operator) {
    case "empty":
      return `${q} empty`;
    case "notempty":
      return `${q} notempty`;
    case "contains":
      return `${q} contains '${esc(rule.value)}'`;
    case ">":
      return `${q} > ${num(rule.value)}`;
    case "<":
      return `${q} < ${num(rule.value)}`;
    case "<>":
      return `${q} <> '${esc(rule.value)}'`;
    default:
      return `${q} = '${esc(rule.value)}'`;
  }
}

// Translate our RatePresentation into SurveyJS rating props. "stars"/"smileys"
// ignore rateMin/ratemax labels but keep the numeric scale.
function applyRatePresentation(el: Record<string, any>, p: RatePresentation): void {
  switch (p) {
    case "buttons":
      el.displayMode = "buttons";
      break;
    case "buttons-color":
      el.displayMode = "buttons";
      el.rateColorMode = "scale";
      break;
    case "stars":
      el.rateType = "stars";
      break;
    case "smileys":
      el.rateType = "smileys";
      break;
    case "smileys-color":
      el.rateType = "smileys";
      el.scaleColorMode = "colored";
      break;
    case "numbers":
    default:
      break;
  }
}

// Read SurveyJS rating props back into our RatePresentation.
function ratePresentationOf(el: Record<string, any>): RatePresentation {
  if (el.rateType === "stars") return "stars";
  if (el.rateType === "smileys") {
    return el.scaleColorMode === "colored" ? "smileys-color" : "smileys";
  }
  if (el.displayMode === "buttons") {
    return el.rateColorMode === "scale" ? "buttons-color" : "buttons";
  }
  return "numbers";
}

function questionToElement(q: BuilderQuestion): Record<string, any> {
  // email y date se serializan como un "text" de SurveyJS con inputType propio;
  // fileupload es el "file" nativo de SurveyJS.
  const surveyType =
    q.type === "email" || q.type === "date"
      ? "text"
      : q.type === "fileupload"
        ? "file"
        : q.type;
  const el: Record<string, any> = {
    type: surveyType,
    name: q.name,
    title: q.title,
  };
  // "videoresponse" is our custom SurveyJS question (webcam recorder + upload);
  // its renderer stores the uploaded video's public URL as the answer.
  // Registered in VideoResponseQuestion.tsx.
  if (q.visibilityRule && q.visibilityRule.questionName) {
    el.visibleIf = ruleToExpr(q.visibilityRule);
    // Kept so the visual builder can round-trip the structured rule.
    el.encVisibility = q.visibilityRule;
  }
  if (q.description) el.description = q.description;
  if (q.isRequired) el.isRequired = true;
  if (q.type === "email") {
    el.inputType = "email";
    el.autocomplete = "email";
    el.validators = [{ type: "email" }];
  }
  if (q.placeholder) el.placeholder = q.placeholder;
  // Character cap on free-text answers (SurveyJS shows a live counter).
  if ((q.type === "text" || q.type === "comment") && q.maxLength && q.maxLength > 0) {
    el.maxLength = Math.floor(q.maxLength);
  }
  // Per-question style overrides (custom keys; read back from the raw JSON).
  if (typeof q.boxOpacity === "number") {
    el.encBoxOpacity = Math.max(0, Math.min(1, q.boxOpacity));
  }
  if (q.align === "left" || q.align === "center") {
    el.encAlign = q.align;
  }
  // Branching rules round-trip (los triggers reales se generan a nivel survey).
  if (q.branching && q.branching.length) {
    el.encBranching = q.branching;
  }
  if (q.type === "imagepicker") {
    el.choices = (q.choices ?? [])
      .map((c) => ({ value: c.text, text: c.text, imageLink: c.imageUrl || undefined }))
      .filter((c) => c.text.trim() !== "" || c.imageLink);
    el.multiSelect = !!q.multiSelect;
    el.showLabel = true;
    el.imageFit = "cover";
    el.contentMode = "image";
  } else if (typeHasChoices(q.type)) {
    el.choices = (q.choices ?? []).map((c) => c.text).filter((t) => t.trim() !== "");
  }
  if (q.type === "rating") {
    el.rateMin = q.rateMin ?? 0;
    el.rateMax = q.rateMax ?? 10;
    if (q.minRateDescription) el.minRateDescription = q.minRateDescription;
    if (q.maxRateDescription) el.maxRateDescription = q.maxRateDescription;
    applyRatePresentation(el, q.ratePresentation ?? "numbers");
  }
  if (q.type === "boolean") {
    el.labelTrue = q.labelTrue ?? "Sí";
    el.labelFalse = q.labelFalse ?? "No";
  }
  if (q.type === "matrix") {
    // Grilla de opción única: filas evaluadas contra columnas (opciones).
    el.rows = (q.matrixRows ?? [])
      .map((r) => ({ value: r.text, text: r.text }))
      .filter((r) => r.text.trim() !== "");
    el.columns = (q.matrixColumns ?? [])
      .map((c) => ({ value: c.text, text: c.text }))
      .filter((c) => c.text.trim() !== "");
  }
  if (q.type === "date") {
    // Fecha: text de SurveyJS con inputType date (+ min/max opcionales).
    el.inputType = "date";
    if (q.dateMin) el.min = q.dateMin;
    if (q.dateMax) el.max = q.dateMax;
  }
  if (q.type === "fileupload") {
    // Archivo genérico (NO video): marca propia para distinguirlo del video legacy.
    el._encFile = true;
    el.allowMultiple = !!q.fileMultiple;
    if (q.fileAccept && q.fileAccept.trim() !== "") {
      el.acceptedTypes = q.fileAccept.trim();
    }
    el.storeDataAsText = false;
  }
  return el;
}

// A decorative image element rendered right above its question. Named
// `<question>__img` so deserialization can re-attach it to the question.
function imageCompanion(q: BuilderQuestion): Record<string, any> {
  return {
    type: "image",
    name: `${q.name}__img`,
    imageLink: q.imageUrl,
    imageFit: "cover",
    imageHeight: 200,
    imageWidth: "100%",
  };
}

// Turn a video URL (YouTube / Vimeo / direct file or uploaded asset) into
// responsive embed HTML.
export function buildVideoEmbed(url: string): string {
  const u = (url || "").trim();
  if (!u) return "";
  // Constrained, centered player so the video never dominates the question.
  const frame = (src: string) =>
    `<div style="max-width:440px;margin:4px auto 8px">` +
    `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px">` +
    `<iframe src="${src}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" ` +
    `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div></div>`;
  const yt = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return frame(`https://www.youtube.com/embed/${yt[1]}`);
  const vimeo = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return frame(`https://player.vimeo.com/video/${vimeo[1]}`);
  // Direct file or uploaded asset.
  return `<div style="max-width:440px;margin:4px auto 8px"><video controls playsinline preload="metadata" style="width:100%;border-radius:12px;max-height:300px" src="${u}"></video></div>`;
}

// A video element rendered above its question. We keep the original URL in
// `videoLink` so deserialization can recover it (the html is just the embed).
function videoCompanion(q: BuilderQuestion): Record<string, any> {
  return {
    type: "html",
    name: `${q.name}__vid`,
    videoLink: q.videoUrl,
    html: buildVideoEmbed(q.videoUrl || ""),
  };
}

// A question plus its own media (image/video), kept together so per-question
// media renders ONLY with that question.
function questionBlock(q: BuilderQuestion): Record<string, any>[] {
  const els: Record<string, any>[] = [];
  if (q.imageUrl) els.push(imageCompanion(q));
  if (q.videoUrl) els.push(videoCompanion(q));
  els.push(questionToElement(q));
  return els;
}

export function builderToSchema(state: BuilderState): Record<string, any> {
  // Agrupar la lista plana en secciones (cada marcador "section" abre un grupo).
  type Group = { section: BuilderQuestion | null; items: BuilderQuestion[] };
  const groups: Group[] = [];
  let current: Group = { section: null, items: [] };
  for (const q of state.questions) {
    if (q.type === "section") {
      if (current.section || current.items.length) groups.push(current);
      current = { section: q, items: [] };
    } else {
      current.items.push(q);
    }
  }
  groups.push(current);
  const hasSections = groups.some((g) => g.section);

  const sectionPageMeta = (s: BuilderQuestion) => ({
    title: s.title || undefined,
    description: s.description || undefined,
    // Claves propias para reconstruir los marcadores al reabrir en el builder.
    encSectionTitle: s.title || "",
    encSectionDesc: s.description || "",
  });

  let pages: Record<string, any>[];
  if (state.onePerPage) {
    // One explicit page per question (media travels inside its page). Cada
    // sección agrega una página de portada (título + descripción).
    pages = [];
    let pi = 0;
    for (const g of groups) {
      if (g.section) {
        pi += 1;
        pages.push({
          name: `s${pi}`,
          ...sectionPageMeta(g.section),
          // Un html vacío para que la portada de sección sea una página visible.
          elements: [{ type: "html", name: `${g.section.name}__intro`, html: " " }],
        });
      }
      for (const q of g.items) {
        pi += 1;
        pages.push({ name: `p${pi}`, elements: questionBlock(q) });
      }
    }
    if ((state.passthrough ?? []).length) {
      pages.push({ name: "extra", elements: state.passthrough });
    }
    if (pages.length === 0) pages = [{ name: "page1", elements: [] }];
  } else if (hasSections) {
    // Una página por sección (estilo Google Forms: Siguiente entre secciones).
    pages = groups
      .filter((g) => g.section || g.items.length)
      .map((g, i) => ({
        name: `page${i + 1}`,
        ...(g.section ? sectionPageMeta(g.section) : {}),
        elements: g.items.flatMap((q) => questionBlock(q)),
      }));
    if ((state.passthrough ?? []).length) {
      if (pages.length === 0) pages = [{ name: "page1", elements: [] }];
      pages[pages.length - 1].elements.push(...(state.passthrough ?? []));
    }
    if (pages.length === 0) pages = [{ name: "page1", elements: [] }];
  } else {
    const elements: Record<string, any>[] = [];
    for (const q of state.questions) elements.push(...questionBlock(q));
    elements.push(...(state.passthrough ?? []));
    pages = [{ name: "page1", elements }];
  }

  // Bifurcación: reglas por pregunta → triggers de SurveyJS (skip/complete).
  const triggers: Record<string, any>[] = [];
  for (const q of state.questions) {
    if (q.type === "section") continue;
    for (const r of q.branching ?? []) {
      if (!r?.target) continue;
      if (!r.value && r.operator !== "empty" && r.operator !== "notempty") continue;
      const expression = ruleToExpr({
        questionName: q.name,
        operator: r.operator,
        value: r.value,
      });
      if (r.target === BRANCH_END) {
        triggers.push({ type: "complete", expression });
      } else {
        triggers.push({ type: "skip", expression, gotoName: r.target });
      }
    }
  }

  const schema: Record<string, any> = {
    title: state.title || undefined,
    description: state.description || undefined,
    showQuestionNumbers: "off",
    showProgressBar: state.onePerPage && state.showProgress ? "top" : "off",
    progressBarType: "pages",
    widthMode: "responsive",
    completedHtml: "<h3>¡Gracias por responder! 🙌</h3>",
    // Con secciones hay varias páginas aunque NO sea una-pregunta-por-pantalla;
    // guardamos el modo explícito para no inferirlo mal al reabrir.
    encOnePerPage: !!state.onePerPage,
    pages,
  };
  if (triggers.length) schema.triggers = triggers;
  if (state.design?.logo) {
    schema.logo = state.design.logo;
    schema.logoPosition = "left";
    schema.logoFit = "contain";
    schema.logoHeight = "56px";
  }
  return schema;
}

// ---- Deserialization: SurveyJS JSON → builder ------------------------------

function elementToQuestion(el: Record<string, any>, index: number): BuilderQuestion | null {
  const rawType = el?.type as string;
  const isEmail = rawType === "text" && el?.inputType === "email";
  const isDate = rawType === "text" && el?.inputType === "date";
  // Un "file" de SurveyJS es video legacy SOLO si trae la marca `_encVideo` o
  // acceptedTypes con "video"; en cualquier otro caso es un fileupload genérico.
  const isLegacyVideo =
    rawType === "file" &&
    (el?._encVideo === true ||
      (typeof el?.acceptedTypes === "string" && el.acceptedTypes.includes("video")));
  const isFileUpload = rawType === "file" && !isLegacyVideo;
  const type: QuestionType = (
    rawType === "videoresponse" || isLegacyVideo
      ? "videoresponse"
      : isFileUpload
        ? "fileupload"
        : isEmail
          ? "email"
          : isDate
            ? "date"
            : rawType
  ) as QuestionType;

  const supported: QuestionType[] = [
    "text",
    "email",
    "comment",
    "radiogroup",
    "checkbox",
    "dropdown",
    "rating",
    "boolean",
    "imagepicker",
    "videoresponse",
    "matrix",
    "ranking",
    "date",
    "fileupload",
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
    maxLength:
      typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : undefined,
    boxOpacity:
      typeof el.encBoxOpacity === "number" ? el.encBoxOpacity : undefined,
    align: el.encAlign === "left" || el.encAlign === "center" ? el.encAlign : undefined,
  };

  if (el.encVisibility && typeof el.encVisibility === "object" && el.encVisibility.questionName) {
    q.visibilityRule = el.encVisibility as VisibilityRule;
  }
  if (Array.isArray(el.encBranching) && el.encBranching.length) {
    q.branching = el.encBranching as BranchRule[];
  }

  if (type === "imagepicker" && Array.isArray(el.choices)) {
    q.choices = el.choices.map((c: any) => {
      const ch = newChoice(typeof c === "object" ? c.text ?? c.value ?? "" : String(c));
      if (c && typeof c === "object" && c.imageLink) ch.imageUrl = c.imageLink;
      return ch;
    });
    q.multiSelect = !!el.multiSelect;
  } else if (typeHasChoices(type) && Array.isArray(el.choices)) {
    q.choices = el.choices.map((c: any) =>
      newChoice(typeof c === "object" ? c.text ?? c.value ?? "" : String(c))
    );
  }
  if (type === "rating") {
    q.rateMin = typeof el.rateMin === "number" ? el.rateMin : 0;
    q.rateMax = typeof el.rateMax === "number" ? el.rateMax : 10;
    q.minRateDescription = el.minRateDescription || undefined;
    q.maxRateDescription = el.maxRateDescription || undefined;
    q.ratePresentation = ratePresentationOf(el);
  }
  if (type === "boolean") {
    q.labelTrue = el.labelTrue || "Sí";
    q.labelFalse = el.labelFalse || "No";
  }
  if (type === "matrix") {
    q.matrixRows = Array.isArray(el.rows)
      ? el.rows.map((r: any) =>
          newChoice(typeof r === "object" ? r.text ?? r.value ?? "" : String(r))
        )
      : [];
    q.matrixColumns = Array.isArray(el.columns)
      ? el.columns.map((c: any) =>
          newChoice(typeof c === "object" ? c.text ?? c.value ?? "" : String(c))
        )
      : [];
  }
  if (type === "date") {
    q.dateMin = typeof el.min === "string" ? el.min : undefined;
    q.dateMax = typeof el.max === "string" ? el.max : undefined;
  }
  if (type === "fileupload") {
    q.fileMultiple = !!el.allowMultiple;
    q.fileAccept = typeof el.acceptedTypes === "string" ? el.acceptedTypes : "";
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

  const named = (el: any) => (typeof el?.name === "string" ? el.name : "");
  const isImageCompanion = (el: any) => el?.type === "image" && named(el).endsWith("__img");
  const isVideoCompanion = (el: any) => el?.type === "html" && named(el).endsWith("__vid");

  // First pass: collect per-question media links from companion elements.
  const imageByBase: Record<string, string> = {};
  const videoByBase: Record<string, string> = {};
  elements.forEach((el) => {
    if (isImageCompanion(el) && el.imageLink) {
      imageByBase[named(el).slice(0, -"__img".length)] = el.imageLink;
    } else if (isVideoCompanion(el) && el.videoLink) {
      videoByBase[named(el).slice(0, -"__vid".length)] = el.videoLink;
    }
  });

  const isSectionIntro = (el: any) =>
    el?.type === "html" && named(el).endsWith("__intro");

  const questions: BuilderQuestion[] = [];
  const passthrough: Record<string, any>[] = [];
  let sectionSeq = 0;
  let elIndex = 0;
  for (const page of pages) {
    // Página marcada como sección → reinsertamos el marcador en la lista plana.
    if (typeof page?.encSectionTitle === "string") {
      sectionSeq += 1;
      questions.push({
        id: uid("q"),
        type: "section",
        name: `section_${sectionSeq}`,
        title: page.encSectionTitle || page.title || "Sección",
        description: page.encSectionDesc || page.description || undefined,
        isRequired: false,
      });
    }
    for (const el of Array.isArray(page?.elements) ? page.elements : []) {
      elIndex += 1;
      if (isImageCompanion(el) || isVideoCompanion(el) || isSectionIntro(el)) continue;
      const q = elementToQuestion(el, elIndex);
      if (q) {
        if (imageByBase[q.name]) q.imageUrl = imageByBase[q.name];
        if (videoByBase[q.name]) q.videoUrl = videoByBase[q.name];
        questions.push(q);
      } else if (el && typeof el === "object") {
        passthrough.push(el);
      }
    }
  }

  hydrateGrading(questions, evaluation);

  // Modo explícito si el schema lo trae (los guardados nuevos); si no, la
  // heurística vieja (varias páginas ≈ una-por-pantalla).
  const onePerPage =
    typeof s.encOnePerPage === "boolean"
      ? s.encOnePerPage
      : pages.length > 1 ||
        s.showProgressBar === "top" ||
        s.questionsOnPageMode === "questionPerPage";
  const showProgress =
    s.showProgressBar === undefined ? true : s.showProgressBar !== "off";

  return {
    title: s.title || fallbackTitle || "",
    description: s.description || "",
    accent,
    onePerPage,
    showProgress,
    opensAt: null,
    closesAt: null,
    maxResponses: null,
    thankyouMessage: "",
    gradingMessage: "",
    redirectUrl: "",
    questions,
    evaluation: hydrateEvaluationSettings(evaluation),
    design: { ...DEFAULT_DESIGN },
    passthrough,
  };
}

function hydrateEvaluationSettings(
  evaluation?: Record<string, any> | null
): EvaluationSettings {
  if (!evaluation || typeof evaluation !== "object") {
    return { ...DEFAULT_EVALUATION, integrity: { ...DEFAULT_EVALUATION.integrity } };
  }
  const ai = evaluation.aiCriteria || {};
  return {
    enabled: !!evaluation.enabled,
    feedbackTiming: evaluation.feedbackTiming ?? "onComplete",
    passingScore: evaluation.passingScore ?? 60,
    showScoreToRespondent: evaluation.showScoreToRespondent ?? true,
    doublePass: !!evaluation.doublePass,
    reviewThreshold: evaluation.reviewThreshold ?? 0.6,
    aiCriteria: {
      enabled: !!ai.enabled,
      strictness: ai.strictness ?? "equilibrado",
      focus: Array.isArray(ai.focus) ? ai.focus : [],
      tone: ai.tone ?? "neutral",
      instructions: ai.instructions ?? "",
    },
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
    if (q.type === "imagepicker") {
      q.correctChoices = Array.isArray(correct) ? correct.map(String) : [];
      q.multiSelect = !!c.multiSelect;
      q.partialCredit = !!c.partialCredit;
    } else if (q.type === "checkbox") {
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
      if (q.type === "imagepicker") {
        cfg.correct = q.correctChoices ?? [];
        cfg.multiSelect = !!q.multiSelect;
        if (q.multiSelect) cfg.partialCredit = !!q.partialCredit;
      } else if (q.type === "checkbox") {
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

// Full theme = accent theme + typography + background + an `_encuestum` block
// carrying the bits SurveyJS doesn't model (cover, logo, audio). Persisted as-is.
export function designToTheme(accent: string, design: DesignSettings): Record<string, any> {
  const t = accentToTheme(accent);
  const dark = design.mode === "dark";
  const v = t.cssVariables as Record<string, string>;
  v["--sjs-font-family"] = fontCssFamily(design.fontFamily);

  // Dark scheme: flip SurveyJS surfaces + text to a dark palette.
  if (dark) {
    t.colorPalette = "dark";
    Object.assign(v, {
      "--sjs-general-backcolor": "#252b36",
      "--sjs-general-backcolor-dark": "#1b2029",
      "--sjs-general-backcolor-dim": design.backgroundColor || "#181c24",
      "--sjs-general-backcolor-dim-light": "#252b36",
      "--sjs-general-backcolor-dim-dark": "#12151b",
      "--sjs-general-forecolor": "#f2f4f8",
      "--sjs-general-forecolor-light": "rgba(242,244,248,0.62)",
      "--sjs-general-dim-forecolor": "#f2f4f8",
      "--sjs-general-dim-forecolor-light": "rgba(242,244,248,0.62)",
      "--sjs-border-default": "rgba(255,255,255,0.16)",
      "--sjs-border-light": "rgba(255,255,255,0.09)",
      "--sjs-editorpanel-backcolor": "#2d3441",
      "--sjs-editorpanel-hovercolor": "#333b4a",
    });
  }
  if (!dark && design.backgroundColor) {
    v["--sjs-general-backcolor-dim"] = design.backgroundColor;
  }

  // Explicit question text color (title + description + main text).
  if (design.textColor) {
    v["--sjs-general-forecolor"] = design.textColor;
    v["--sjs-general-dim-forecolor"] = design.textColor;
    v["--sjs-font-questiontitle-color"] = design.textColor;
    v["--sjs-font-questiondescription-color"] = rgba(design.textColor, 0.72);
  }

  // Surface (color + opacity) of the question/input boxes. Opacity < 1 lets the
  // background show through (glass). `transparentQuestions` is the legacy toggle
  // = opacity 0.
  const defaultSurface = dark ? "#252b36" : "#ffffff";
  const surfaceColor = design.questionColor || defaultSurface;
  let op = design.questionOpacity;
  if (op == null) op = design.transparentQuestions ? 0 : 1;
  op = Math.max(0, Math.min(1, op));
  if (design.questionColor || op < 1 || design.transparentQuestions) {
    const surface = op >= 1 ? surfaceColor : rgba(surfaceColor, op);
    v["--sjs-question-background"] = surface;
    v["--sjs-general-backcolor"] = surface;
    // Inputs stay a touch more opaque so text is always readable.
    const inputOp = Math.min(1, op + 0.12);
    v["--sjs-editorpanel-backcolor"] = inputOp >= 1 ? surfaceColor : rgba(surfaceColor, inputOp);
  }

  // Text typed INSIDE inputs: independent from the question-title color. Default
  // is auto-readable on the box surface (dark text on a light glass box, even if
  // the titles are white over a dark background).
  const inputText = design.inputTextColor || readableForeground(surfaceColor);
  v["--sjs-font-editorfont-color"] = inputText;
  v["--sjs-font-editorfont-placeholdercolor"] = rgba(inputText, 0.5);

  if (design.backgroundImage) {
    t.backgroundImage = design.backgroundImage;
    t.backgroundImageFit = "cover";
    t.backgroundImageAttachment = "fixed";
    t.backgroundOpacity = design.backgroundOpacity ?? 1;
  }
  t._encuestum = {
    fontFamily: design.fontFamily,
    mode: design.mode ?? "light",
    textColor: design.textColor ?? null,
    transparentQuestions: !!design.transparentQuestions,
    questionColor: design.questionColor ?? null,
    questionOpacity: op,
    glass: !!design.glass,
    inputTextColor: design.inputTextColor ?? null,
    buttonColor: design.buttonColor ?? null,
    buttonShadow: !!design.buttonShadow,
    questionSeparator: !!design.questionSeparator,
    alignment: design.alignment ?? "left",
    pageTransition: design.pageTransition ?? "none",
    chat: !!design.chat,
    chatOptions: design.chatOptions ?? null,
    thankYou: design.thankYou ?? null,
    grading: design.grading ?? null,
    closed: design.closed ?? null,
    backgroundColor: design.backgroundColor ?? null,
    backgroundImage: design.backgroundImage ?? null,
    backgroundOpacity: design.backgroundOpacity ?? 1,
    coverImage: design.coverImage ?? null,
    logo: design.logo ?? null,
    audio: design.audio ?? null,
  };
  return t;
}

export function themeToDesign(theme: Record<string, any> | null | undefined): DesignSettings {
  const e = theme?._encuestum || {};
  const font = typeof e.fontFamily === "string" && fontById(e.fontFamily).id === e.fontFamily
    ? e.fontFamily
    : "system";
  return {
    fontFamily: font,
    mode: e.mode === "dark" || theme?.colorPalette === "dark" ? "dark" : "light",
    textColor: e.textColor || theme?.cssVariables?.["--sjs-font-questiontitle-color"] || undefined,
    transparentQuestions: !!e.transparentQuestions,
    questionColor: e.questionColor || undefined,
    questionOpacity: typeof e.questionOpacity === "number" ? e.questionOpacity : 1,
    glass: !!e.glass,
    inputTextColor: e.inputTextColor || undefined,
    buttonColor: e.buttonColor || undefined,
    buttonShadow: !!e.buttonShadow,
    questionSeparator: !!e.questionSeparator,
    alignment: e.alignment === "center" ? "center" : "left",
    pageTransition: e.pageTransition || "none",
    chat: !!e.chat,
    chatOptions:
      e.chatOptions && typeof e.chatOptions === "object"
        ? { ...DEFAULT_CHAT, ...e.chatOptions }
        : { ...DEFAULT_CHAT },
    thankYou:
      e.thankYou && typeof e.thankYou === "object"
        ? { ...DEFAULT_THANKYOU, ...e.thankYou }
        : { ...DEFAULT_THANKYOU },
    grading: e.grading && typeof e.grading === "object" ? e.grading : undefined,
    closed: e.closed && typeof e.closed === "object" ? e.closed : undefined,
    backgroundColor: e.backgroundColor || theme?.cssVariables?.["--sjs-general-backcolor-dim"] || undefined,
    backgroundImage: e.backgroundImage || theme?.backgroundImage || undefined,
    backgroundOpacity: typeof e.backgroundOpacity === "number" ? e.backgroundOpacity : 1,
    coverImage: e.coverImage || undefined,
    logo: e.logo || undefined,
    audio: e.audio && typeof e.audio === "object" && e.audio.url ? e.audio : null,
  };
}

// CSS with the per-question style overrides (transparencia `encBoxOpacity` y
// alineación `encAlign` en el JSON). SurveyJS pone data-name en la raíz de cada
// pregunta, así que scopeamos las variables/reglas ahí y el resto hereda del
// tema o de la alineación global.
export function perQuestionStyleCss(
  schema: Record<string, any> | null | undefined,
  design: DesignSettings
): string {
  const dark = design.mode === "dark";
  const surfaceColor = design.questionColor || (dark ? "#252b36" : "#ffffff");
  let css = "";
  for (const page of (schema?.pages as any[]) ?? []) {
    for (const el of (page?.elements as any[]) ?? []) {
      if (!el?.name) continue;
      const name = String(el.name).replace(/["\\]/g, "");
      const sel = `.enc-scope [data-name="${name}"]`;

      if (typeof el.encBoxOpacity === "number") {
        const op = Math.max(0, Math.min(1, el.encBoxOpacity));
        const surface = op >= 1 ? surfaceColor : rgba(surfaceColor, op);
        // Opacidad 0 = totalmente limpio (también los controles internos).
        const inputOp = op === 0 ? 0 : Math.min(1, op + 0.12);
        const input = inputOp >= 1 ? surfaceColor : rgba(surfaceColor, inputOp);
        css +=
          `${sel} { --sjs-question-background: ${surface}; ` +
          `--sjs-general-backcolor: ${surface}; ` +
          `--sjs-editorpanel-backcolor: ${input}; }\n`;
      }

      if (el.encAlign === "center") {
        css +=
          `${sel} .sd-question__header, ${sel} .sd-question__title, ${sel} .sd-question__description { text-align: center; justify-content: center; }\n` +
          `${sel} .sd-rating, ${sel} .sd-selectbase, ${sel} .sd-imagepicker { margin-left: auto; margin-right: auto; width: fit-content; }\n`;
      } else if (el.encAlign === "left") {
        css +=
          `${sel} .sd-question__header, ${sel} .sd-question__title, ${sel} .sd-question__description { text-align: left; justify-content: flex-start; }\n` +
          `${sel} .sd-rating, ${sel} .sd-selectbase, ${sel} .sd-imagepicker { margin-left: 0; margin-right: auto; width: auto; }\n`;
      }
    }
  }
  return css;
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
