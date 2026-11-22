import { getApiUrl } from "@/utils/api";
import type { UsageInfo } from "./aiApi";

export type { UsageInfo };

export const SURVEY_ACCENT = "#8faf0e";

export interface SurveySummary {
  id: string;
  title: string | null;
  slug: string;
  status: "draft" | "published" | "closed";
  language: string | null;
  response_count: number;
  is_evaluation: boolean;
  created_at: string;
  updated_at: string;
  /** Carpeta que la contiene. null = sin clasificar. */
  folder_id?: string | null;
  /** Solo viene con valor en el listado de la papelera. */
  deleted_at?: string | null;
}

export type AccessMode = "public" | "pin" | "list";
export type ResultsMode = "immediate" | "on_release" | "never";

export interface SurveyDetail {
  id: string;
  title: string | null;
  slug: string;
  status: "draft" | "published" | "closed";
  language: string | null;
  json_schema: Record<string, any>;
  theme: Record<string, any> | null;
  evaluation: Record<string, any> | null;
  opens_at: string | null;
  closes_at: string | null;
  max_responses: number | null;
  /** Intentos por persona (distinto del cupo total). null = sin límite. */
  max_attempts: number | null;
  // Zona horaria del servidor (config global) para interpretar opens_at/closes_at.
  timezone: string;
  // Control de acceso y visibilidad de resultados
  access_mode: AccessMode;
  access_pin: string | null;
  results_mode: ResultsMode;
  results_released: boolean;
  // Emails (separados por coma) a avisar cuando llega una respuesta.
  notify_emails?: string;
  // Distribución: mensaje de agradecimiento y redirección al terminar.
  thankyou_message?: string;
  // Texto mientras se procesa/corrige la respuesta (evaluaciones con IA).
  grading_message?: string;
  redirect_url?: string;
  // Anti-bot: exige un desafío proof-of-work antes de aceptar respuestas.
  require_captcha?: boolean;
  // Privacidad: anonimato garantizado y retención de respuestas.
  anonymous?: boolean;
  retention_days?: number | null;
  retention_action?: RetentionAction | null;
  // Recordatorios automáticos a invitados que no respondieron.
  reminders?: ReminderConfig | null;
  // Campos ocultos de la URL, cupos y link público de resultados.
  hidden_fields?: string[] | null;
  quotas?: Quota[] | null;
  public_results?: PublicResultsConfig | null;
  created_at: string;
  updated_at: string;
  /** Huella del contenido editable: el editor la devuelve al guardar para que
   *  el servidor detecte si otra pestaña o persona cambió la encuesta. */
  content_hash?: string | null;
}

// ---- Panel de resultados (resumen tipo "Google Forms") ----

export interface SummaryOption {
  label: string;
  value: unknown;
  count: number;
}

export interface SummaryDistribution {
  value: number;
  count: number;
}

interface SummaryQuestionBase {
  name: string;
  title: string;
  type: string;
  answered: number;
  /** Desglose por valor del segmento (cross-tab), si se pidió segment_by. */
  by_segment?: Record<string, SummaryQuestion>;
  /** Prueba chi² de la diferencia entre segmentos (si aplica). */
  significance?: Significance | null;
  /** Mediana de segundos que llevó responderla (lo mide el navegador). */
  timing?: { median_seconds: number; n: number };
  /** Es un campo oculto de la URL (`@nombre`), no una pregunta. */
  hidden_field?: boolean;
}

export interface Significance {
  chi2: number;
  dof: number;
  p: number;
  cramers_v: number | null;
  n: number;
  /** false: demasiadas celdas con menos de 5 esperados; el p-valor no es confiable. */
  reliable: boolean;
  significant: boolean;
}

