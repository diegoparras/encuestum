"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, Heart, Star, PartyPopper, Trophy, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_THANKYOU, type ThankYouConfig } from "../../../(survey-builder)/builder/model";
import { resolveAssetUrl } from "../../../(survey-builder)/builder/design";

interface Props {
  config?: ThankYouConfig | null;
  message: string; // ya resuelto (tokens aplicados)
  accent: string;
  dark: boolean;
  brandingHeader?: React.ReactNode;
  shareUrl?: string;
  redirectUrl?: string | null;
  resolveTokens?: (text: string) => string; // para {pregunta} en el título
}

const LUCIDE: Record<string, React.ComponentType<{ className?: string }>> = {
  check: Check,
  heart: Heart,
  star: Star,
  party: PartyPopper,
  trophy: Trophy,
};

// Confeti autónomo en canvas (sin dependencias externas por el CSP).
function Confetti({ accent }: { accent: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    resize();
    const colors = [accent, "#f59e0b", "#ef4444", "#22c55e", "#3b82f6", "#a855f7"];
    const N = 140;
    const parts = Array.from({ length: N }, () => ({
      x: Math.random() * canvas.width,
      y: -20 * dpr - Math.random() * canvas.height * 0.4,
      w: (6 + Math.random() * 6) * dpr,
      h: (8 + Math.random() * 8) * dpr,
      vx: (Math.random() - 0.5) * 3 * dpr,
      vy: (2 + Math.random() * 3.5) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[(Math.random() * colors.length) | 0],
    }));
    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fade = elapsed > 2600 ? Math.max(0, 1 - (elapsed - 2600) / 900) : 1;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.03 * dpr;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < 3600) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [accent]);
  return (
    <canvas
      ref={ref}
      className="pointer-events-none fixed inset-0 z-50"
      style={{ width: "100vw", height: "100vh" }}
      aria-hidden
    />
  );
}

function ThankIcon({ icon, color }: { icon: string; color: string }) {
  if (!icon || icon === "none") return null;
  const isImg = /^(https?:|\/)/.test(icon);
  if (isImg) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={resolveAssetUrl(icon)} alt="" className="mx-auto mb-5 h-20 w-20 rounded-2xl object-cover" />;
  }
  const Lucide = LUCIDE[icon];
  return (
    <div
      className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full text-3xl"
      style={{ backgroundColor: `${color}1a`, color }}
    >
      {Lucide ? <Lucide className="h-8 w-8" /> : <span>{icon}</span>}
    </div>
  );
}

