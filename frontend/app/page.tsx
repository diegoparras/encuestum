import Link from "next/link";
import { EncuestumLogo } from "@/components/EncuestumLogo";
import {
  BarChart3,
  Building2,
  LayoutTemplate,
  ShieldCheck,
} from "lucide-react";

export const metadata = {
  title: "Encuestum — Encuestas y evaluaciones con corrección por IA",
  description:
    "Creá encuestas y evaluaciones con un editor visual y corrección híbrida por IA que no alucina. Panel del profesor con analítica e insights, y soporte multi-organización.",
};

const ACCENT = "#8faf0e";

const FEATURES = [
  {
    icon: LayoutTemplate,
    title: "Editor tipo Typeform",
    body: "Armá tus encuestas y exámenes con un editor visual, arrastrando preguntas y viendo el resultado en vivo.",
  },
  {
    icon: ShieldCheck,
    title: "Corrección híbrida por IA",
    body: "Puntaje automático para lo objetivo y corrección asistida por IA para lo abierto, anclada a la rúbrica para que no alucine.",
  },
  {
    icon: BarChart3,
    title: "Panel del profesor",
    body: "Analítica por pregunta, distribución de notas, cola de revisión e insights temáticos de las respuestas abiertas.",
  },
  {
    icon: Building2,
    title: "Multi-organización",
    body: "Trabajá en equipo: creá organizaciones, invitá miembros y gestioná roles con permisos claros.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      {/* Header */}
      <header className="border-b border-neutral-100">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <span className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <EncuestumLogo size={22} />
            Encuestum
          </span>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              Ingresar
            </Link>
            <Link
              href="/register"
              className="rounded-lg px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90"
              style={{ backgroundColor: ACCENT }}
            >
              Crear cuenta
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <span
            className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium"
            style={{ backgroundColor: "#fdecea", color: ACCENT }}
          >
            Encuestas · Evaluaciones · IA
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-neutral-900 sm:text-6xl">
            Encuestas y evaluaciones
            <br />
            con{" "}
            <span style={{ color: ACCENT }}>corrección por IA</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-neutral-500">
            Diseñá encuestas y exámenes con un editor visual, recibí respuestas y
            corregí en minutos con una IA anclada a tu rúbrica. Todo con analítica
            e insights para tu equipo.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/register"
              className="w-full rounded-lg px-6 py-3 text-center text-base font-semibold text-primary-foreground shadow-sm hover:opacity-90 sm:w-auto"
              style={{ backgroundColor: ACCENT }}
            >
              Crear cuenta
            </Link>
            <Link
              href="/login"
              className="w-full rounded-lg border border-neutral-300 px-6 py-3 text-center text-base font-semibold text-neutral-800 hover:bg-neutral-50 sm:w-auto"
            >
              Ingresar
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-neutral-100 bg-neutral-50">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-neutral-900">
              Todo lo que necesitás para evaluar mejor
            </h2>
            <p className="mt-3 text-neutral-500">
              Desde el diseño de la encuesta hasta el análisis de resultados.
            </p>
          </div>
          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
              >
                <span
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg"
                  style={{ backgroundColor: "#fdecea", color: ACCENT }}
                >
                  <f.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-neutral-900">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm text-neutral-500">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div
          className="rounded-2xl px-8 py-12 text-center text-[#1e2a06] sm:px-16 sm:py-16"
          style={{ backgroundColor: ACCENT }}
        >
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Empezá gratis hoy
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-[#1e2a06]/80">
            Creá tu primera encuesta o evaluación en minutos. Sin tarjeta de
            crédito.
          </p>
          <Link
            href="/register"
            className="mt-8 inline-block rounded-lg bg-white px-6 py-3 text-base font-semibold shadow-sm hover:bg-neutral-50"
            style={{ color: ACCENT }}
          >
            Crear cuenta
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-100">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-8 text-sm text-neutral-400 sm:flex-row sm:px-6">
          <span className="flex items-center gap-2">
            <EncuestumLogo size={18} />
            Encuestum
          </span>
          <span>© {new Date().getFullYear()} Encuestum</span>
        </div>
      </footer>
    </div>
  );
}
