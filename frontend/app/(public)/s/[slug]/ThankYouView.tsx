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

// ── Festejos en canvas (sin dependencias externas por el CSP) ────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.save();
  // sombra
  ctx.fillStyle = "rgba(0,0,0,.18)";
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h * 1.28, w * 0.5, h * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // techo
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.28, y);
  ctx.lineTo(x + w * 0.4, y - h * 0.55);
  ctx.lineTo(x + w * 0.72, y - h * 0.55);
  ctx.lineTo(x + w * 0.82, y);
  ctx.closePath();
  ctx.fill();
  // carrocería
  roundRect(ctx, x, y, w, h, h * 0.35);
  ctx.fill();
  // ventana
  ctx.fillStyle = "rgba(255,255,255,.8)";
  ctx.beginPath();
  ctx.moveTo(x + w * 0.42, y - h * 0.05);
  ctx.lineTo(x + w * 0.47, y - h * 0.46);
  ctx.lineTo(x + w * 0.67, y - h * 0.46);
  ctx.lineTo(x + w * 0.71, y - h * 0.05);
  ctx.closePath();
  ctx.fill();
  // ruedas
  const wr = h * 0.36;
  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.arc(x + w * 0.26, y + h, wr, 0, Math.PI * 2);
  ctx.arc(x + w * 0.74, y + h, wr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#9ca3af";
  ctx.beginPath();
  ctx.arc(x + w * 0.26, y + h, wr * 0.44, 0, Math.PI * 2);
  ctx.arc(x + w * 0.74, y + h, wr * 0.44, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFinish(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, dpr: number) {
  const cell = 9 * dpr;
  const cols = 2;
  const rows = Math.max(1, Math.round(h / cell));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? "#111827" : "#f9fafb";
      ctx.fillRect(x + c * cell, y + r * cell, cell, cell);
    }
}

function Celebration({
  effect,
  emoji,
  accent,
  dark,
}: {
  effect: string;
  emoji?: string;
  accent: string;
  dark: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (effect === "none") return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const resize = () => {
      W = canvas.width = window.innerWidth * dpr;
      H = canvas.height = window.innerHeight * dpr;
    };
    resize();
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const colors = [accent, "#f59e0b", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
    const pick = () => colors[(Math.random() * colors.length) | 0];
    const glyph = emoji && emoji.trim() ? emoji.trim() : "🎉";

    let parts: any[] = [];
    let bursts: any[] = [];
    if (effect === "confetti" || effect === "emoji") {
      const N = effect === "emoji" ? 46 : 150;
      parts = Array.from({ length: N }, () => ({
        x: rand(0, W), y: -20 * dpr - Math.random() * H * 0.5,
        w: rand(6, 12) * dpr, h: rand(8, 16) * dpr, size: rand(22, 42) * dpr,
        vx: rand(-1.5, 1.5) * dpr, vy: rand(2, 5.5) * dpr,
        rot: Math.random() * Math.PI, vr: rand(-0.15, 0.15), color: pick(),
      }));
    } else if (effect === "balloons") {
      parts = Array.from({ length: 16 }, () => ({
        x: rand(W * 0.06, W * 0.94), y: H + rand(0, H * 0.6), r: rand(15, 26) * dpr,
        vy: rand(1.1, 2.4) * dpr, phase: rand(0, Math.PI * 2), sway: rand(0.5, 1.4),
        swayAmp: rand(8, 22) * dpr, color: pick(),
      }));
    } else if (effect === "fireworks") {
      for (let i = 0; i < 6; i++)
        bursts.push({ t: i * 380 + rand(0, 160), x: rand(W * 0.2, W * 0.8), y: rand(H * 0.2, H * 0.55), color: pick(), fired: false, parts: [] as any[] });
    } else if (effect === "car") {
      parts = [{ x: -90 * dpr, y: H * 0.6, w: 84 * dpr, h: 34 * dpr }];
    }

    let raf = 0;
    const start = performance.now();
    const DURATION = effect === "car" ? 3400 : 3600;
    const draw = (now: number) => {
      const el = now - start;
      ctx.clearRect(0, 0, W, H);
      const fade = el > DURATION - 900 ? Math.max(0, 1 - (el - (DURATION - 900)) / 900) : 1;

      if (effect === "confetti") {
        for (const p of parts) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.03 * dpr; p.rot += p.vr;
          ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
        }
      } else if (effect === "emoji") {
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (const p of parts) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.02 * dpr; p.rot += p.vr;
          ctx.save(); ctx.globalAlpha = fade; ctx.font = `${p.size}px serif`;
          ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillText(glyph, 0, 0); ctx.restore();
        }
      } else if (effect === "balloons") {
        for (const p of parts) {
          p.y -= p.vy; p.phase += 0.04 * p.sway;
          const cx = p.x + Math.sin(p.phase) * p.swayAmp;
          ctx.save(); ctx.globalAlpha = fade;
          ctx.strokeStyle = dark ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.28)"; ctx.lineWidth = 1.2 * dpr;
          ctx.beginPath(); ctx.moveTo(cx, p.y + p.r);
          ctx.quadraticCurveTo(cx - 6 * dpr, p.y + p.r * 2.4, cx, p.y + p.r * 3.4); ctx.stroke();
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.ellipse(cx, p.y, p.r * 0.82, p.r, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,.28)";
          ctx.beginPath(); ctx.ellipse(cx - p.r * 0.28, p.y - p.r * 0.32, p.r * 0.18, p.r * 0.26, 0, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      } else if (effect === "fireworks") {
        for (const b of bursts) {
          if (!b.fired && el >= b.t) {
            b.fired = true;
            const M = 38;
            for (let i = 0; i < M; i++) {
              const a = (i / M) * Math.PI * 2, sp = rand(2, 5.5) * dpr;
              b.parts.push({ x: b.x, y: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0 });
            }
          }
          if (b.fired) {
            for (const q of b.parts) {
              q.x += q.vx; q.y += q.vy; q.vy += 0.03 * dpr; q.vx *= 0.99; q.life += 1;
              const a = Math.max(0, 1 - q.life / 72) * fade;
              ctx.globalAlpha = a; ctx.fillStyle = b.color;
              ctx.beginPath(); ctx.arc(q.x, q.y, 2.4 * dpr, 0, Math.PI * 2); ctx.fill();
            }
            ctx.globalAlpha = 1;
          }
        }
      } else if (effect === "car") {
        const car = parts[0];
        const finishX = W * 0.82;
        const progress = Math.min(1, el / 2500);
        car.x = -90 * dpr + (finishX + 130 * dpr) * progress;
        ctx.globalAlpha = fade;
        // ruta
        ctx.strokeStyle = dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.16)";
        ctx.lineWidth = 3 * dpr; ctx.setLineDash([14 * dpr, 12 * dpr]);
        ctx.beginPath(); ctx.moveTo(0, car.y + car.h * 1.5); ctx.lineTo(W, car.y + car.h * 1.5); ctx.stroke();
        ctx.setLineDash([]);
        // meta a cuadros
        drawFinish(ctx, finishX, car.y - car.h * 1.5, car.h * 3, dpr);
        // auto
        drawCar(ctx, car.x, car.y, car.w, car.h, accent);
        ctx.globalAlpha = 1;
      }

      if (el < DURATION) raf = requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [effect, emoji, accent, dark]);

  if (effect === "none") return null;
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
  // Efecto de festejo (con back-compat del viejo flag `confetti`).
  const effect =
    cfg.celebration && cfg.celebration !== "none"
      ? cfg.celebration
      : cfg.confetti
        ? "confetti"
        : "none";
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
        <Celebration effect={effect} emoji={cfg.celebrationEmoji} accent={accent} dark={dark} />
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
        <Celebration effect={effect} emoji={cfg.celebrationEmoji} accent={accent} dark={dark} />
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
      <Celebration effect={effect} emoji={cfg.celebrationEmoji} accent={accent} dark={dark} />
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
