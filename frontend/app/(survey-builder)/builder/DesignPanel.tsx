"use client";

import React, { useEffect, useState } from "react";
import { X, Type, Palette, Image as ImageIcon, Music, Check, Sparkles, Contrast, Sun, Moon, Search, Square, Wand2, MousePointerClick, AlignCenter, AlignLeft, MessagesSquare, PartyPopper, Plus, Trash2, Loader2, Lock } from "lucide-react";
import {
  ACCENT_PALETTE,
  AudioSettings,
  DesignSettings,
  StateScreenConfig,
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
  CHAT_SKINS,
  DEFAULT_CHAT,
  THANKYOU_ICONS,
  DEFAULT_THANKYOU,
  CELEBRATIONS,
} from "./model";
import { loadFont } from "./design";
import { AssetPicker } from "./AssetPicker";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
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
      <div className="relative flex h-full w-full max-w-md flex-col bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-5 py-4">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            <Palette className="w-4 h-4" style={{ color: accent }} /> {t("builder.design.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {/* Temas */}
          <Section icon={<Sparkles className="w-4 h-4" />} title={t("builder.design.themes")}>
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
          <Section icon={<Type className="w-4 h-4" />} title={t("builder.design.typography")}>
            {/* Buscador de Google Fonts */}
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400 dark:text-neutral-500" />
              <input
                type="text"
                value={fontQuery}
                onChange={(e) => setFontQuery(e.target.value)}
                placeholder={t("builder.design.fontSearchPlaceholder")}
                className="w-full rounded-lg border border-neutral-200 py-2 pl-9 pr-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-[#8faf0e] focus:outline-none focus:ring-1 focus:ring-[#8faf0e] dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
            </div>

            {searchingFonts ? (
              <>
                {/* Chip "Actual" cuando la fuente aplicada no está en los resultados */}
                {!filteredFonts.some((f) => f.id === design.fontFamily) && (
                  <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#8faf0e] bg-[#8faf0e0a] px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-300">
                    <span className="text-neutral-400 dark:text-neutral-500">{t("builder.design.current")}</span>
                    <span
                      className="truncate"
                      style={{ fontFamily: fontCssFamily(design.fontFamily) }}
                    >
                      {design.fontFamily === "system" ? t("builder.font.system") : fontById(design.fontFamily).label}
                    </span>
                  </div>
                )}

                {filteredFonts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    {t("builder.design.noFontResults", { q: debouncedFontQuery })}
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
                                : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600"
                            }`}
                          >
                            <span
                              className="truncate text-base text-neutral-800 dark:text-neutral-100"
                              style={{ fontFamily: f.css }}
                            >
                              {f.id === "system" ? t("builder.font.system") : f.label}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                              {t(`builder.fontcat.${f.category}`)}
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
                          : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600"
                      }`}
                    >
                      <div
                        className="truncate text-base text-neutral-800 dark:text-neutral-100"
                        style={{ fontFamily: fontCssFamily(f.id) }}
                      >
                        {f.id === "system" ? t("builder.font.system") : f.label}
                      </div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                        {t(`builder.fontcat.${f.category}`)}
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
          <Section icon={<Palette className="w-4 h-4" />} title={t("builder.design.accentColor")}>
            <div className="grid grid-cols-5 gap-2">
              {ACCENT_PALETTE.map((c) => {
                const active = c.value.toLowerCase() === accent.toLowerCase();
                return (
                  <button
                    key={c.value}
                    type="button"
                    title={t(`builder.accent.${c.value}`)}
                    onClick={() => onAccentChange(c.value)}
                    className="relative aspect-square rounded-lg ring-1 ring-black/5 dark:ring-white/10 transition-transform hover:scale-105"
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
                className="h-8 w-10 cursor-pointer rounded border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
                title={t("builder.design.customColor")}
              />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">{t("builder.design.custom")}</span>
            </div>
          </Section>

          {/* Color de fondo */}
          <Section icon={<Palette className="w-4 h-4" />} title={t("builder.design.bgColor")}>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={
                  design.backgroundColor && /^#[0-9a-f]{6}$/i.test(design.backgroundColor)
                    ? design.backgroundColor
                    : "#f6f6f7"
                }
                onChange={(e) => patch({ backgroundColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
              />
              <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400">
                {design.backgroundColor ?? t("builder.design.noColorDefault")}
              </span>
              {design.backgroundColor && (
                <button
                  type="button"
                  onClick={() => patch({ backgroundColor: undefined })}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  {t("builder.design.noColor")}
                </button>
              )}
            </div>
          </Section>

          {/* Modo y legibilidad */}
          <Section icon={<Contrast className="w-4 h-4" />} title={t("builder.design.modeReadability")}>
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
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600"
                    }`}
                  >
                    {m === "light" ? (
                      <Sun className="w-4 h-4" />
                    ) : (
                      <Moon className="w-4 h-4" />
                    )}
                    {m === "light" ? t("builder.design.light") : t("builder.design.dark")}
                  </button>
                );
              })}
            </div>

            {/* Color del texto de las preguntas */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                {t("builder.design.questionTextColor")}
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
                  className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
                />
                <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {design.textColor ?? t("builder.design.autoByMode")}
                </span>
                {design.textColor && (
                  <button
                    type="button"
                    onClick={() => patch({ textColor: undefined })}
                    className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    {t("builder.design.auto")}
                  </button>
                )}
              </div>
            </div>

          </Section>

          {/* Cuadros de las preguntas */}
          <Section icon={<Square className="w-4 h-4" />} title={t("builder.design.questionBoxes")}>
            {/* Color de los cuadros */}
            <div>
              <div className="mb-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                {t("builder.design.boxColor")}
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
                  className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
                />
                <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {design.questionColor ?? t("builder.design.autoByMode")}
                </span>
                {design.questionColor && (
                  <button
                    type="button"
                    onClick={() => patch({ questionColor: undefined })}
                    className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    {t("builder.design.auto")}
                  </button>
                )}
              </div>
            </div>

            {/* Opacidad de los cuadros */}
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-300">
                <span>{t("builder.design.opacity")}</span>
                <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
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
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("builder.design.opacityHint")}
              </p>
            </div>

            {/* Color del texto de los cuadros (independiente del de las preguntas) */}
            <div className="mt-4">
              <div className="mb-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                {t("builder.design.boxTextColor")}
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
                  className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
                />
                <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {design.inputTextColor ?? t("builder.design.autoReadable")}
                </span>
                {design.inputTextColor && (
                  <button
                    type="button"
                    onClick={() => patch({ inputTextColor: undefined })}
                    className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    {t("builder.design.auto")}
                  </button>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("builder.design.boxTextHint")}
              </p>
            </div>

            {/* Vidrio esmerilado (glass) */}
            <div className="mt-4">
              <ToggleRow
                label={t("builder.design.glass")}
                checked={!!design.glass}
                onChange={(v) => patch({ glass: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("builder.design.glassHint")}
              </p>
            </div>

            {/* Preguntas transparentes (atajo de opacidad 0) */}
            <div className="mt-4">
              <ToggleRow
                label={t("builder.design.transparentQuestions")}
                checked={!!design.transparentQuestions}
                onChange={(v) => patch({ transparentQuestions: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("builder.design.transparentHint")}
              </p>
            </div>

            {/* Contenedor por pregunta (separador) */}
            <div className="mt-4">
              <ToggleRow
                label={t("builder.design.questionContainer")}
                checked={!!design.questionSeparator}
                onChange={(v) => patch({ questionSeparator: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("builder.design.questionContainerHint")}
              </p>
            </div>
          </Section>

          {/* Botones */}
          <Section icon={<MousePointerClick className="w-4 h-4" />} title={t("builder.design.buttons")}>
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
                className="h-9 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-800"
              />
              <span className="flex-1 text-xs text-neutral-500 dark:text-neutral-400">
                {design.buttonColor ?? t("builder.design.autoAccent")}
              </span>
              {design.buttonColor && (
                <button
                  type="button"
                  onClick={() => patch({ buttonColor: undefined })}
                  className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  {t("builder.design.auto")}
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {t("builder.design.buttonsHint")}
            </p>
            <div className="mt-4">
              <ToggleRow
                label={t("builder.design.buttonShadow")}
                checked={!!design.buttonShadow}
                onChange={(v) => patch({ buttonShadow: v })}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                {t("builder.design.buttonShadowHint")}
              </p>
            </div>
          </Section>

          {/* Alineación */}
          <Section icon={<AlignCenter className="w-4 h-4" />} title={t("builder.design.alignment")}>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "left", label: t("builder.design.alignLeft"), icon: AlignLeft },
                  { value: "center", label: t("builder.design.alignCenter"), icon: AlignCenter },
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
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {t("builder.design.alignmentHint")}
            </p>
          </Section>

          {/* Transiciones */}
          <Section icon={<Wand2 className="w-4 h-4" />} title={t("builder.design.transitions")}>
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
                        ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                        : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600"
                    }`}
                  >
                    {t(`builder.transition.${opt.id}`)}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {t("builder.design.transitionsHint")}
            </p>
          </Section>

          {/* Modo conversacional (chat) */}
          <Section icon={<MessagesSquare className="w-4 h-4" />} title={t("builder.design.chat")}>
            <ToggleRow
              label={t("builder.design.chatToggle")}
              checked={!!design.chat}
              onChange={(v) => patch({ chat: v })}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {t("builder.design.chatHint")}
            </p>

            {design.chat && (() => {
              const chat = { ...DEFAULT_CHAT, ...(design.chatOptions ?? {}) };
              const patchChat = (p: Partial<typeof chat>) =>
                patch({ chatOptions: { ...chat, ...p } });
              return (
                <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
                  {/* Skin */}
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.chatSkin")}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {CHAT_SKINS.map((s) => {
                        const active = chat.skin === s.id;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => patchChat({ skin: s.id })}
                            className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                              active
                                ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                                : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600"
                            }`}
                          >
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Identidad del bot */}
                  <ToggleRow
                    label={t("builder.design.chatHeader")}
                    checked={chat.showHeader !== false}
                    onChange={(v) => patchChat({ showHeader: v })}
                  />
                  {chat.showHeader !== false && (
                    <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                      <input
                        value={chat.botAvatar ?? ""}
                        onChange={(e) => patchChat({ botAvatar: e.target.value })}
                        placeholder="🙂"
                        className="w-12 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-center text-sm dark:border-neutral-700 dark:bg-neutral-800"
                        aria-label={t("builder.design.chatAvatar")}
                      />
                      <input
                        value={chat.botName ?? ""}
                        onChange={(e) => patchChat({ botName: e.target.value })}
                        placeholder={t("builder.design.chatNamePh")}
                        className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                        aria-label={t("builder.design.chatName")}
                      />
                      <div />
                      <input
                        value={chat.botStatus ?? ""}
                        onChange={(e) => patchChat({ botStatus: e.target.value })}
                        placeholder={t("builder.design.chatStatusPh")}
                        className="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                        aria-label={t("builder.design.chatStatus")}
                      />
                    </div>
                  )}

                  {/* Estilo del rating/NPS en el chat */}
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.chatRating")}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {(["scale", "slider", "chips"] as const).map((rs) => (
                        <button
                          key={rs}
                          type="button"
                          onClick={() => patchChat({ ratingStyle: rs })}
                          className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                            (chat.ratingStyle ?? "scale") === rs
                              ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                              : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400"
                          }`}
                        >
                          {t(`builder.design.chatRating.${rs}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Comportamiento */}
                  <div className="space-y-3">
                    <ToggleRow
                      label={t("builder.design.chatQuickReplies")}
                      checked={chat.quickReplies !== false}
                      onChange={(v) => patchChat({ quickReplies: v })}
                    />
                    <ToggleRow
                      label={t("builder.design.chatTyping")}
                      checked={chat.typingIndicator !== false}
                      onChange={(v) => patchChat({ typingIndicator: v })}
                    />
                    <ToggleRow
                      label={t("builder.design.chatAutoAdvance")}
                      checked={chat.autoAdvance !== false}
                      onChange={(v) => patchChat({ autoAdvance: v })}
                    />
                    <ToggleRow
                      label={t("builder.design.chatTails")}
                      checked={chat.tails !== false}
                      onChange={(v) => patchChat({ tails: v })}
                    />
                    <ToggleRow
                      label={t("builder.design.chatReceipts")}
                      checked={!!chat.readReceipts}
                      onChange={(v) => patchChat({ readReceipts: v })}
                    />
                    <ToggleRow
                      label={t("builder.design.chatSound")}
                      checked={!!chat.sound}
                      onChange={(v) => patchChat({ sound: v })}
                    />
                  </div>
                </div>
              );
            })()}
          </Section>

          {/* Pantalla de agradecimiento */}
          <Section icon={<PartyPopper className="w-4 h-4" />} title={t("builder.design.ty")}>
            {(() => {
              const ty = { ...DEFAULT_THANKYOU, ...(design.thankYou ?? {}) };
              const patchTy = (p: Partial<typeof ty>) => patch({ thankYou: { ...ty, ...p } });
              const ICON_GLYPH: Record<string, string> = {
                check: "✓", heart: "❤", star: "★", party: "🎉", trophy: "🏆", none: "∅",
              };
              const ctas = ty.ctas ?? [];
              const setCtas = (next: typeof ctas) => patchTy({ ctas: next });
              return (
                <div className="space-y-4">
                  {/* Layout */}
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyLayout")}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {(["card", "minimal", "hero"] as const).map((l) => (
                        <button
                          key={l}
                          type="button"
                          onClick={() => patchTy({ layout: l })}
                          className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                            (ty.layout ?? "card") === l
                              ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                              : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400"
                          }`}
                        >
                          {t(`builder.design.tyLayout.${l}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Ícono */}
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyIcon")}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {THANKYOU_ICONS.map((ic) => (
                        <button
                          key={ic}
                          type="button"
                          onClick={() => patchTy({ icon: ic })}
                          className={`grid h-9 w-9 place-items-center rounded-lg border text-base transition-colors ${
                            ty.icon === ic
                              ? "border-[#8faf0e] bg-[#8faf0e0a]"
                              : "border-neutral-200 dark:border-neutral-700"
                          }`}
                          title={ic}
                        >
                          {ICON_GLYPH[ic]}
                        </button>
                      ))}
                      <input
                        value={ty.icon && !ICON_GLYPH[ty.icon] && !/^(https?:|\/)/.test(ty.icon) ? ty.icon : ""}
                        onChange={(e) => patchTy({ icon: e.target.value || "none" })}
                        placeholder="🎯"
                        maxLength={4}
                        className="h-9 w-12 rounded-lg border border-neutral-200 text-center text-base dark:border-neutral-700 dark:bg-neutral-800"
                        aria-label={t("builder.design.tyEmoji")}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                      {t("builder.design.tyIconHint")}
                    </p>
                  </div>

                  {/* Título + confeti */}
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyTitle")}
                    </label>
                    <input
                      value={ty.title ?? ""}
                      onChange={(e) => patchTy({ title: e.target.value })}
                      placeholder={t("builder.design.tyTitlePh")}
                      className="w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                    />
                    <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                      {t("builder.design.tyTokenHint")}
                    </p>
                  </div>

                  {/* Festejo (confeti / emojis / fuegos / globos / auto a la meta) */}
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyCelebration")}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {CELEBRATIONS.map((ce) => {
                        const current = ty.celebration ?? (ty.confetti ? "confetti" : "none");
                        return (
                          <button
                            key={ce}
                            type="button"
                            onClick={() => patchTy({ celebration: ce, confetti: ce === "confetti" })}
                            className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                              current === ce
                                ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                                : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400"
                            }`}
                          >
                            {t(`builder.design.celebration.${ce}`)}
                          </button>
                        );
                      })}
                    </div>
                    {(ty.celebration ?? "none") === "emoji" && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          value={ty.celebrationEmoji ?? ""}
                          onChange={(e) => patchTy({ celebrationEmoji: e.target.value })}
                          placeholder="🎉"
                          maxLength={4}
                          className="h-9 w-14 rounded-lg border border-neutral-200 text-center text-lg dark:border-neutral-700 dark:bg-neutral-800"
                          aria-label={t("builder.design.tyCelebrationEmoji")}
                        />
                        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                          {t("builder.design.tyCelebrationEmojiHint")}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Imagen/GIF */}
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyImage")}
                    </label>
                    <AssetPicker kind="image" value={ty.image} onChange={(url) => patchTy({ image: url })} />
                  </div>

                  {/* Botones CTA */}
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyCtas")}
                    </label>
                    <div className="space-y-2">
                      {ctas.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <input
                            value={c.label}
                            onChange={(e) => setCtas(ctas.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                            placeholder={t("builder.design.tyCtaLabel")}
                            className="w-1/3 rounded-md border border-neutral-200 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                          />
                          <input
                            value={c.url}
                            onChange={(e) => setCtas(ctas.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                            placeholder="https://…"
                            className="flex-1 rounded-md border border-neutral-200 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                          />
                          <button
                            type="button"
                            onClick={() => setCtas(ctas.filter((_, j) => j !== i))}
                            className="grid h-8 w-8 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            aria-label={t("builder.design.tyCtaRemove")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      {ctas.length < 3 && (
                        <button
                          type="button"
                          onClick={() => setCtas([...ctas, { label: "", url: "" }])}
                          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-500 hover:border-neutral-400 dark:border-neutral-700"
                        >
                          <Plus className="h-3.5 w-3.5" /> {t("builder.design.tyCtaAdd")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Compartir */}
                  <ToggleRow
                    label={t("builder.design.tyShare")}
                    checked={!!ty.share}
                    onChange={(v) => patchTy({ share: v })}
                  />

                  {/* Cuenta regresiva de redirección */}
                  <div>
                    <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                      {t("builder.design.tyCountdown")}
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={ty.redirectCountdown ?? 0}
                      onChange={(e) => patchTy({ redirectCountdown: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-24 rounded-md border border-neutral-200 px-2.5 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                    />
                    <p className="mt-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                      {t("builder.design.tyCountdownHint")}
                    </p>
                  </div>

                  {/* Cierre en modo chat */}
                  {design.chat && (
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                        {t("builder.design.tyChatMode")}
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {(["bubble", "screen"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => patchTy({ chatMode: m })}
                            className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                              (ty.chatMode ?? "bubble") === m
                                ? "border-[#8faf0e] bg-[#8faf0e0a] text-neutral-800 dark:text-neutral-100"
                                : "border-neutral-200 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-400"
                            }`}
                          >
                            {t(`builder.design.tyChatMode.${m}`)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </Section>

          {/* Pantalla: mientras se corrige (analizando) */}
          <Section icon={<Loader2 className="w-4 h-4" />} title={t("builder.design.grading")}>
            <StateScreenEditor
              value={design.grading}
              onChange={(c) => patch({ grading: c })}
              kind="grading"
            />
          </Section>

          {/* Pantalla: encuesta cerrada */}
          <Section icon={<Lock className="w-4 h-4" />} title={t("builder.design.closed")}>
            <StateScreenEditor
              value={design.closed}
              onChange={(c) => patch({ closed: c })}
              kind="closed"
            />
          </Section>

          {/* Imagen de fondo */}
          <Section icon={<ImageIcon className="w-4 h-4" />} title={t("builder.design.bgImage")}>
            <AssetPicker
              kind="image"
              value={design.backgroundImage}
              onChange={(url) => patch({ backgroundImage: url })}
            />
            {design.backgroundImage && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-300">
                  <span>{t("builder.design.opacity")}</span>
                  <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
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
          <Section icon={<ImageIcon className="w-4 h-4" />} title={t("builder.design.cover")}>
            <AssetPicker
              kind="image"
              value={design.coverImage}
              onChange={(url) => patch({ coverImage: url })}
            />
          </Section>

          {/* Logo */}
          <Section icon={<ImageIcon className="w-4 h-4" />} title={t("builder.design.logo")}>
            <AssetPicker
              kind="image"
              value={design.logo}
              onChange={(url) => patch({ logo: url })}
            />
          </Section>

          {/* Música de fondo */}
          <Section icon={<Music className="w-4 h-4" />} title={t("builder.design.music")}>
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
                  label={t("builder.design.loop")}
                  checked={audio.loop}
                  onChange={(v) => patchAudio({ loop: v })}
                />
                <ToggleRow
                  label={t("builder.design.autoplay")}
                  checked={audio.autoplay}
                  onChange={(v) => patchAudio({ autoplay: v })}
                />
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-300">
                    <span>{t("builder.design.volume")}</span>
                    <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
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
                <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                  {t("builder.design.musicHint")}
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
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative overflow-hidden rounded-lg border text-left transition-colors ${
        active
          ? "border-[#8faf0e] ring-1 ring-[#8faf0e]"
          : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600"
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
          {t(`builder.theme.${preset.id}`)}
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

// Editor de una pantalla de estado (analizando / cerrada). Todos los campos son
// opcionales; vacío = default. `kind` cambia el toggle específico y el placeholder.
function StateScreenEditor({
  value,
  onChange,
  kind,
}: {
  value?: StateScreenConfig;
  onChange: (c: StateScreenConfig) => void;
  kind: "grading" | "closed";
}) {
  const { t } = useI18n();
  const c = value ?? {};
  const set = (p: Partial<StateScreenConfig>) => onChange({ ...c, ...p });
  const isHex = (v?: string) => !!v && /^#[0-9a-f]{6}$/i.test(v);
  const inputCls =
    "w-full rounded-md border border-neutral-200 px-2.5 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500";
  const labelCls =
    "mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-300";
  const ColorRow = ({
    label,
    val,
    onSet,
    autoLabel,
  }: {
    label: string;
    val?: string;
    onSet: (v: string | undefined) => void;
    autoLabel: string;
  }) => (
    <div>
      <label className={labelCls}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isHex(val) ? (val as string) : "#111111"}
          onChange={(e) => onSet(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded border border-neutral-200 dark:border-neutral-700"
        />
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {val ?? autoLabel}
        </span>
        {val && (
          <button
            type="button"
            onClick={() => onSet(undefined)}
            className="ml-auto text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            {t("builder.design.clear")}
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-neutral-100 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/60 p-2.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t(`builder.design.${kind}Hint`)}
      </p>
      <div>
        <label className={labelCls}>{t("builder.design.ssTitle")}</label>
        <input
          value={c.title ?? ""}
          onChange={(e) => set({ title: e.target.value })}
          placeholder={t(`builder.design.${kind}TitlePh`)}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>{t("builder.design.ssMessage")}</label>
        <textarea
          value={c.message ?? ""}
          onChange={(e) => set({ message: e.target.value })}
          rows={2}
          placeholder={t(`builder.design.${kind}MessagePh`)}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>{t("builder.design.ssEmoji")}</label>
        <input
          value={c.emoji ?? ""}
          onChange={(e) => set({ emoji: e.target.value })}
          placeholder={kind === "grading" ? "🤖" : "🔒"}
          maxLength={4}
          className="h-9 w-16 rounded-md border border-neutral-200 text-center text-base dark:border-neutral-700 dark:bg-neutral-800"
        />
      </div>
      <div>
        <label className={labelCls}>{t("builder.design.ssBgImage")}</label>
        <AssetPicker
          kind="image"
          value={c.bgImage}
          onChange={(url) => set({ bgImage: url })}
        />
      </div>
      <ColorRow
        label={t("builder.design.ssBgColor")}
        val={c.bgColor}
        onSet={(v) => set({ bgColor: v })}
        autoLabel={t("builder.design.autoByMode")}
      />
      <ColorRow
        label={t("builder.design.ssTextColor")}
        val={c.textColor}
        onSet={(v) => set({ textColor: v })}
        autoLabel={t("builder.design.autoByMode")}
      />
      {kind === "grading" ? (
        <label className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {t("builder.design.ssSpinner")}
          </span>
          <Switch
            checked={c.spinner ?? true}
            onCheckedChange={(v) => set({ spinner: v })}
          />
        </label>
      ) : (
        <label className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {t("builder.design.ssShowReason")}
          </span>
          <Switch
            checked={c.showReason ?? true}
            onCheckedChange={(v) => set({ showReason: v })}
          />
        </label>
      )}
    </div>
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
      <h3 className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        <span className="text-neutral-400 dark:text-neutral-500">{icon}</span>
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
      <span className="text-sm text-neutral-700 dark:text-neutral-300">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
