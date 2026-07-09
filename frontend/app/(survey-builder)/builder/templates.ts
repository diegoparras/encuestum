// Ready-to-use survey templates. Each is a full SurveyJS schema + a theme
// (accent + font) and, for quizzes, an evaluation config with answer keys.

import { DEFAULT_DESIGN, designToTheme } from "./model";

export interface SurveyTemplate {
  id: string;
  name: string;
  description: string;
  category: "Feedback" | "Eventos" | "Educación" | "General";
  accent: string;
  fontFamily: string;
  title: string;
  json_schema: Record<string, any>;
  evaluation?: Record<string, any> | null;
}

const page = (elements: any[]) => ({
  showQuestionNumbers: "off",
  pages: [{ name: "page1", elements }],
});

export const SURVEY_TEMPLATES: SurveyTemplate[] = [
  {
    id: "blank",
    name: "En blanco",
    description: "Empezá desde cero con una sola pregunta.",
    category: "General",
    accent: "#e25a4e",
    fontFamily: "system",
    title: "Nueva encuesta",
    json_schema: page([{ type: "text", name: "q1", title: "Tu primera pregunta" }]),
  },
  {
    id: "nps",
    name: "NPS / Satisfacción",
    description: "Mide la recomendación y pedí un comentario.",
    category: "Feedback",
    accent: "#e25a4e",
    fontFamily: "poppins",
    title: "¿Qué tan probable es que nos recomiendes?",
    json_schema: page([
      { type: "rating", name: "nps", title: "Del 0 al 10, ¿qué tan probable es que nos recomiendes?", rateMin: 0, rateMax: 10, minRateDescription: "Nada probable", maxRateDescription: "Muy probable" },
      { type: "comment", name: "motivo", title: "¿Cuál es el motivo principal de tu puntaje?" },
    ]),
  },
  {
    id: "producto",
    name: "Feedback de producto",
    description: "Satisfacción, qué gustó y qué mejorar.",
    category: "Feedback",
    accent: "#4f46e5",
    fontFamily: "inter",
    title: "Contanos qué te pareció",
    json_schema: page([
      { type: "rating", name: "satisfaccion", title: "¿Qué tan satisfecho estás con el producto?", rateMin: 1, rateMax: 5 },
      { type: "checkbox", name: "gusto", title: "¿Qué es lo que más te gustó?", choices: ["Facilidad de uso", "Diseño", "Precio", "Atención", "Rendimiento"] },
      { type: "comment", name: "mejora", title: "¿Qué mejorarías?" },
    ]),
  },
  {
    id: "evento",
    name: "Registro a evento",
    description: "Datos del asistente y confirmación.",
    category: "Eventos",
    accent: "#10b981",
    fontFamily: "nunito",
    title: "Registro al evento",
    json_schema: page([
      { type: "text", name: "nombre", title: "Nombre y apellido", isRequired: true },
      { type: "text", name: "email", title: "Email", inputType: "email", isRequired: true, validators: [{ type: "email" }] },
      { type: "dropdown", name: "asistencia", title: "¿Vas a asistir?", choices: ["Sí, presencial", "Sí, virtual", "No puedo"] },
      { type: "comment", name: "comentarios", title: "¿Algo que quieras comentar?" },
    ]),
  },
  {
    id: "curso",
    name: "Evaluación de curso",
    description: "Feedback del alumnado sobre una clase.",
    category: "Educación",
    accent: "#8b5cf6",
    fontFamily: "lora",
    title: "¿Cómo estuvo el curso?",
    json_schema: page([
      { type: "rating", name: "claridad", title: "Claridad de las explicaciones", rateMin: 1, rateMax: 5 },
      { type: "rating", name: "ritmo", title: "Ritmo del curso", rateMin: 1, rateMax: 5 },
      { type: "rating", name: "material", title: "Utilidad del material", rateMin: 1, rateMax: 5 },
      { type: "comment", name: "sugerencias", title: "Sugerencias para mejorar" },
    ]),
  },
  {
    id: "quiz",
    name: "Quiz de conocimiento",
    description: "Examen con corrección automática de ejemplo.",
    category: "Educación",
    accent: "#f59e0b",
    fontFamily: "montserrat",
    title: "Quiz rápido",
    json_schema: page([
      { type: "radiogroup", name: "capital", title: "¿Cuál es la capital de Francia?", choices: ["Madrid", "París", "Roma", "Berlín"] },
      { type: "radiogroup", name: "planeta", title: "¿Cuál es el planeta más grande del sistema solar?", choices: ["Tierra", "Júpiter", "Marte", "Saturno"] },
      { type: "comment", name: "explica", title: "Explicá con tus palabras qué es la gravedad" },
    ]),
    evaluation: {
      enabled: true,
      feedbackTiming: "onComplete",
      passingScore: 60,
      showScoreToRespondent: true,
      questions: {
        capital: { gradable: true, grader: "auto", points: 1, title: "Capital de Francia", correct: ["París"] },
        planeta: { gradable: true, grader: "auto", points: 1, title: "Planeta más grande", correct: ["Júpiter"] },
        explica: { gradable: true, grader: "llm", points: 2, title: "Definición de gravedad", modelAnswer: "La gravedad es la fuerza de atracción entre cuerpos con masa.", keyConcepts: ["fuerza", "masa", "atracción"], rubric: [] },
      },
    },
  },
];

export function templatePayload(t: SurveyTemplate) {
  return {
    title: t.title,
    json_schema: t.json_schema,
    language: "es",
    theme: designToTheme(t.accent, { ...DEFAULT_DESIGN, fontFamily: t.fontFamily }),
    evaluation: t.evaluation ?? null,
  };
}