/** Unión discriminada por `kind` con la forma del gráfico de cada pregunta. */
export type SummaryQuestion =
  | (SummaryQuestionBase & {
      kind: "choice";
      multi: boolean;
      options: SummaryOption[];
    })
  | (SummaryQuestionBase & {
      kind: "rating";
      min: number;
      max: number;
      average: number | null;
      median?: number | null;
      stdev?: number | null;
      top2?: number;
      bottom2?: number;
      nps?: { score: number; promoters: number; passives: number; detractors: number } | null;
      distribution: SummaryDistribution[];
    })
  | (SummaryQuestionBase & {
      kind: "text";
      values: string[];
      terms?: { term: string; count: number }[];
    })
  | (SummaryQuestionBase & { kind: "files"; values: string[] })
  | (SummaryQuestionBase & {
      kind: "matrix";
      rows: { value: string; label: string }[];
      columns: { value: string; label: string }[];
      cells: number[][];
    })
  | (SummaryQuestionBase & {
      kind: "ranking";
      items: { value: string; label: string; n: number; avg_position: number | null; first: number }[];
    })
  | (SummaryQuestionBase & {
      kind: "numeric";
      n: number;
      min: number | null;
      max: number | null;
      average: number | null;
      median: number | null;
      stdev: number | null;
      histogram: { from: number; to: number; count: number }[];
    })
  | (SummaryQuestionBase & { kind: "signature"; signed: number })
  | (SummaryQuestionBase & {
      kind: "dates";
      n: number;
      min: string | null;
      max: string | null;
      median: string | null;
      by_month: { month: string; count: number }[];
    });

/** Pregunta categórica utilizable como filtro o segmento. */
export interface FilterableQuestion {
  name: string;
  title: string;
  type: string;
  options: { value: string; label: string }[];
}

export interface SummarySegment {
  name: string;
  title: string;
  multi?: boolean;
  /** Algún segmento tiene menos de 30 respuestas: comparar con cuidado. */
  small_sample?: boolean;
  values: { value: string; label: string; count: number; small?: boolean }[];
}

/** Un filtro activo: una pregunta y los valores admitidos. */
export interface SummaryFilter {
  name: string;
  values: string[];
}

export interface SummaryReport {
  total_responses: number;
  filtered_responses: number;
  date_from?: string | null;
  date_to?: string | null;
  timeline?: { date: string; count: number }[];
  filters: { name: string; title: string; values: string[] }[];
  segment: SummarySegment | null;
  filterable: FilterableQuestion[];
  questions: SummaryQuestion[];
}

/** Carpeta de encuestas. `parent_id` null = está en la raíz. */
export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  position: number;
  survey_count: number;
}

/** Una entrada del registro de borrados (irreversibles, solo admin). */
export interface ResponseDeletion {
  id: string;
  response_id: string;
  deleted_by_email: string | null;
  respondent: string | null;
  submitted_at: string | null;
  deleted_at: string;
}

