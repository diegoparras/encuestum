// Resuelve un ChatSkin (+ overrides del usuario + acento + modo claro/oscuro) a
// un conjunto plano de tokens de estilo que consume ChatSurveyView. Cada skin
// imita el look de una app de mensajería conocida; los overrides de ChatOptions
// (colores de burbuja, radio, cola, identidad del bot) se aplican al final.

import type { ChatOptions, ChatSkin } from "../../../(survey-builder)/builder/model";

export interface ChatTheme {
  layout: "bubbles" | "channel"; // channel = estilo Slack/Discord (avatar + nombre)
  forceDark: boolean | null; // el skin fuerza claro/oscuro; null = sigue al diseño
  pageBg: string; // color/gradiente de fondo del hilo
  pattern: string | null; // patrón sutil opcional (background-image extra)
  botBubbleBg: string;
  botBubbleFg: string;
  userBubbleBg: string;
  userBubbleFg: string;
  radius: number; // px
  tails: boolean;
  fontFamily: string | null; // null = fuente del diseño
  // Header del chat
  headerBg: string;
  headerFg: string;
  headerSubFg: string;
  online: boolean;
  // Compositor + chips + envío
  composerBg: string;
  composerFg: string;
  sendBg: string;
  sendFg: string;
  chipBg: string;
  chipFg: string;
  chipBorder: string;
  chipActiveBg: string;
  chipActiveFg: string;
  // Identidad por defecto del skin
  botName: string;
  botAvatar: string;
  botStatus: string;
  // Extras visuales
  receiptColor: string; // color de las tildes ✓✓
}

function base(accent: string, dark: boolean): ChatTheme {
  return {
    layout: "bubbles",
    forceDark: null,
    pageBg: dark ? "#181c24" : "#f6f6f7",
    pattern: null,
    botBubbleBg: dark ? "#232833" : "#ffffff",
    botBubbleFg: dark ? "#e5e7eb" : "#1f2937",
    userBubbleBg: accent,
    userBubbleFg: "#ffffff",
    radius: 18,
    tails: true,
    fontFamily: null,
    headerBg: dark ? "#1c2029" : "#ffffff",
    headerFg: dark ? "#e5e7eb" : "#1f2937",
    headerSubFg: dark ? "#9aa2ad" : "#6b7280",
    online: true,
    composerBg: dark ? "#1c2029" : "#ffffff",
    composerFg: dark ? "#e5e7eb" : "#1f2937",
    sendBg: accent,
    sendFg: "#ffffff",
    chipBg: dark ? "#232833" : "#ffffff",
    chipFg: dark ? "#e5e7eb" : "#1f2937",
    chipBorder: dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.12)",
    chipActiveBg: accent,
    chipActiveFg: "#ffffff",
    botName: "Encuestum",
    botAvatar: "💬",
    botStatus: "en línea",
    receiptColor: dark ? "#9aa2ad" : "#9aa2ad",
  };
}

