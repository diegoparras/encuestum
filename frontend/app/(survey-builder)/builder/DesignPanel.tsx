"use client";

import React, { useEffect } from "react";
import { X, Type, Palette, Image as ImageIcon, Music, Check } from "lucide-react";
import {
  ACCENT_PALETTE,
  AudioSettings,
  DesignSettings,
  FONT_OPTIONS,
  fontCssFamily,
  readableForeground,
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

export function DesignPanel({
  open,
  onClose,
  design,
  onChange,
  accent,
  onAccentChange,
}: Props) {
  // Preload every visible font so the type list previews in its real face.
  useEffect(() => {
    if (!open) return;
    FONT_OPTIONS.forEach((f) => loadFont(f.id));
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
          {/* Tipografía */}
          <Section icon={<Type className="w-4 h-4" />} title="Tipografía">
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
                        ? "border-[#e25a4e] bg-[#e25a4e0a]"
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
                      <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-[#e25a4e] text-white">
                        <Check className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
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
                value={/^#[0-9a-f]{6}$/i.test(accent) ? accent : "#e25a4e"}
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
                  className="w-full accent-[#e25a4e]"
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
                    className="w-full accent-[#e25a4e]"
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