/** Reclamo de nota de un alumno sobre una pregunta. */
export interface GradeAppeal {
  id: string;
  response_id: string;
  question: string;
  question_title: string;
  respondent: string | null;
  answer: unknown;
  awarded: number | null;
  points: number | null;
  message: string;
  status: "open" | "accepted" | "rejected";
  reply: string | null;
  award_before: number | null;
  award_after: number | null;
  resolved_by_email: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Una pregunta del banco de la organización. */
export interface BankItem {
  id: string;
  title: string;
  type: string;
  element: Record<string, unknown>;
  grading: Record<string, unknown> | null;
  topic: string | null;
  tags: string[];
  difficulty: string | null;
  bloom: string | null;
  created_at: string;
}

/** Una versión del historial (estructura + corrección). */
export interface SurveyVersionInfo {
  id: string;
  number: number;
  label: string | null;
  created_by_email: string | null;
  created_at: string;
  questions: number;
  responses: number;
}

/** Una entrada del registro de actividad de la encuesta (solo admin). */
export interface AuditEvent {
  id: string;
  action: string;
  actor_email: string | null;
  response_id: string | null;
  detail: Record<string, any> | null;
  created_at: string;
}

/** Una tarea de la cola persistente: entrega al LMS, webhook, email o
 *  recorrección masiva. */
export interface JobInfo {
  id: string;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  progress: { done?: number; total?: number; graded?: number } | null;
  result: Record<string, any> | null;
  response_id: string | null;
  payload: { url?: string; to?: string; webhook_id?: string };
  created_at: string | null;
  run_after: string | null;
  finished_at: string | null;
}

/** Un cambio de nota de una respuesta. */
export interface GradeRevision {
  id: string;
  source: "submit" | "regrade" | "manual" | string;
  actor_email: string | null;
  score_before: number | null;
  score_after: number | null;
  max_score: number | null;
  graded_with_version: number | null;
  model: string | null;
  prompt_version: string | null;
  note: string | null;
  created_at: string;
}

/** Línea de tiempo de una respuesta: versión contestada, huella y cambios. */
export interface ResponseHistory {
  response_id: string;
  submitted_at: string | null;
  answered_version: number | null;
  integrity: boolean | null;
  grade_revisions: GradeRevision[];
  deliveries?: JobInfo[];
  events: { action: string; actor_email: string | null; detail: Record<string, any> | null; created_at: string }[];
}

/** Informe ejecutivo por IA (narrativa sobre los agregados ya calculados). */
export interface ExecutiveReport {
  headline: string;
  summary: string;
  findings: { title: string; detail: string; evidence: string[] }[];
  recommendations: string[];
  generated_at: string;
  response_count: number;
}

// ---- Embudo de conversión (vistas → comenzaron → completaron) ----

export interface FunnelDropoff {
  /** Nombre técnico de la pregunta (name del schema). */
  question: string;
  /** Título legible de la pregunta. */
  title: string;
  /** Cantidad de personas que abandonaron en esta pregunta. */
  count: number;
}

export interface Funnel {
  views: number;
  starts: number;
  completions: number;
  responses: number;
  start_rate: number | null;
  completion_rate: number | null;
  dropoff: FunnelDropoff[];
  /** Personas identificadas con una respuesta a medio hacer guardada. */
  in_progress?: number;
  completion_seconds?: { n: number; median: number | null; p25: number | null; p75: number | null };
  devices?: Record<string, number>;
}

export interface QualityReport {
  checked: number;
  completion: { n: number; median: number | null };
  speed_threshold_seconds: number | null;
  flagged: { response_id: string; reasons: { code: string; detail: string }[] }[];
}

// Invitado (modo lista): cada uno con su código de acceso único.
export type RetentionAction = "anonymize" | "delete";
export interface Quota {
  question: string;
  values: string[];
  limit: number;
  message?: string | null;
}
export interface QuotaStatus extends Quota {
  used: number;
  full: boolean;
}
export interface PublicResultsConfig {
  enabled: boolean;
  token: string;
  show_text: boolean;
  min_responses: number;
}
export interface TranslationCoverage {
  language: string;
  total: number;
  translated: number;
  missing: number;
  unused: number;
}
export interface OrgTemplate {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  questions: number;
  is_evaluation: boolean;
  language: string | null;
  uses: number;
  created_at: string;
}
export interface ReminderConfig {
  enabled: boolean;
  every_days: number;
  max: number;
}

export interface Invitee {
  id: string;
  email: string;
  name: string | null;
  code: string;
  used_at: string | null;
  sent_at: string | null;
  opened_at?: string | null;
  responded_at?: string | null;
  reminders_sent?: number;
  last_reminded_at?: string | null;
  created_at: string;
}

export interface InviteTracking {
  total: number;
  sent: number;
  opened: number;
  clicked: number;
  responded: number;
  reminders: number;
  response_rate: number | null;
  reminders_config: ReminderConfig | null;
}

export interface ResponseItem {
  id: string;
  answers: Record<string, any>;
  completed: boolean;
  meta: Record<string, any> | null;
  submitted_at: string;
  score: number | null;
  max_score: number | null;
  needs_review: boolean;
  grade: Record<string, any> | null;
  graded_at: string | null;
  /** Fuera de los resultados sin estar borrada: excluida a mano o marcada como
   * prueba. No entra en resumen, estadísticas, informe, exportación ni cupo. */
  excluded?: boolean;
  is_test?: boolean;
  /** Versión de la encuesta (estructura + rúbrica) que contestó. */
  survey_version_id?: string | null;
  /** true: la huella coincide; false: la respuesta cambió en la base después
   *  de enviarse; null: anterior a la huella (no hay con qué comparar). */
  integrity_ok?: boolean | null;
}

export interface Analytics {
  is_evaluation: boolean;
  responses: number;
  graded: number;
  needs_review: number;
  avg_percent: number | null;
  pass_rate: number | null;
  score_distribution: number[];
  per_question: {
    name: string;
    // Posición en la encuesta (no en esta tabla: acá sólo entran las puntuadas).
    number?: number | null;
    // Título real de la pregunta; `name` es el nombre interno (radiogroup_4).
    title?: string;
    type?: string;
    // Qué se eligió y cuántas veces. Vacío en las preguntas abiertas.
    breakdown?: { value: string; count: number; correct: boolean }[];
    responses: number;
    avg_score_pct: number | null;
    correct_rate: number;
    // Análisis de ítems (ver backend/app/item_analysis.py).
    difficulty?: number | null;
    discrimination?: number | null;
    d_index?: number | null;
    flags?: string[];
    distractors?: {
      never_chosen: string[];
      attracts_top: { option: string; upper: number; lower: number }[];
    };
  }[];
  reliability?: { alpha: number; n: number; items: number; level: "buena" | "aceptable" | "baja" } | null;
}

// ---- Planilla de notas (gradebook) de una evaluación ----

export interface GradebookRow {
  response_id: string;
  name: string;
  email: string | null;
  code: string | null;
  score: number | null;
  max_score: number | null;
  percent: number | null;
  /** false cuando la respuesta no tiene puntaje posible (max_score 0): no está
   * desaprobada, está sin evaluar. */
  scorable?: boolean;
  passed: boolean;
  needs_review: boolean;
  graded: boolean;
  submitted_at: string;
}

export interface Gradebook {
  is_evaluation: boolean;
  passing_score: number;
  count: number;
  rows: GradebookRow[];
}

export interface InsightTheme {
  label: string;
  count: number;
  sentiment: string;
  summary: string;
  evidence: string[];
}

export interface OpenSummary {
  overall: string;
  themes: InsightTheme[];
  key_takeaways: string[];
}

export interface QuestionInsight {
  name: string;
  title: string;
  n: number;
  summary: OpenSummary;
}

export interface Insights {
  generated_at?: string;
  questions: QuestionInsight[];
  /** Respuestas que contaban al generar el análisis, y las que cuentan hoy. */
  response_count?: number;
  current_count?: number;
}

export interface GeneratedQuestion {
  type: string;
  title: string;
  choices: string[];
  correctIndices: number[];
  acceptableAnswers?: string[];
  rows?: string[];
  columns?: string[];
  correctColumns?: number[];
  modelAnswer: string;
  keyConcepts: string[];
  rubric: { label: string; points: number }[];
  points: number;
  explanations?: { option: string; why_wrong: string }[];
  bloom?: string;
  objective?: string;
  sourceQuote?: string;
  /** true: la cita está en el material; false: no aparece; null: sin material. */
  sourceVerified?: boolean | null;
}

export interface GenerateBody {
  topic: string;
  count: number;
  types: string[];
  language: string;
  difficulty?: string;
  context?: string;
  bloom?: string[];
  objectives?: string;
  existing_titles?: string[];
  variant_of?: Partial<GeneratedQuestion>;
}

export interface GenerateResult {
  questions: GeneratedQuestion[];
  usage?: UsageInfo;
  dropped_duplicates?: number;
  material?: { chars: number; used_chars: number; truncated: boolean } | null;
}

export interface WordingReview {
  name: string;
  issues: { kind: string; detail: string; suggestion: string }[];
  rewrite: string;
}

export interface DataAnswer {
  answer: string;
  figures: { label: string; value: string }[];
  caveats: string[];
  answerable: boolean;
}

export interface SummaryOptions {
  segmentBy?: string | null;
  filters?: SummaryFilter[];
  dateFrom?: string | null;
  dateTo?: string | null;
}

function summaryQuery(opts?: SummaryOptions): string {
  const qs = new URLSearchParams();
  if (opts?.segmentBy) qs.set("segment_by", opts.segmentBy);
  if (opts?.filters && opts.filters.length) qs.set("filters", JSON.stringify(opts.filters));
  if (opts?.dateFrom) qs.set("date_from", opts.dateFrom);
  if (opts?.dateTo) qs.set("date_to", opts.dateTo);
  return qs.toString() ? `?${qs.toString()}` : "";
}

const RESPONSES_PAGE = 500;

/** Como `request`, pero devuelve también el total del header `X-Total-Count`. */
async function requestWithTotal<T>(path: string): Promise<{ items: T; total: number }> {
  const res = await fetch(getApiUrl(path), { cache: "no-store", credentials: "include" });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Request failed (${res.status})`);
  const total = Number(res.headers.get("X-Total-Count") ?? "NaN");
  const items = (await res.json()) as T;
  return { items, total: Number.isFinite(total) ? total : Array.isArray(items) ? items.length : 0 };
}

async function fetchAllResponses(
  id: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<ResponseItem[]> {
  const out: ResponseItem[] = [];
  for (let offset = 0; ; offset += RESPONSES_PAGE) {
    const { items, total } = await requestWithTotal<ResponseItem[]>(
      `/api/v1/survey/surveys/${id}/responses?limit=${RESPONSES_PAGE}&offset=${offset}`
    );
    out.push(...items);
    onProgress?.(out.length, total);
    if (items.length < RESPONSES_PAGE || out.length >= total) return out;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let msg = raw;
    let detail: unknown = null;
    try {
      const j = JSON.parse(raw);
      detail = j?.detail ?? null;
      if (j && typeof j.detail === "string") msg = j.detail;
      else if (j?.detail && typeof j.detail.message === "string") msg = j.detail.message;
    } catch {
      /* not JSON; use raw text */
    }
    // `status` y `detail` viajan con el error: quien llama distingue, p. ej.,
    // un conflicto de edición (409) de un fallo cualquiera.
    throw Object.assign(new Error(msg || `Request failed (${res.status})`), {
      status: res.status,
      detail,
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const surveyApi = {
  list: () => request<SurveySummary[]>("/api/v1/survey/surveys"),
  get: (id: string, signal?: AbortSignal) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}`, { signal }),
  create: (body: {
    title?: string;
    json_schema?: Record<string, any>;
    language?: string;
    theme?: Record<string, any> | null;
    evaluation?: Record<string, any> | null;
  }) =>
    request<SurveyDetail>("/api/v1/survey/surveys", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (
    id: string,
    body: Partial<
      Pick<
        SurveyDetail,
        | "title"
        | "slug"
        | "json_schema"
        | "status"
        | "language"
        | "theme"
        | "opens_at"
        | "evaluation"
        | "closes_at"
        | "max_responses"
        | "max_attempts"
        | "access_mode"
        | "access_pin"
        | "results_mode"
        | "notify_emails"
        | "thankyou_message"
        | "grading_message"
        | "redirect_url"
        | "require_captcha"
        | "anonymous"
        | "retention_days"
        | "retention_action"
        | "reminders"
        | "hidden_fields"
        | "quotas"
      >
    > & {
      base_content_hash?: string | null;
      snapshot?: boolean;
      public_results?: Partial<PublicResultsConfig> & { regenerate?: boolean };
    }
  ) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  publish: (id: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/publish`, { method: "POST" }),
  close: (id: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/close`, { method: "POST" }),
  /** Manda la encuesta a la papelera. No destruye nada: es restaurable. */
  remove: (id: string) =>
    request<void>(`/api/v1/survey/surveys/${id}`, { method: "DELETE" }),
  listTrash: () => request<SurveySummary[]>("/api/v1/survey/surveys/trash/list"),
  restore: (id: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/restore`, { method: "POST" }),
  /** Borrado definitivo e irreversible. Solo funciona desde la papelera. */
  purge: (id: string) =>
    request<void>(`/api/v1/survey/surveys/${id}/purge`, { method: "DELETE" }),
  /** Todas las respuestas, pedidas de a páginas: cada request queda acotado
   *  aunque la encuesta tenga miles. `onProgress` recibe lo cargado y el total. */
  responses: (id: string, onProgress?: (loaded: number, total: number) => void) =>
    fetchAllResponses(id, onProgress),
  responsesPage: (id: string, limit: number, offset: number, filter = "all") =>
    requestWithTotal<ResponseItem[]>(
      `/api/v1/survey/surveys/${id}/responses?limit=${limit}&offset=${offset}&filter=${filter}`
    ),
  /** Acciones sobre varias respuestas. `delete` requiere rol admin. */
  bulkResponses: (
    id: string,
    ids: string[],
    action: "exclude" | "include" | "test" | "untest" | "delete"
  ) =>
    request<{ affected: number }>(`/api/v1/survey/surveys/${id}/responses/bulk`, {
      method: "POST",
      body: JSON.stringify({ ids, action }),
    }),
  // ── Carpetas ───────────────────────────────────────────────────────────────
  listFolders: () => request<Folder[]>("/api/v1/survey/folders"),
  createFolder: (body: { name: string; parent_id?: string | null; color?: string }) =>
    request<Folder>("/api/v1/survey/folders", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateFolder: (
    id: string,
    body: { name?: string; color?: string; parent_id?: string | null; move_to_root?: boolean }
  ) =>
    request<Folder>(`/api/v1/survey/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteFolder: (id: string) =>
    request<void>(`/api/v1/survey/folders/${id}`, { method: "DELETE" }),
  /** Mueve encuestas a una carpeta; `folderId` null las deja sin clasificar. */
  moveSurveys: (surveyIds: string[], folderId: string | null) =>
    request<{ moved: number }>("/api/v1/survey/folders/move-surveys", {
      method: "POST",
      body: JSON.stringify({ survey_ids: surveyIds, folder_id: folderId }),
    }),
  /** Redacta con IA por qué cada opción incorrecta no lo es (una vez por
   *  pregunta al construir, no una vez por alumno). */
  explainOptions: (
    id: string,
    body: { title: string; correct: string[]; wrong: string[] }
  ) =>
    request<{ explanations: Record<string, string> }>(
      `/api/v1/survey/surveys/${id}/explain-options`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  // ---- Banco de preguntas e intercambio (GIFT / Aiken / Moodle XML) ----
  listBank: (params: { q?: string; topic?: string; tag?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<BankItem[]>(`/api/v1/survey/bank${qs.toString() ? `?${qs}` : ""}`);
  },
  bankFacets: () =>
    request<{ total: number; topics: { value: string; count: number }[]; tags: { value: string; count: number }[] }>(
      "/api/v1/survey/bank/facets"
    ),
  saveToBank: (items: { element: Record<string, unknown>; grading?: Record<string, unknown> | null; topic?: string; tags?: string[]; source_survey_id?: string }[]) =>
    request<{ created: number }>("/api/v1/survey/bank", { method: "POST", body: JSON.stringify({ items }) }),
  deleteBankItem: (iid: string) => request<void>(`/api/v1/survey/bank/${iid}`, { method: "DELETE" }),
  bankItemStats: (iid: string) =>
    request<{ used_in: number; responses: number; difficulty: number | null }>(`/api/v1/survey/bank/${iid}/stats`),
  importQuestions: async (id: string, src: { file?: File; text?: string }) => {
    const fd = new FormData();
    if (src.file) fd.append("file", src.file);
    if (src.text) fd.append("text", src.text);
    const res = await fetch(getApiUrl(`/api/v1/survey/surveys/${id}/questions/import`), {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `Error ${res.status}`);
    return j as {
      elements: Record<string, unknown>[];
      evaluation_questions: Record<string, Record<string, unknown>>;
      warnings: string[];
    };
  },
  exportQuestionsUrl: (id: string, format: "gift" | "moodle" | "qti") =>
    getApiUrl(`/api/v1/survey/surveys/${id}/questions/export?format=${format}`),
  listAppeals: (id: string) => request<GradeAppeal[]>(`/api/v1/survey/surveys/${id}/appeals`),
  resolveAppeal: (id: string, aid: string, body: { decision: "accept" | "reject"; reply: string; award?: number }) =>
    request<{ status: string }>(`/api/v1/survey/surveys/${id}/appeals/${aid}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listVersions: (id: string) =>
    request<SurveyVersionInfo[]>(`/api/v1/survey/surveys/${id}/versions`),
  getVersion: (id: string, vid: string) =>
    request<{ id: string; number: number; label: string | null; json_schema: Record<string, unknown>; evaluation: Record<string, unknown> | null; created_at: string }>(
      `/api/v1/survey/surveys/${id}/versions/${vid}`
    ),
  restoreVersion: (id: string, vid: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/versions/${vid}/restore`, { method: "POST" }),
  getAudit: (id: string) =>
    request<AuditEvent[]>(`/api/v1/survey/surveys/${id}/audit`),
  getResponseHistory: (id: string, rid: string) =>
    request<ResponseHistory>(`/api/v1/survey/surveys/${id}/responses/${rid}/history`),
  getDeletions: (id: string) =>
    request<ResponseDeletion[]>(`/api/v1/survey/surveys/${id}/deletions`),
  getReport: (id: string) =>
    request<{ report: ExecutiveReport | null }>(`/api/v1/survey/surveys/${id}/report`),
  generateReport: (id: string) =>
    request<{ report: ExecutiveReport }>(`/api/v1/survey/surveys/${id}/report`, {
      method: "POST",
    }),
  getSummary: (
    id: string,
    opts?: SummaryOptions
  ) => request<SummaryReport>(`/api/v1/survey/surveys/${id}/summary${summaryQuery(opts)}`),
  /** URL del cruce como planilla (se descarga con la cookie de sesión). */
  crosstabUrl: (id: string, opts: SummaryOptions, format: "csv" | "xlsx" = "csv") => {
    const q = summaryQuery(opts);
    return getApiUrl(
      `/api/v1/survey/surveys/${id}/summary/crosstab${q ? `${q}&` : "?"}format=${format}`
    );
  },
  getQuality: (id: string) =>
    request<QualityReport>(`/api/v1/survey/surveys/${id}/quality`),
  getFunnel: (id: string) =>
    request<Funnel>(`/api/v1/survey/surveys/${id}/funnel`),
  duplicateSurvey: (id: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/duplicate`, {
      method: "POST",
    }),

  // ---- Evaluation ----
  /** Encola la recorrección de todas las respuestas (en segundo plano: una
   *  encuesta grande ya no se corta por timeout). Seguir el avance con getJob. */
  gradeAll: (id: string) =>
    request<{ job_id: string; status: string }>(
      `/api/v1/survey/surveys/${id}/grade-all?only_ungraded=false&background=true`,
      { method: "POST" }
    ),
  getJob: (id: string, jobId: string) =>
    request<JobInfo>(`/api/v1/survey/surveys/${id}/jobs/${jobId}`),
  retryDelivery: (id: string, jobId: string) =>
    request<JobInfo>(`/api/v1/survey/surveys/${id}/deliveries/${jobId}/retry`, { method: "POST" }),
  reviewQueue: (id: string) =>
    request<ResponseItem[]>(`/api/v1/survey/surveys/${id}/review-queue`),
  override: (
    id: string,
    rid: string,
    body: {
      awards?: Record<string, number>;
      total?: number;
      clear_review?: boolean;
      note?: string;
      // Comentario reescrito por quien corrige, por pregunta.
      feedback?: Record<string, string>;
      // Visto bueno: sin él, si la encuesta lo exige, nadie lee el comentario.
      approve_feedback?: boolean;
    }
  ) =>
    request<ResponseItem>(
      `/api/v1/survey/surveys/${id}/responses/${rid}/override`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  analytics: (id: string) =>
    request<Analytics>(`/api/v1/survey/surveys/${id}/analytics`),
  getGradebook: (id: string) =>
    request<Gradebook>(`/api/v1/survey/surveys/${id}/gradebook`),
  response: (id: string, rid: string) =>
    request<ResponseItem>(`/api/v1/survey/surveys/${id}/responses/${rid}`),
  getInsights: (id: string) =>
    request<Insights>(`/api/v1/survey/surveys/${id}/insights`),
  generateInsights: (id: string) =>
    request<Insights>(`/api/v1/survey/surveys/${id}/insights`, { method: "POST" }),
  generateQuestions: (id: string, body: GenerateBody) =>
    request<GenerateResult>(`/api/v1/survey/surveys/${id}/generate-questions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Texto de un PDF/DOCX/HTML/TXT subido o de una página web, para usar como
   *  material de la generación. */
  extractMaterial: async (id: string, src: { file?: File; url?: string }) => {
    const fd = new FormData();
    if (src.file) fd.append("file", src.file);
    if (src.url) fd.append("url", src.url);
    const res = await fetch(getApiUrl(`/api/v1/survey/surveys/${id}/generate/material`), {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `Error ${res.status}`);
    return j as { text: string; chars: number; source: string };
  },
  reviewWording: (
    id: string,
    questions: { name: string; title: string; type: string; choices: string[]; rateMin?: number; rateMax?: number }[]
  ) =>
    request<{ questions: WordingReview[]; usage?: UsageInfo }>(`/api/v1/survey/surveys/${id}/review-wording`, {
      method: "POST",
      body: JSON.stringify({ questions }),
    }),
  suggestRubric: (id: string, name: string, body: { title?: string; model_answer?: string; points?: number }) =>
    request<{
      rubric: { label: string; points: number; description: string }[];
      keyConcepts: string[];
      common_errors: string[];
      sample_size: number;
      usage?: UsageInfo;
    }>(`/api/v1/survey/surveys/${id}/questions/${encodeURIComponent(name)}/suggest-rubric`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  ask: (id: string, question: string, segmentBy?: string | null) =>
    request<DataAnswer & { usage?: UsageInfo }>(`/api/v1/survey/surveys/${id}/ask`, {
      method: "POST",
      body: JSON.stringify({ question, segment_by: segmentBy || null }),
    }),

  // ---- Acceso: invitados (modo lista) y liberación de resultados ----
  listInvitees: (id: string) =>
    request<Invitee[]>(`/api/v1/survey/surveys/${id}/invitees`),
  addInvitees: (id: string, invitees: { email: string; name?: string }[]) =>
    request<Invitee[]>(`/api/v1/survey/surveys/${id}/invitees`, {
      method: "POST",
      body: JSON.stringify({ invitees }),
    }),
  deleteInvitee: (id: string, iid: string) =>
    request<void>(`/api/v1/survey/surveys/${id}/invitees/${iid}`, {
      method: "DELETE",
    }),
  sendInviteeLinks: (id: string) =>
    request<{ sent: number; total: number }>(
      `/api/v1/survey/surveys/${id}/invitees/send?only_unsent=true`,
      { method: "POST" }
    ),
  translations: (id: string) =>
    request<{ source_language: string; languages: TranslationCoverage[] }>(`/api/v1/survey/surveys/${id}/translations`),
  translationTexts: (id: string, lang: string) =>
    request<{ source: string; text: string | null }[]>(`/api/v1/survey/surveys/${id}/translations/${lang}`),
  editTranslation: (id: string, lang: string, items: Record<string, string>) =>
    request<TranslationCoverage[]>(`/api/v1/survey/surveys/${id}/translations/${lang}`, {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  deleteTranslation: (id: string, lang: string) =>
    request<void>(`/api/v1/survey/surveys/${id}/translations/${lang}`, { method: "DELETE" }),
  translate: (id: string, languages: string[], only_missing = true) =>
    request<{ translated: Record<string, number>; languages: TranslationCoverage[]; usage?: UsageInfo }>(
      `/api/v1/survey/surveys/${id}/translate`,
      { method: "POST", body: JSON.stringify({ languages, only_missing }) }
    ),
  quotaStatus: (id: string) => request<QuotaStatus[]>(`/api/v1/survey/surveys/${id}/quotas`),
  listTemplates: () => request<OrgTemplate[]>(`/api/v1/survey/templates`),
  saveTemplate: (survey_id: string, extra: { title?: string; description?: string; category?: string } = {}) =>
    request<OrgTemplate>(`/api/v1/survey/templates`, {
      method: "POST",
      body: JSON.stringify({ survey_id, ...extra }),
    }),
  useTemplate: (tid: string) =>
    request<SurveyDetail>(`/api/v1/survey/templates/${tid}/use`, { method: "POST" }),
  deleteTemplate: (tid: string) =>
    request<void>(`/api/v1/survey/templates/${tid}`, { method: "DELETE" }),
  inviteTracking: (id: string) =>
    request<InviteTracking>(`/api/v1/survey/surveys/${id}/invitees/tracking`),
  remindInvitees: (id: string) =>
    request<{ sent: number }>(`/api/v1/survey/surveys/${id}/invitees/remind`, { method: "POST" }),
  releaseResults: (id: string, released: boolean) =>
    request<SurveyDetail>(
      `/api/v1/survey/surveys/${id}/release-results?released=${released}`,
      { method: "POST" }
    ),
};

// Download the responses of a survey as CSV or XLSX (sends the session cookie).
export async function downloadResponses(id: string, format: "csv" | "xlsx"): Promise<void> {
  const res = await fetch(
    getApiUrl(`/api/v1/survey/surveys/${id}/export?format=${format}`),
    { credentials: "include", cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error((await res.text().catch(() => "")) || `No se pudo exportar (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `respuestas.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// A minimal, valid SurveyJS model used as the starting point for a new survey.
export const STARTER_SCHEMA = {
  title: "Nueva encuesta",
  pages: [
    {
      name: "page1",
      elements: [
        {
          type: "text",
          name: "nombre",
          title: "¿Cómo te llamás?",
        },
        {
          type: "rating",
          name: "recomendacion",
          title: "¿Qué tan probable es que nos recomiendes?",
          rateMin: 0,
          rateMax: 10,
        },
        {
          type: "comment",
          name: "comentario",
          title: "¿Algo que quieras contarnos?",
        },
      ],
    },
  ],
};
