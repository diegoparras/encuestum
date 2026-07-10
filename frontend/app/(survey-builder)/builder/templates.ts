// Ready-to-use survey templates. Each is a full SurveyJS schema + a theme
// (accent + font) and, for quizzes, an evaluation config with answer keys.

import { DEFAULT_DESIGN, designToTheme } from "./model";

export interface SurveyTemplate {
  id: string;
  name: string;
  description: string;
  category: "Feedback" | "Eventos" | "Educación" | "RRHH" | "Producto" | "General";
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
    accent: "#8faf0e",
    fontFamily: "system",
    title: "Nueva encuesta",
    json_schema: page([{ type: "text", name: "q1", title: "Tu primera pregunta" }]),
  },
  {
    id: "nps",
    name: "NPS / Satisfacción",
    description: "Mide la recomendación y pedí un comentario.",
    category: "Feedback",
    accent: "#8faf0e",
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
  {
    id: "csat",
    name: "CSAT · Satisfacción",
    description: "Mide la satisfacción tras una interacción o compra.",
    category: "Feedback",
    accent: "#0ea5e9",
    fontFamily: "inter",
    title: "¿Cómo fue tu experiencia?",
    json_schema: page([
      { type: "rating", name: "csat", title: "¿Qué tan satisfecho quedaste?", rateType: "smileys", rateMax: 5, minRateDescription: "Muy insatisfecho", maxRateDescription: "Muy satisfecho" },
      { type: "comment", name: "porque", title: "¿Qué influyó en tu respuesta?" },
    ]),
  },
  {
    id: "ces",
    name: "CES · Esfuerzo del cliente",
    description: "¿Cuánto esfuerzo le costó al cliente resolver lo suyo?",
    category: "Feedback",
    accent: "#14b8a6",
    fontFamily: "dmsans",
    title: "Un par de preguntas rápidas",
    json_schema: page([
      { type: "rating", name: "ces", title: "«La empresa me facilitó resolver mi problema.»", rateMin: 1, rateMax: 7, minRateDescription: "Muy en desacuerdo", maxRateDescription: "Muy de acuerdo" },
      { type: "comment", name: "friccion", title: "¿Dónde sentiste más fricción?" },
    ]),
  },
  {
    id: "pmf",
    name: "Product-Market Fit",
    description: "El clásico de Superhuman: mide qué tan indispensable sos.",
    category: "Producto",
    accent: "#6366f1",
    fontFamily: "poppins",
    title: "Ayudanos a mejorar el producto",
    json_schema: page([
      { type: "radiogroup", name: "pmf", title: "¿Cómo te sentirías si ya no pudieras usar el producto?", isRequired: true, choices: ["Muy decepcionado", "Algo decepcionado", "No me importaría"] },
      { type: "text", name: "perfil", title: "¿Qué tipo de persona creés que sacaría más provecho del producto?" },
      { type: "comment", name: "beneficio", title: "¿Cuál es el principal beneficio que obtenés?" },
      { type: "comment", name: "mejora", title: "¿Cómo podríamos mejorar el producto para vos?" },
    ]),
  },
  {
    id: "enps",
    name: "eNPS · Clima laboral",
    description: "Recomendación y bienestar del equipo, anónima.",
    category: "RRHH",
    accent: "#8faf0e",
    fontFamily: "nunito",
    title: "¿Cómo estás en el trabajo?",
    json_schema: page([
      { type: "rating", name: "enps", title: "¿Qué tan probable es que recomiendes este lugar para trabajar?", rateMin: 0, rateMax: 10, minRateDescription: "Nada probable", maxRateDescription: "Muy probable" },
      { type: "rating", name: "bienestar", title: "¿Cómo calificás tu bienestar general esta semana?", rateType: "smileys", rateMax: 5 },
      { type: "checkbox", name: "aspectos", title: "¿Qué aspectos valorás más?", choices: ["Equipo", "Liderazgo", "Autonomía", "Aprendizaje", "Balance vida-trabajo", "Compensación"] },
      { type: "comment", name: "sugerencia", title: "¿Qué cambiarías si pudieras?" },
    ]),
  },
  {
    id: "360",
    name: "Evaluación 360°",
    description: "Feedback de desempeño de un colaborador desde varios ángulos.",
    category: "RRHH",
    accent: "#7c3aed",
    fontFamily: "dmsans",
    title: "Evaluación de desempeño",
    json_schema: page([
      { type: "text", name: "evaluado", title: "¿A quién estás evaluando?", isRequired: true },
      { type: "rating", name: "comunicacion", title: "Comunicación", rateMin: 1, rateMax: 5 },
      { type: "rating", name: "colaboracion", title: "Colaboración y trabajo en equipo", rateMin: 1, rateMax: 5 },
      { type: "rating", name: "responsabilidad", title: "Responsabilidad y cumplimiento", rateMin: 1, rateMax: 5 },
      { type: "rating", name: "liderazgo", title: "Liderazgo / iniciativa", rateMin: 1, rateMax: 5 },
      { type: "comment", name: "fortalezas", title: "Principales fortalezas" },
      { type: "comment", name: "mejorar", title: "Áreas de mejora" },
    ]),
  },
  {
    id: "postulacion",
    name: "Postulación a un puesto",
    description: "Formulario de candidatura con respuesta abierta corregida por IA.",
    category: "RRHH",
    accent: "#2563eb",
    fontFamily: "inter",
    title: "Postulate al puesto",
    json_schema: page([
      { type: "text", name: "nombre", title: "Nombre y apellido", isRequired: true },
      { type: "text", name: "email", title: "Email", inputType: "email", isRequired: true, validators: [{ type: "email" }] },
      { type: "dropdown", name: "seniority", title: "Nivel de experiencia", choices: ["Junior", "Semi-senior", "Senior", "Lead"] },
      { type: "text", name: "portfolio", title: "Link a tu portfolio / LinkedIn", inputType: "url" },
      { type: "comment", name: "motivacion", title: "Contanos por qué querés este puesto y qué aportarías", isRequired: true },
    ]),
    evaluation: {
      enabled: true,
      feedbackTiming: "manual",
      passingScore: 60,
      showScoreToRespondent: false,
      questions: {
        motivacion: { gradable: true, grader: "llm", points: 10, title: "Carta de motivación", modelAnswer: "", keyConcepts: ["motivación clara", "aporte concreto", "alineación con el rol", "comunicación"], rubric: [] },
      },
    },
  },
  {
    id: "examen",
    name: "Examen completo",
    description: "Prueba con opción múltiple y desarrollo corregido por IA.",
    category: "Educación",
    accent: "#f59e0b",
    fontFamily: "montserrat",
    title: "Examen",
    json_schema: {
      showQuestionNumbers: "on",
      pages: [
        {
          name: "page1",
          elements: [
            { type: "radiogroup", name: "mc1", title: "¿Qué gas absorben las plantas en la fotosíntesis?", choices: ["Oxígeno", "Dióxido de carbono", "Nitrógeno", "Hidrógeno"] },
            { type: "checkbox", name: "mc2", title: "Seleccioná los números primos", choices: ["2", "4", "7", "9", "11"] },
            { type: "text", name: "corta", title: "¿En qué año llegó el hombre a la Luna?" },
            { type: "comment", name: "desarrollo", title: "Explicá con tus palabras las causas de la Revolución Industrial", isRequired: true },
          ],
        },
      ],
    },
    evaluation: {
      enabled: true,
      feedbackTiming: "onComplete",
      passingScore: 60,
      showScoreToRespondent: true,
      questions: {
        mc1: { gradable: true, grader: "auto", points: 1, title: "Fotosíntesis", correct: ["Dióxido de carbono"] },
        mc2: { gradable: true, grader: "auto", points: 2, title: "Números primos", correct: ["2", "7", "11"] },
        corta: { gradable: true, grader: "auto", points: 1, title: "Llegada a la Luna", correct: ["1969"] },
        desarrollo: { gradable: true, grader: "llm", points: 4, title: "Revolución Industrial", modelAnswer: "Cambios en producción, máquina de vapor, urbanización y transformación social/económica.", keyConcepts: ["máquina de vapor", "producción fabril", "urbanización", "cambio social"], rubric: [] },
      },
    },
  },
  {
    id: "contacto",
    name: "Contacto / Leads",
    description: "Captá consultas y datos de contacto.",
    category: "General",
    accent: "#0f766e",
    fontFamily: "inter",
    title: "Escribinos",
    json_schema: page([
      { type: "text", name: "nombre", title: "Nombre", isRequired: true },
      { type: "text", name: "email", title: "Email", inputType: "email", isRequired: true, validators: [{ type: "email" }] },
      { type: "text", name: "empresa", title: "Empresa (opcional)" },
      { type: "dropdown", name: "motivo", title: "¿En qué te podemos ayudar?", choices: ["Ventas", "Soporte", "Alianzas", "Otro"] },
      { type: "comment", name: "mensaje", title: "Tu mensaje", isRequired: true },
    ]),
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
