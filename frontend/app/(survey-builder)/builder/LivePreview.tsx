"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "survey-core/i18n/spanish";
import { Monitor, Smartphone } from "lucide-react";
import { DesignSettings, DEFAULT_DESIGN, designToTheme, perQuestionStyleCss } from "./model";
import { absolutizeAssets, buttonOverrideCss, cardsCss, ENC_ALIGN_CSS, fontsCss, loadFont, resolveAssetUrl } from "./design";
import { registerVideoResponseQuestion } from "../../(public)/s/[slug]/VideoResponseQuestion";
import { ChatSurveyView } from "../../(public)/s/[slug]/ChatSurveyView";
import { useI18n } from "@/lib/i18n";

// Register the custom video-response question so the preview can render it.
registerVideoResponseQuestion();

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
  const { t } = useI18n();
  const [device, setDevice] = useState<Device>("desktop");
  const d = design ?? DEFAULT_DESIGN;

  useEffect(() => {
    for (const f of [d.fontFamily, d.titleFont, d.questionFont, d.buttonFont]) {
      if (f) loadFont(f);
    }
  }, [d.fontFamily, d.titleFont, d.questionFont, d.buttonFont]);

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
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t("builder.preview.label")}
        </span>
        <div className="flex items-center gap-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 p-0.5">
          <DeviceButton
            active={device === "desktop"}
            onClick={() => setDevice("desktop")}
            label={t("builder.preview.desktop")}
          >
            <Monitor className="w-4 h-4" />
          </DeviceButton>
          <DeviceButton
            active={device === "mobile"}
            onClick={() => setDevice("mobile")}
            label={t("builder.preview.mobile")}
          >
            <Smartphone className="w-4 h-4" />
          </DeviceButton>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-neutral-100/70 dark:bg-neutral-900/70 p-6">
        {isEmpty ? (
          <div className="h-full grid place-items-center text-center text-sm text-neutral-400 dark:text-neutral-500">
            <div>
              <p>{t("builder.preview.empty1")}</p>
              <p className="text-xs mt-1">
                {t("builder.preview.empty2")}
              </p>
            </div>
          </div>
        ) : (
          <div
            className={`enc-scope${d.alignment === "center" ? " enc-center" : ""}${d.questionSeparator ? " enc-cards" : ""} mx-auto bg-white rounded-2xl shadow-sm ring-1 ring-black/5 overflow-hidden transition-all`}
            style={{ maxWidth: device === "mobile" ? 380 : 720 }}
          >
            {/* Color/sombra de botones + alineación + contenedores + estilos
                por pregunta, igual que en la página pública. */}
            <style>
              {ENC_ALIGN_CSS +
                cardsCss(d.mode === "dark") +
                buttonOverrideCss(d.buttonColor, d.buttonShadow) +
                perQuestionStyleCss(debounced, d) +
                fontsCss(d)}
            </style>
            {d.coverImage && !d.chat && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolveAssetUrl(d.coverImage)}
                alt=""
                className="w-full object-cover"
                style={{ height: device === "mobile" ? 120 : 180 }}
              />
            )}
            {d.chat ? (
              <div style={{ height: device === "mobile" ? 520 : 460 }} className="overflow-hidden">
                <ChatSurveyView
                  model={model}
                  accent={accent}
                  dark={d.mode === "dark"}
                  options={d.chatOptions}
                  embedded
                />
              </div>
            ) : (
              <Survey model={model} />
            )}
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
        active ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100" : "text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
      }`}
    >
      {children}
    </button>
  );
}