// Patrón sutil de puntos (para skins tipo WhatsApp/Telegram), como data URI.
const DOTS = (c: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='2' cy='2' r='1' fill='${encodeURIComponent(c)}'/%3E%3C/svg%3E")`;

export function resolveChatSkin(
  opts: ChatOptions,
  accent: string,
  designDark: boolean
): ChatTheme {
  const skin: ChatSkin = opts.skin || "encuestum";
  // Algunos skins fuerzan su propio modo; otros siguen al diseño.
  let dark = designDark;
  let t: ChatTheme;

  switch (skin) {
    case "whatsapp": {
      dark = designDark;
      t = base(accent, dark);
      t.pageBg = dark ? "#0b141a" : "#efeae2";
      t.pattern = DOTS(dark ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.03)");
      t.botBubbleBg = dark ? "#202c33" : "#ffffff";
      t.botBubbleFg = dark ? "#e9edef" : "#111b21";
      t.userBubbleBg = dark ? "#005c4b" : "#d9fdd3";
      t.userBubbleFg = dark ? "#e9edef" : "#111b21";
      t.radius = 8;
      t.headerBg = dark ? "#202c33" : "#008069";
      t.headerFg = "#ffffff";
      t.headerSubFg = "rgba(255,255,255,.75)";
      t.sendBg = "#00a884";
      t.chipActiveBg = "#25d366";
      t.receiptColor = "#53bdeb";
      t.botName = "Soporte";
      t.botAvatar = "🟢";
      t.botStatus = "en línea";
      break;
    }
    case "telegram": {
      dark = designDark;
      t = base(accent, dark);
      t.pageBg = dark ? "#0e1621" : "#dbe6f0";
      t.pattern = DOTS(dark ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.035)");
      t.botBubbleBg = dark ? "#182533" : "#ffffff";
      t.botBubbleFg = dark ? "#ffffff" : "#0f1620";
      t.userBubbleBg = dark ? "#2b5278" : "#eeffde";
      t.userBubbleFg = dark ? "#ffffff" : "#0f1620";
      t.radius = 12;
      t.headerBg = dark ? "#17212b" : "#517da2";
      t.headerFg = "#ffffff";
      t.headerSubFg = "rgba(255,255,255,.7)";
      t.sendBg = "#3390ec";
      t.chipActiveBg = "#3390ec";
      t.receiptColor = "#4fae4e";
      t.botName = "Bot";
      t.botAvatar = "✈️";
      t.botStatus = "bot";
      break;
    }
    case "imessage": {
      dark = designDark;
      t = base(accent, dark);
      t.pageBg = dark ? "#000000" : "#ffffff";
      t.botBubbleBg = dark ? "#26252a" : "#e9e9eb";
      t.botBubbleFg = dark ? "#ffffff" : "#000000";
      t.userBubbleBg = "linear-gradient(180deg,#1e90ff,#0a7cff)";
      t.userBubbleFg = "#ffffff";
      t.radius = 20;
      t.headerBg = dark ? "#1c1c1e" : "#f7f7f7";
      t.headerFg = dark ? "#ffffff" : "#000000";
      t.headerSubFg = dark ? "#8e8e93" : "#8e8e93";
      t.sendBg = "#0a7cff";
      t.chipActiveBg = "#0a7cff";
      t.online = false;
      t.botName = "Encuesta";
      t.botAvatar = "🔵";
      t.botStatus = "iMessage";
      break;
    }
    case "messenger": {
      dark = designDark;
      t = base(accent, dark);
      t.pageBg = dark ? "#111111" : "#ffffff";
      t.botBubbleBg = dark ? "#303030" : "#f0f0f0";
      t.botBubbleFg = dark ? "#e4e6eb" : "#050505";
      t.userBubbleBg = "linear-gradient(135deg,#00c6ff,#0084ff)";
      t.userBubbleFg = "#ffffff";
      t.radius = 18;
      t.headerBg = dark ? "#242526" : "#ffffff";
      t.headerFg = dark ? "#e4e6eb" : "#050505";
      t.headerSubFg = dark ? "#b0b3b8" : "#65676b";
      t.sendBg = "#0084ff";
      t.chipActiveBg = "#0084ff";
      t.botName = "Chat";
      t.botAvatar = "💬";
      t.botStatus = "activo ahora";
      break;
    }
    case "slack": {
      dark = designDark;
      t = base(accent, dark);
      t.layout = "channel";
      t.pageBg = dark ? "#1a1d21" : "#ffffff";
      t.botBubbleBg = "transparent";
      t.botBubbleFg = dark ? "#d1d2d3" : "#1d1c1d";
      t.userBubbleBg = "transparent";
      t.userBubbleFg = dark ? "#d1d2d3" : "#1d1c1d";
      t.headerBg = dark ? "#350d36" : "#3f0e40";
      t.headerFg = "#ffffff";
      t.headerSubFg = "rgba(255,255,255,.7)";
      t.sendBg = "#007a5a";
      t.chipBg = dark ? "#222529" : "#ffffff";
      t.chipFg = dark ? "#d1d2d3" : "#1d1c1d";
      t.chipActiveBg = "#007a5a";
      t.botName = "encuestas";
      t.botAvatar = "📊";
      t.botStatus = "app";
      break;
    }
    case "discord": {
      dark = true; // Discord es oscuro por naturaleza
      t = base(accent, true);
      t.forceDark = true;
      t.layout = "channel";
      t.pageBg = "#313338";
      t.botBubbleBg = "transparent";
      t.botBubbleFg = "#dbdee1";
      t.userBubbleBg = "transparent";
      t.userBubbleFg = "#dbdee1";
      t.headerBg = "#2b2d31";
      t.headerFg = "#f2f3f5";
      t.headerSubFg = "#b5bac1";
      t.composerBg = "#383a40";
      t.composerFg = "#dbdee1";
      t.sendBg = "#5865f2";
      t.chipBg = "#2b2d31";
      t.chipFg = "#dbdee1";
      t.chipBorder = "rgba(255,255,255,.08)";
      t.chipActiveBg = "#5865f2";
      t.botName = "Encuestum";
      t.botAvatar = "🎮";
      t.botStatus = "BOT";
      break;
    }
    case "terminal": {
      dark = true;
      t = base(accent, true);
      t.forceDark = true;
      t.pageBg = "#0a0e0a";
      t.botBubbleBg = "rgba(51,255,102,.06)";
      t.botBubbleFg = "#33ff66";
      t.userBubbleBg = "rgba(51,255,102,.14)";
      t.userBubbleFg = "#7bff9b";
      t.radius = 2;
      t.tails = false;
      t.fontFamily = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
      t.headerBg = "#0a0e0a";
      t.headerFg = "#33ff66";
      t.headerSubFg = "#1f9d4d";
      t.composerBg = "#0d130d";
      t.composerFg = "#7bff9b";
      t.sendBg = "#15803d";
      t.chipBg = "rgba(51,255,102,.06)";
      t.chipFg = "#33ff66";
      t.chipBorder = "rgba(51,255,102,.35)";
      t.chipActiveBg = "#15803d";
      t.chipActiveFg = "#eaffea";
      t.botName = "encuestum@bash";
      t.botAvatar = "▶";
      t.botStatus = "~/survey";
      break;
    }
    case "minimal": {
      dark = designDark;
      t = base(accent, dark);
      t.pageBg = dark ? "#0f1115" : "#ffffff";
      t.botBubbleBg = "transparent";
      t.botBubbleFg = dark ? "#f3f4f6" : "#111827";
      t.userBubbleBg = dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.05)";
      t.userBubbleFg = dark ? "#f3f4f6" : "#111827";
      t.radius = 12;
      t.tails = false;
      t.online = false;
      t.chipBg = "transparent";
      t.chipBorder = dark ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.15)";
      t.botName = "";
      t.botAvatar = "";
      t.botStatus = "";
      break;
    }
    case "encuestum":
    default:
      t = base(accent, dark);
      break;
  }

  // Overrides del usuario (siempre ganan sobre el skin).
  if (opts.botBubbleColor) t.botBubbleBg = opts.botBubbleColor;
  if (opts.userBubbleColor) {
    t.userBubbleBg = opts.userBubbleColor;
    t.chipActiveBg = opts.userBubbleColor;
  }
  if (typeof opts.bubbleRadius === "number") t.radius = opts.bubbleRadius;
  if (typeof opts.tails === "boolean") t.tails = opts.tails;
  if (opts.botName) t.botName = opts.botName;
  if (opts.botAvatar) t.botAvatar = opts.botAvatar;
  if (opts.botStatus) t.botStatus = opts.botStatus;

  return t;
}
