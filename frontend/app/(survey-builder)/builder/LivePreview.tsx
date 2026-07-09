"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "survey-core/i18n/spanish";
import { Monitor, Smartphone } from "lucide-react";
import { DesignSettings, DEFAULT_DESIGN, designToTheme } from "./model";
import { absolutizeAssets, loadFont, resolveAssetUrl } from "./design";

interface Props {
  schema: Record<string, any>;
  accent: string;
  design?: DesignSettings;
  language?: string | null;
}

type Device = "desktop" | "mobile";

// The preview re-instantiates the SurveyJS model when the (debounced) schema or
// accent changes. Rebuilding is intentional — it guarantees the preview always
// matches the saved definition exactly, including validation and theming.
export function LivePreview({ schema, accent, design, language }: Props) {
  const [device, setDevice] = useState<Device>("desktop");
  const d = design ?? DEFAULT_DESIGN;

  useEffect(() => {
    loadFont(d.fontFamily);
  }, [d.fontFamily]);

  // Debounce so typing in the properties panel doesn't rebuild on every keystroke.
  const [debounced, setDebounced] = useState(schema);
  const signature = JSON.stringify(schema);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(schema), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const isEmpty = !((debounced?.pages?.[0]?.elements?.length ?? 0) > 0);

  const model = useMemo(() => {
    const m = new Model(absolutizeAssets(debounced || {}));
    m.locale = language || "es";
    try {
      m.applyTheme(absolutizeAssets(designToTheme(accent, d)) as any);
    } catch {
      /* best-effort theming */
    }
    // Preview only — never actually submit from here.
    m.mode = "edit";
    m.showCompletedPage = false;
    m.onComplete.add((sender) => {
      sender.clear(false, false);
      sender.currentPageNo = 0;
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(debounced), accent, language, JSON.stringify(d)]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Vista previa
        </span>
        <div className="flex items-center gap-1 rounded-lg bg-neutral-100 p-0.5">
          <DeviceButton
            active={device === "desktop"}
            onClick={() => setDevice("desktop")}
            label="Escritorio"
          >
            <Monitor className="w-4 h-4" />
          </DeviceButton>
          <DeviceButton
            active={device === "mobile"}
            onClick={() => setDevice("mobile")}
            label="Móvil"
          >
            <Smartphone className="w-4 h-4" />
          </DeviceButton>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-neutral-100/70 p-6">
        {isEmpty ? (
          <div className="h-full grid place-items-center text-center text-sm text-neutral-400">
            <div>
              <p>Tu encuesta está vacía.</p>
              <p className="text-xs mt-1">
                Agregá preguntas desde la paleta para verlas acá.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="mx-auto bg-white rounded-2xl shadow-sm ring-1 ring-black/5 overflow-hidden transition-all"
            style={{ maxWidth: device === "mobile" ? 380 : 720 }}
          >
            {d.coverImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolveAssetUrl(d.coverImage)}
                alt=""
                className="w-full object-cover"
                style={{ height: device === "mobile" ? 120 : 180 }}
              />
            )}
            <Survey model={model} />
          </div>
        )}
      </div>
    </div>
  );
}

function DeviceButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid place-items-center w-7 h-7 rounded-md transition-colors ${
        active ? "bg-white text-neutral-800 shadow-sm" : "text-neutral-400 hover:text-neutral-600"
      }`}
    >
      {children}
    </button>
  );
}
