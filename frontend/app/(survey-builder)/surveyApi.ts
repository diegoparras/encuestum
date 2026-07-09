import { getApiUrl } from "@/utils/api";

export const SURVEY_ACCENT = "#e25a4e";

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
}

export interface SurveyDetail {
  id: string;
  title: string | null;
  slug: string;
  status: "draft" | "published" | "closed";
  language: string | null;
  json_schema: Record<string, any>;
  theme: Record<string, any> | null;
  evaluation: Record<string, any> | null;
  created_at: string;
  updated_at: string;
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
    responses: number;
    avg_score_pct: number | null;
    correct_rate: number;
  }[];
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
}

export interface GeneratedQuestion {
  type: string;
  title: string;
  choices: string[];
  correctIndices: number[];
  modelAnswer: string;
  keyConcepts: string[];
  rubric: { label: string; points: number }[];
  points: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getApiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const surveyApi = {
  list: () => request<SurveySummary[]>("/api/v1/survey/surveys"),
  get: (id: string) => request<SurveyDetail>(`/api/v1/survey/surveys/${id}`),
  create: (body: { title?: string; json_schema?: Record<string, any>; language?: string }) =>
    request<SurveyDetail>("/api/v1/survey/surveys", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (
    id: string,
    body: Partial<
      Pick<SurveyDetail, "title" | "json_schema" | "status" | "language" | "theme" | "evaluation">
    >
  ) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  publish: (id: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/publish`, { method: "POST" }),
  close: (id: string) =>
    request<SurveyDetail>(`/api/v1/survey/surveys/${id}/close`, { method: "POST" }),
  remove: (id: string) =>
    request<void>(`/api/v1/survey/surveys/${id}`, { method: "DELETE" }),
  responses: (id: string) =>
    request<ResponseItem[]>(`/api/v1/survey/surveys/${id}/responses`),

  // ---- Evaluation ----
  gradeAll: (id: string) =>
    request<{ graded: number; total: number }>(
      `/api/v1/survey/surveys/${id}/grade-all?only_ungraded=false`,
      { method: "POST" }
    ),
  reviewQueue: (id: string) =>
    request<ResponseItem[]>(`/api/v1/survey/surveys/${id}/review-queue`),
  override: (
    id: string,
    rid: string,
    body: { awards?: Record<string, number>; total?: number; clear_review?: boolean; note?: string }
  ) =>
    request<ResponseItem>(
      `/api/v1/survey/surveys/${id}/responses/${rid}/override`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  analytics: (id: string) =>
    request<Analytics>(`/api/v1/survey/surveys/${id}/analytics`),
  response: (id: string, rid: string) =>
    request<ResponseItem>(`/api/v1/survey/surveys/${id}/responses/${rid}`),
  getInsights: (id: string) =>
    request<Insights>(`/api/v1/survey/surveys/${id}/insights`),
  generateInsights: (id: string) =>
    request<Insights>(`/api/v1/survey/surveys/${id}/insights`, { method: "POST" }),
  generateQuestions: (
    id: string,
    body: { topic: string; count: number; types: string[]; language: string; difficulty?: string; context?: string }
  ) =>
    request<{ questions: GeneratedQuestion[] }>(
      `/api/v1/survey/surveys/${id}/generate-questions`,
      { method: "POST", body: JSON.stringify(body) }
    ),
};

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
