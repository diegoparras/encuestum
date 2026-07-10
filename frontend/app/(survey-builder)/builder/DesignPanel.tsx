"use client";

import React, { useEffect, useState } from "react";
import { X, Type, Palette, Image as ImageIcon, Music, Check, Sparkles, Contrast, Sun, Moon, Search, Square, Wand2, MousePointerClick, AlignCenter, AlignLeft } from "lucide-react";
import {
  ACCENT_PALETTE,
  AudioSettings,
  DesignSettings,
  FONT_OPTIONS,
  FontOption,
  GOOGLE_FONT_FAMILIES,
  THEME_PRESETS,
  ThemePreset,
  applyThemePreset,
  fontById,
  fontCssFamily,
  fontFromFamily,
  readableForeground,
  PAGE_TRANSITIONS,
} from "./model";
import { loadFont } from "./design";
import { AssetPicker } from "./AssetPicker";
import { Switch } from "@/components/ui/switch";

interface Props {
  open: boolean;
  onClose: () => void;
  design: DesignSettings;
  onChange: (d: DesignSettings) => void;
  accent: string;
  onAccentChange: (a: string) => void;
}

const DEFAULT_AUDIO: AudioSettings = {
  url: "",
  loop: true,
  autoplay: false,
  volume: 0.6,
};

// Unión de destacadas + catálogo amplio de Google Fonts, sin duplicar las que ya
// existen como opción curada (comparando por nombre). Base del buscador.
const CURATED_LABELS = new Set(FONT_OPTIONS.map((f) => f.label.toLowerCase()));
const ALL_FONTS: FontOption[] = [
  ...FONT_OPTIONS,
  ...GOOGLE_FONT_FAMILIES.filter(
    (fam) => !CURATED_LABELS.has(fam.toLowerCase()),
  ).map((fam) => fontFromFamily(fam)),
];
// Tope de resultados visibles (evita cargar cientos de hojas de estilo).
const MAX_FONT_RESULTS = 40;

