"use client";

/**
 * Internacionalización de Encuestum (Suite Escriba).
 * Convención de la suite: siete idiomas fijos (en, es, fr, pt, it, zh, ja),
 * diccionarios planos sin framework, preferencia persistida en localStorage.
 * El diccionario base cubre el chrome (menú, nav, Acerca de, estados comunes);
 * cada área del panel se traduce en su propio archivo bajo i18n-dicts/ y se
 * mergea acá. Espejo del patrón de Presentia para consistencia en la suite.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export const LANGS = ["en", "es", "fr", "pt", "it", "zh", "ja"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  pt: "Português",
  it: "Italiano",
  zh: "中文",
  ja: "日本語",
};

type Dict = Record<string, string>;

const en: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "Surveys and assessments with AI grading",
  // Navegación / secciones
  "nav.surveys": "Surveys",
  "nav.members": "Members",
  "nav.panel": "Dashboard",
  "nav.integrations": "Integrations",
  "nav.ai": "AI",
  "nav.admin": "Admin",
  // Menú kebab
  "menu.title": "Menu",
  "menu.org": "Organization",
  "menu.noName": "No name",
  "menu.themeLight": "Light theme",
  "menu.themeDark": "Dark theme",
  "menu.language": "Language",
  "menu.about": "About Encuestum",
  "menu.logout": "Sign out",
  // Acerca de
  "about.version": "Version",
  "about.role": "Role in the suite",
  "about.role.value": "Satellite",
  "about.license": "License",
  "about.license.value": "MIT · open source",
  "about.author": "Diego Parras · Escriba ecosystem",
  // Estados comunes
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.retrying": "Retrying…",
  "common.cancel": "Cancel",
  "common.loadError.title": "Couldn't load",
  "common.loadError.body": "Check your connection and try again.",
  "common.disconnected.title": "No connection to the server",
  "common.disconnected.body":
    "We couldn't reach Encuestum. Check your connection or wait a few seconds — we retry automatically.",
};

const es: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "Encuestas y evaluaciones con corrección por IA",
  "nav.surveys": "Encuestas",
  "nav.members": "Miembros",
  "nav.panel": "Panel",
  "nav.integrations": "Integraciones",
  "nav.ai": "IA",
  "nav.admin": "Admin",
  "menu.title": "Menú",
  "menu.org": "Organización",
  "menu.noName": "Sin nombre",
  "menu.themeLight": "Tema claro",
  "menu.themeDark": "Tema oscuro",
  "menu.language": "Idioma",
  "menu.about": "Acerca de Encuestum",
  "menu.logout": "Cerrar sesión",
  "about.version": "Versión",
  "about.role": "Rol en la suite",
  "about.role.value": "Satélite",
  "about.license": "Licencia",
  "about.license.value": "MIT · open source",
  "about.author": "Diego Parras · Ecosistema Escriba",
  "common.loading": "Cargando…",
  "common.retry": "Reintentar",
  "common.retrying": "Reintentando…",
  "common.cancel": "Cancelar",
  "common.loadError.title": "No se pudo cargar",
  "common.loadError.body": "Revisá tu conexión e intentá de nuevo.",
  "common.disconnected.title": "Sin conexión con el servidor",
  "common.disconnected.body":
    "No pudimos contactar a Encuestum. Revisá tu conexión o esperá unos segundos — reintentamos solos.",
};

const fr: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "Enquêtes et évaluations avec correction par IA",
  "nav.surveys": "Enquêtes",
  "nav.members": "Membres",
  "nav.panel": "Tableau de bord",
  "nav.integrations": "Intégrations",
  "nav.ai": "IA",
  "nav.admin": "Admin",
  "menu.title": "Menu",
  "menu.org": "Organisation",
  "menu.noName": "Sans nom",
  "menu.themeLight": "Thème clair",
  "menu.themeDark": "Thème sombre",
  "menu.language": "Langue",
  "menu.about": "À propos d'Encuestum",
  "menu.logout": "Se déconnecter",
  "about.version": "Version",
  "about.role": "Rôle dans la suite",
  "about.role.value": "Satellite",
  "about.license": "Licence",
  "about.license.value": "MIT · open source",
  "about.author": "Diego Parras · Écosystème Escriba",
  "common.loading": "Chargement…",
  "common.retry": "Réessayer",
  "common.retrying": "Nouvelle tentative…",
  "common.cancel": "Annuler",
  "common.loadError.title": "Échec du chargement",
  "common.loadError.body": "Vérifiez votre connexion et réessayez.",
  "common.disconnected.title": "Pas de connexion au serveur",
  "common.disconnected.body":
    "Impossible de contacter Encuestum. Vérifiez votre connexion ou patientez quelques secondes — nous réessayons automatiquement.",
};

const pt: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "Pesquisas e avaliações com correção por IA",
  "nav.surveys": "Pesquisas",
  "nav.members": "Membros",
  "nav.panel": "Painel",
  "nav.integrations": "Integrações",
  "nav.ai": "IA",
  "nav.admin": "Admin",
  "menu.title": "Menu",
  "menu.org": "Organização",
  "menu.noName": "Sem nome",
  "menu.themeLight": "Tema claro",
  "menu.themeDark": "Tema escuro",
  "menu.language": "Idioma",
  "menu.about": "Sobre o Encuestum",
  "menu.logout": "Sair",
  "about.version": "Versão",
  "about.role": "Papel na suíte",
  "about.role.value": "Satélite",
  "about.license": "Licença",
  "about.license.value": "MIT · open source",
  "about.author": "Diego Parras · Ecossistema Escriba",
  "common.loading": "Carregando…",
  "common.retry": "Tentar de novo",
  "common.retrying": "Tentando de novo…",
  "common.cancel": "Cancelar",
  "common.loadError.title": "Não foi possível carregar",
  "common.loadError.body": "Verifique sua conexão e tente novamente.",
  "common.disconnected.title": "Sem conexão com o servidor",
  "common.disconnected.body":
    "Não conseguimos contatar o Encuestum. Verifique sua conexão ou aguarde alguns segundos — tentamos de novo sozinhos.",
};

const it: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "Sondaggi e valutazioni con correzione tramite IA",
  "nav.surveys": "Sondaggi",
  "nav.members": "Membri",
  "nav.panel": "Pannello",
  "nav.integrations": "Integrazioni",
  "nav.ai": "IA",
  "nav.admin": "Admin",
  "menu.title": "Menu",
  "menu.org": "Organizzazione",
  "menu.noName": "Senza nome",
  "menu.themeLight": "Tema chiaro",
  "menu.themeDark": "Tema scuro",
  "menu.language": "Lingua",
  "menu.about": "Informazioni su Encuestum",
  "menu.logout": "Esci",
  "about.version": "Versione",
  "about.role": "Ruolo nella suite",
  "about.role.value": "Satellite",
  "about.license": "Licenza",
  "about.license.value": "MIT · open source",
  "about.author": "Diego Parras · Ecosistema Escriba",
  "common.loading": "Caricamento…",
  "common.retry": "Riprova",
  "common.retrying": "Nuovo tentativo…",
  "common.cancel": "Annulla",
  "common.loadError.title": "Impossibile caricare",
  "common.loadError.body": "Controlla la connessione e riprova.",
  "common.disconnected.title": "Nessuna connessione al server",
  "common.disconnected.body":
    "Non siamo riusciti a contattare Encuestum. Controlla la connessione o attendi qualche secondo — riproviamo da soli.",
};

const zh: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "带 AI 批改的问卷与测评",
  "nav.surveys": "问卷",
  "nav.members": "成员",
  "nav.panel": "仪表板",
  "nav.integrations": "集成",
  "nav.ai": "AI",
  "nav.admin": "管理",
  "menu.title": "菜单",
  "menu.org": "组织",
  "menu.noName": "未命名",
  "menu.themeLight": "浅色主题",
  "menu.themeDark": "深色主题",
  "menu.language": "语言",
  "menu.about": "关于 Encuestum",
  "menu.logout": "退出登录",
  "about.version": "版本",
  "about.role": "在套件中的角色",
  "about.role.value": "卫星应用",
  "about.license": "许可证",
  "about.license.value": "MIT · 开源",
  "about.author": "Diego Parras · Escriba 生态",
  "common.loading": "加载中…",
  "common.retry": "重试",
  "common.retrying": "正在重试…",
  "common.cancel": "取消",
  "common.loadError.title": "无法加载",
  "common.loadError.body": "请检查网络连接后重试。",
  "common.disconnected.title": "无法连接服务器",
  "common.disconnected.body":
    "我们无法连接到 Encuestum。请检查网络连接或稍候片刻——系统会自动重试。",
};

const ja: Dict = {
  "app.name": "Encuestum",
  "app.tagline": "AI採点付きのアンケートと評価",
  "nav.surveys": "アンケート",
  "nav.members": "メンバー",
  "nav.panel": "ダッシュボード",
  "nav.integrations": "連携",
  "nav.ai": "AI",
  "nav.admin": "管理",
  "menu.title": "メニュー",
  "menu.org": "組織",
  "menu.noName": "名前なし",
  "menu.themeLight": "ライトテーマ",
  "menu.themeDark": "ダークテーマ",
  "menu.language": "言語",
  "menu.about": "Encuestum について",
  "menu.logout": "ログアウト",
  "about.version": "バージョン",
  "about.role": "スイート内の役割",
  "about.role.value": "サテライト",
  "about.license": "ライセンス",
  "about.license.value": "MIT · オープンソース",
  "about.author": "Diego Parras · Escriba エコシステム",
  "common.loading": "読み込み中…",
  "common.retry": "再試行",
  "common.retrying": "再試行中…",
  "common.cancel": "キャンセル",
  "common.loadError.title": "読み込めませんでした",
  "common.loadError.body": "接続を確認してもう一度お試しください。",
  "common.disconnected.title": "サーバーに接続できません",
  "common.disconnected.body":
    "Encuestum に接続できませんでした。接続を確認するか、数秒お待ちください — 自動的に再試行します。",
};

const BASE_DICTS: Record<Lang, Dict> = { en, es, fr, pt, it, zh, ja };

// Diccionarios por área (los llenan pasadas de traducción independientes).
import { dict as authDict } from "./i18n-dicts/auth";
import { dict as surveysDict } from "./i18n-dicts/surveys";
import { dict as builderDict } from "./i18n-dicts/builder";
import { dict as resultsDict } from "./i18n-dicts/results";
import { dict as membersDict } from "./i18n-dicts/members";
import { dict as panelDict } from "./i18n-dicts/panel";
import { dict as integrationsDict } from "./i18n-dicts/integrations";
import { dict as aiDict } from "./i18n-dicts/ai";
import { dict as adminDict } from "./i18n-dicts/admin";
import { dict as publicDict } from "./i18n-dicts/public";

const EXTRA_DICTS = [
  authDict,
  surveysDict,
  builderDict,
  resultsDict,
  membersDict,
  panelDict,
  integrationsDict,
  aiDict,
  adminDict,
  publicDict,
];

const DICTS: Record<Lang, Dict> = Object.fromEntries(
  LANGS.map((lang) => [
    lang,
    Object.assign(
      {},
      BASE_DICTS[lang],
      ...EXTRA_DICTS.map((extra) => extra[lang] || {})
    ),
  ])
) as Record<Lang, Dict>;

const STORAGE_KEY = "encuestum.lang";

function detectLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && (LANGS as readonly string[]).includes(stored)) return stored as Lang;
  const browser = (window.navigator.language || "en").slice(0, 2).toLowerCase();
  return (LANGS as readonly string[]).includes(browser) ? (browser as Lang) : "en";
}

type I18nContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue>({
  lang: "en",
  setLang: () => undefined,
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    setLangState(detectLang());
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.lang = next;
    } catch {
      /* storage no disponible */
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let text = DICTS[lang][key] ?? DICTS.en[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(`{${name}}`, String(value));
        }
      }
      return text;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