export function ThankYouView({
  config,
  message,
  accent,
  dark,
  brandingHeader,
  shareUrl,
  redirectUrl,
  resolveTokens,
}: Props) {
  const { t } = useI18n();
  const cfg: ThankYouConfig = { ...DEFAULT_THANKYOU, ...(config || {}) };
  const layout = cfg.layout || "card";
  const iconColor = cfg.iconColor || accent;
  const title = cfg.title ? (resolveTokens ? resolveTokens(cfg.title) : cfg.title) : "";

  const pageBg = cfg.bgColor || (dark ? "#181c24" : "#f6f6f7");
  const cardBg = cfg.cardColor || (dark ? "#232833" : "#ffffff");
  const textColor = cfg.textColor || (dark ? "#e5e7eb" : "#1f2937");

  // Redirección con cuenta regresiva (si hay URL y countdown > 0).
  const [count, setCount] = useState<number>(
    redirectUrl && cfg.redirectCountdown && cfg.redirectCountdown > 0 ? cfg.redirectCountdown : 0
  );
  useEffect(() => {
    if (!redirectUrl || !cfg.redirectCountdown || cfg.redirectCountdown <= 0) return;
    const id = setInterval(() => {
      setCount((c) => {
        if (c <= 1) {
          clearInterval(id);
          window.location.href = redirectUrl;
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [redirectUrl, cfg.redirectCountdown]);

  const share = (network: "whatsapp" | "x" | "linkedin" | "copy") => {
    const url = shareUrl || (typeof window !== "undefined" ? window.location.href.split("?")[0] : "");
    const text = cfg.shareText || t("public.thankyou.shareDefault");
    if (network === "copy") {
      navigator.clipboard?.writeText(url).then(
        () => toast.success(t("public.thankyou.copied")),
        () => undefined
      );
      return;
    }
    const links = {
      whatsapp: `https://wa.me/?text=${encodeURIComponent(text + " " + url)}`,
      x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    };
    window.open(links[network], "_blank", "noopener,noreferrer");
  };

  const body = (
    <>
      {cfg.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={resolveAssetUrl(cfg.image)} alt="" className="mx-auto mb-5 max-h-48 w-auto rounded-xl object-contain" />
      )}
      <ThankIcon icon={cfg.icon || "check"} color={iconColor} />
      {title && (
        <h1 className="mb-2 text-xl font-bold" style={{ color: textColor }}>
          {title}
        </h1>
      )}
      <p className="whitespace-pre-line text-base leading-relaxed" style={{ color: textColor }}>
        {message}
      </p>

      {cfg.ctas && cfg.ctas.length > 0 && (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {cfg.ctas.filter((c) => c.label && c.url).map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
              style={{ backgroundColor: accent }}
            >
              {c.label}
              <ExternalLink className="h-4 w-4" />
            </a>
          ))}
        </div>
      )}

      {cfg.share && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide" style={{ color: textColor, opacity: 0.6 }}>
            {t("public.thankyou.share")}
          </p>
          <div className="flex justify-center gap-2">
            <ShareBtn label="WhatsApp" bg="#25d366" onClick={() => share("whatsapp")}>WA</ShareBtn>
            <ShareBtn label="X" bg="#111827" onClick={() => share("x")}>X</ShareBtn>
            <ShareBtn label="LinkedIn" bg="#0a66c2" onClick={() => share("linkedin")}>in</ShareBtn>
            <button
              type="button"
              onClick={() => share("copy")}
              aria-label={t("public.thankyou.copyLink")}
              title={t("public.thankyou.copyLink")}
              className="grid h-9 w-9 place-items-center rounded-full text-white"
              style={{ backgroundColor: "#6b7280" }}
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {count > 0 && (
        <p className="mt-5 text-xs" style={{ color: textColor, opacity: 0.6 }}>
          {t("public.thankyou.redirectIn", { n: count })}
        </p>
      )}
    </>
  );

  if (layout === "hero") {
    return (
      <div
        className="min-h-screen"
        style={{ background: `linear-gradient(160deg, ${accent}22, ${pageBg} 60%)`, color: textColor }}
      >
        {cfg.confetti && <Confetti accent={accent} />}
        {brandingHeader}
        <div className="flex min-h-[80vh] items-center justify-center p-6 text-center">
          <div className="w-full max-w-lg">{body}</div>
        </div>
      </div>
    );
  }

  if (layout === "minimal") {
    return (
      <div className="min-h-screen" style={{ backgroundColor: pageBg }}>
        {cfg.confetti && <Confetti accent={accent} />}
        {brandingHeader}
        <div className="flex min-h-[80vh] items-center justify-center p-6 text-center">
          <div className="w-full max-w-md">{body}</div>
        </div>
      </div>
    );
  }

  // card (default)
  return (
    <div className="min-h-screen" style={{ backgroundColor: pageBg }}>
      {cfg.confetti && <Confetti accent={accent} />}
      {brandingHeader}
      <div className="flex items-start justify-center p-4 sm:p-6">
        <div className="mt-6 w-full max-w-xl sm:mt-10">
          <div
            className="rounded-2xl p-6 text-center shadow-sm ring-1 ring-black/5 sm:p-8"
            style={{ backgroundColor: cardBg }}
          >
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareBtn({
  label,
  bg,
  onClick,
  children,
}: {
  label: string;
  bg: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-9 w-9 place-items-center rounded-full text-xs font-bold text-white"
      style={{ backgroundColor: bg }}
    >
      {children}
    </button>
  );
}