export function DesignPanel({
  open,
  onClose,
  design,
  onChange,
  accent,
  onAccentChange,
}: Props) {
  // Buscador de tipografías: query en vivo + versión con debounce (~150ms).
  const [fontQuery, setFontQuery] = useState("");
  const [debouncedFontQuery, setDebouncedFontQuery] = useState("");

  // Preload every visible font so the type list previews in its real face.
  useEffect(() => {
    if (!open) return;
    FONT_OPTIONS.forEach((f) => loadFont(f.id));
    THEME_PRESETS.forEach((p) => loadFont(p.fontFamily));
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounce del input del buscador.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFontQuery(fontQuery.trim()), 150);
    return () => clearTimeout(t);
  }, [fontQuery]);

  const fontSearchTerm = debouncedFontQuery.toLowerCase();
  const searchingFonts = fontSearchTerm.length > 0;
  const filteredFonts: FontOption[] = searchingFonts
    ? ALL_FONTS.filter((f) => f.label.toLowerCase().includes(fontSearchTerm)).slice(
        0,
        MAX_FONT_RESULTS,
      )
    : [];

  // Precarga la fuente real de cada resultado visible (tope MAX_FONT_RESULTS)
  // para que se previsualice en su propia cara.
  useEffect(() => {
    if (!open || !searchingFonts) return;
    filteredFonts.forEach((f) => loadFont(f.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debouncedFontQuery]);

  if (!open) return null;

  const patch = (p: Partial<DesignSettings>) => onChange({ ...design, ...p });

  const audio = design.audio ?? null;
  const patchAudio = (p: Partial<AudioSettings>) => {
    const base = audio ?? DEFAULT_AUDIO;
    patch({ audio: { ...base, ...p } });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in"
        onClick={onClose}
      />

      {/* Slide-over */}
      <div className="relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-800">
            <Palette className="w-4 h-4" style={{ color: accent }} /> Diseño
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {/* Temas */}
          <Section icon={<Sparkles className="w-4 h-4" />} title="Temas">
            <div className="grid grid-cols-2 gap-2">
              {THEME_PRESETS.map((preset) => {
                const active =
                  design.fontFamily === preset.fontFamily &&
                  accent.toLowerCase() === preset.accent.toLowerCase();
                return (
                  <ThemeCard
                    key={preset.id}
                    preset={preset}
                    active={active}
                    onClick={() => {
                      onChange(applyThemePreset(design, preset));
                      onAccentChange(preset.accent);
                    }}
                  />
                );
              })}
            </div>
          </Section>

          {/* Tipografía */}
          <Section icon={<Type className="w-4 h-4" />} title="Tipografía">
            {/* Buscador de Google Fonts */}
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                value={fontQuery}
                onChange={(e) => setFontQuery(e.target.value)}
                placeholder="Buscar en Google Fonts…"
                className="w-full rounded-lg border border-neutral-200 py-2 pl-9 pr-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-[#8faf0e] focus:outline-none focus:ring-1 focus:ring-[#8faf0e]"
              />
            </div>

            {searchingFonts ? (
              <>
                {/* Chip "Actual" cuando la fuente aplicada no está en los resultados */}
                {!filteredFonts.some((f) => f.id === design.fontFamily) && (
                  <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#8faf0e] bg-[#8faf0e0a] px-2.5 py-1 text-xs text-neutral-700">
                    <span className="text-neutral-400">Actual:</span>
                    <span
                      className="truncate"
                      style={{ fontFamily: fontCssFamily(design.fontFamily) }}
                    >
                      {fontById(design.fontFamily).label}
                    </span>
                  </div>
                )}

                {filteredFonts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-neutral-400">
                    Sin resultados para “{debouncedFontQuery}”.
                  </p>
                ) : (
                  <ul className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
                    {filteredFonts.map((f) => {
                      const active = design.fontFamily === f.id;
                      return (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => patch({ fontFamily: f.id })}
                            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                              active
                                ? "border-[#8faf0e] bg-[#8faf0e0a]"
                                : "border-neutral-200 hover:border-neutral-300"
                            }`}
                          >
                            <span
                              className="truncate text-base text-neutral-800"
                              style={{ fontFamily: f.css }}
                            >
                              {f.label}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-neutral-400">
                              {f.category}
                            </span>
                            {active && (
                              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#8faf0e] text-[#1e2a06]">
                                <Check className="w-2.5 h-2.5" />
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {FONT_OPTIONS.map((f) => {
                  const active = design.fontFamily === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => patch({ fontFamily: f.id })}
                      className={`relative rounded-lg border px-3 py-3 text-left transition-colors ${
                        active
                          ? "border-[#8faf0e] bg-[#8faf0e0a]"
                          : "border-neutral-200 hover:border-neutral-300"
                      }`}
                    >
                      <div
                        className="truncate text-base text-neutral-800"
                        style={{ fontFamily: fontCssFamily(f.id) }}
                      >
                        {f.label}
                      </div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                        {f.category}
                      </div>
                      {active && (
                        <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-[#8faf0e] text-[#1e2a06]">
                          <Check className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Color de acento */}
          <Section icon={<Palette className="w-4 h-4" />} title="Color de acento">
            <div className="grid grid-cols-5 gap-2">
              {ACCENT_PALETTE.map((c) => {
                const active = c.value.toLowerCase() === accent.toLowerCase();
                return (
                  <button
                    key={c.value}
                    type="button"
                    title={c.name}
                    onClick={() => onAccentChange(c.value)}
                    className="relative aspect-square rounded-lg ring-1 ring-black/5 transition-transform hover:scale-105"
                    style={{ backgroundColor: c.value }}
                  >
                    {active && (
                      <Check
                        className="absolute inset-0 m-auto w-4 h-4"
                        style={{ color: readableForeground(c.value) }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(accent) ? accent : "#8faf0e"}
                onChange={(e) => onAccentChange(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
                title="Color personalizado"
              />
              <span className="text-xs text-neutral-500">Personalizado</span>
            </div>
          </Section>

          {/* Color de fondo */}
          <Section icon={<Palette className="w-4 h-4" />} title="Color de fondo">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={
                  design.backgroundColor && /^#[0-9a-f]{6}$/i.test(design.backgroundColor)
                    ? design.backgroundColor
                    : "#f6f6f7"
                }
                onChange={(e) => patch({ backgroundColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
              />
              <span className="flex-1 text-xs text-neutral-500">
                {design.backgroundColor ?? "Sin color (predeterminado)"}
              </span>
              {design.backgroundColor && (
                <button
                  type="button"
                  onClick={() => patch({ backgroundColor: undefined })}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                >
                  Sin color
                </button>
              )}
            </div>
          </Section>

          {/* Modo y legibilidad */}
          <Section icon={<Contrast className="w-4 h-4" />} title="Modo y legibilidad">
            {/* Claro / Oscuro */}
            <div className="grid grid-cols-2 gap-2">
              {(["light", "dark"] as const).map((m) => {
                const active = (design.mode ?? "light") === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patch({ mode: m })}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300"
                    }`}
                  >
                    {m === "light" ? (
                      <Sun className="w-4 h-4" />
                    ) : (
                      <Moon className="w-4 h-4" />
                    )}
                    {m === "light" ? "Claro" : "Oscuro"}
                  </button>
                );
              })}
            </div>

            {/* Color del texto de las preguntas */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs text-neutral-600">
                Color del texto de las preguntas
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={
                    design.textColor && /^#[0-9a-f]{6}$/i.test(design.textColor)
                      ? design.textColor
                      : design.mode === "dark"
                        ? "#f2f4f8"
                        : "#1f2937"
                  }
                  onChange={(e) => patch({ textColor: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
                />
                <span className="flex-1 text-xs text-neutral-500">
                  {design.textColor ?? "Automático según el modo"}
                </span>
                {design.textColor && (
                  <button
                    type="button"
                    onClick={() => patch({ textColor: undefined })}
                    className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    Automático
                  </button>
                )}
              </div>
            </div>

          </Section>

          {/* Cuadros de las preguntas */}
          <Section icon={<Square className="w-4 h-4" />} title="Cuadros de las preguntas">
            {/* Color de los cuadros */}
            <div>
              <div className="mb-1.5 text-xs text-neutral-600">
                Color de los cuadros
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={
                    design.questionColor && /^#[0-9a-f]{6}$/i.test(design.questionColor)
                      ? design.questionColor
                      : design.mode === "dark"
                        ? "#1f2430"
                        : "#ffffff"
                  }
                  onChange={(e) => patch({ questionColor: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
                />
                <span className="flex-1 text-xs text-neutral-500">
                  {design.questionColor ?? "Automático según el modo"}
                </span>
                {design.questionColor && (
                  <button
                    type="button"
                    onClick={() => patch({ questionColor: undefined })}
                    className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    Automático
                  </button>
                )}
              </div>
            </div>

            {/* Opacidad de los cuadros */}
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-xs text-neutral-600">
                <span>Opacidad</span>
                <span className="tabular-nums text-neutral-400">
                  {Math.round((design.questionOpacity ?? 1) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round((design.questionOpacity ?? 1) * 100)}
                onChange={(e) =>
                  patch({ questionOpacity: Number(e.target.value) / 100 })
                }
                className="w-full accent-[#8faf0e]"
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                Bajala para ver el fondo a través de los cuadros (efecto vidrio).
              </p>
            </div>

            {/* Color del texto de los cuadros (independiente del de las preguntas) */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs text-neutral-600">
                Color del texto de los cuadros
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={
                    design.inputTextColor && /^#[0-9a-f]{6}$/i.test(design.inputTextColor)
                      ? design.inputTextColor
                      : readableForeground(
                          design.questionColor ||
                            (design.mode === "dark" ? "#252b36" : "#ffffff")
                        )
                  }
                  onChange={(e) => patch({ inputTextColor: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
                />
                <span className="flex-1 text-xs text-neutral-500">
                  {design.inputTextColor ?? "Automático (legible sobre el cuadro)"}
                </span>
                {design.inputTextColor && (
                  <button
                    type="button"
                    onClick={() => patch({ inputTextColor: undefined })}
                    className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    Automático
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                Lo que se escribe dentro de los campos. No hereda el color del
                texto de las preguntas.
              </p>
            </div>

            {/* Vidrio esmerilado (glass) */}
            <div className="mt-4">
              <ToggleRow
                label="Vidrio esmerilado"
                checked={!!design.glass}
                onChange={(v) => patch({ glass: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                Desenfoca lo que hay detrás de los cuadros. Combínalo con opacidad
                &lt; 100% y una imagen de fondo.
              </p>
            </div>

            {/* Preguntas transparentes (atajo de opacidad 0) */}
            <div className="mt-4">
              <ToggleRow
                label="Preguntas transparentes"
                checked={!!design.transparentQuestions}
                onChange={(v) => patch({ transparentQuestions: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                Atajo de opacidad 0: saca la franja detrás de las preguntas para que
                se vea el fondo. Ideal cuando usás una imagen de fondo.
              </p>
            </div>

            {/* Contenedor por pregunta (separador) */}
            <div className="mt-4">
              <ToggleRow
                label="Contenedor por pregunta"
                checked={!!design.questionSeparator}
                onChange={(v) => patch({ questionSeparator: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                Dibuja un marco sutil alrededor de cada pregunta, separándolas.
                Queda genial con cuadros transparentes o glass.
              </p>
            </div>
          </Section>

          {/* Botones */}
          <Section icon={<MousePointerClick className="w-4 h-4" />} title="Botones">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={
                  design.buttonColor && /^#[0-9a-f]{6}$/i.test(design.buttonColor)
                    ? design.buttonColor
                    : /^#[0-9a-f]{6}$/i.test(accent)
                      ? accent
                      : "#8faf0e"
                }
                onChange={(e) => patch({ buttonColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
              />
              <span className="flex-1 text-xs text-neutral-500">
                {design.buttonColor ?? "Automático (color de acento)"}
              </span>
              {design.buttonColor && (
                <button
                  type="button"
                  onClick={() => patch({ buttonColor: undefined })}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                >
                  Automático
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
              Color de los botones Siguiente / Anterior / Completar, independiente
              del acento.
            </p>
            <div className="mt-4">
              <ToggleRow
                label="Sombra en los botones"
                checked={!!design.buttonShadow}
                onChange={(v) => patch({ buttonShadow: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
                Les da profundidad — se nota más sobre fondos con imagen.
              </p>
            </div>
          </Section>

          {/* Alineación */}
          <Section icon={<AlignCenter className="w-4 h-4" />} title="Alineación">
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "left", label: "Izquierda", icon: AlignLeft },
                  { value: "center", label: "Centrado", icon: AlignCenter },
                ] as const
              ).map((opt) => {
                const active = (design.alignment ?? "left") === opt.value;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => patch({ alignment: opt.value })}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
              Centra el título, las preguntas y los botones.
            </p>
          </Section>

          {/* Transiciones */}
          <Section icon={<Wand2 className="w-4 h-4" />} title="Transiciones">
            <div className="grid grid-cols-2 gap-2">
              {PAGE_TRANSITIONS.map((opt) => {
                const active = (design.pageTransition ?? "none") === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => patch({ pageTransition: opt.id })}
                    className={`flex items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
              Se ven cuando usás una pregunta por pantalla.
            </p>
          </Section>

          {/* Imagen de fondo */}
          <Section icon={<ImageIcon className="w-4 h-4" />} title="Imagen de fondo">
            <AssetPicker
              kind="image"
              value={design.backgroundImage}
              onChange={(url) => patch({ backgroundImage: url })}
            />
            {design.backgroundImage && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-neutral-600">
                  <span>Opacidad</span>
                  <span className="tabular-nums text-neutral-400">
                    {Math.round((design.backgroundOpacity ?? 1) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((design.backgroundOpacity ?? 1) * 100)}
                  onChange={(e) =>
                    patch({ backgroundOpacity: Number(e.target.value) / 100 })
                  }
                  className="w-full accent-[#8faf0e]"
                />
              </div>
            )}
          </Section>

          {/* Portada */}
          <Section icon={<ImageIcon className="w-4 h-4" />} title="Portada (cover)">
            <AssetPicker
              kind="image"
              value={design.coverImage}
              onChange={(url) => patch({ coverImage: url })}
            />
          </Section>

          {/* Logo */}
          <Section icon={<ImageIcon className="w-4 h-4" />} title="Logo">
            <AssetPicker
              kind="image"
              value={design.logo}
              onChange={(url) => patch({ logo: url })}
            />
          </Section>

          {/* Música de fondo */}
          <Section icon={<Music className="w-4 h-4" />} title="Música de fondo">
            <AssetPicker
              kind="audio"
              value={audio?.url || undefined}
              onChange={(url) =>
                url
                  ? patchAudio({ url })
                  : patch({ audio: null })
              }
            />
            {audio?.url && (
              <div className="mt-3 space-y-3">
                <ToggleRow
                  label="Repetir en bucle"
                  checked={audio.loop}
                  onChange={(v) => patchAudio({ loop: v })}
                />
                <ToggleRow
                  label="Reproducir automáticamente"
                  checked={audio.autoplay}
                  onChange={(v) => patchAudio({ autoplay: v })}
                />
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-neutral-600">
                    <span>Volumen</span>
                    <span className="tabular-nums text-neutral-400">
                      {Math.round((audio.volume ?? 0.6) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round((audio.volume ?? 0.6) * 100)}
                    onChange={(e) =>
                      patchAudio({ volume: Number(e.target.value) / 100 })
                    }
                    className="w-full accent-[#8faf0e]"
                  />
                </div>
                <p className="text-[11px] leading-relaxed text-neutral-400">
                  Los navegadores pueden requerir un toque para reproducir con
                  sonido.
                </p>
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  preset,
  active,
  onClick,
}: {
  preset: ThemePreset;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative overflow-hidden rounded-lg border text-left transition-colors ${
        active
          ? "border-[#8faf0e] ring-1 ring-[#8faf0e]"
          : "border-neutral-200 hover:border-neutral-300"
      }`}
    >
      <div
        className="flex items-center gap-2 px-3 py-3"
        style={{ backgroundColor: preset.backgroundColor }}
      >
        <span
          className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/5"
          style={{ backgroundColor: preset.accent }}
        />
        <span
          className="truncate text-sm"
          style={{
            fontFamily: fontById(preset.fontFamily).css,
            color: readableForeground(preset.backgroundColor),
          }}
        >
          {preset.name}
        </span>
      </div>
      {active && (
        <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-[#8faf0e] text-[#1e2a06]">
          <Check className="w-2.5 h-2.5" />
        </span>
      )}
    </button>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7">
      <h3 className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        <span className="text-neutral-400">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-700">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
