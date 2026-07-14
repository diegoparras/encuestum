import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// ESLint 9 (flat config). `next lint` fue removido en Next 16, así que el script
// "lint" invoca ESLint directamente. eslint-config-next 16 ya exporta configs
// planas nativas, sin necesidad de FlatCompat.
export default [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "next-env.d.ts"],
  },
  ...coreWebVitals,
  ...typescript,
  {
    // Baseline pragmático: estas reglas disparan cientos de veces sobre patrones
    // que en este código son DELIBERADOS, así que quedan como aviso (visibles,
    // para limpiar de a poco) en vez de bloquear el CI. Todo lo demás sigue
    // siendo error, así que el CI sí frena regresiones nuevas.
    rules: {
      // El builder interopera con SurveyJS, cuyos esquemas son JSON dinámico:
      // tiparlo entero sería un refactor mayor y de poco valor real.
      "@typescript-eslint/no-explicit-any": "warn",
      // Reglas nuevas del React Compiler. Disparan sobre patrones legítimos como
      // setState dentro de useEffect para detectar viewport/tema tras hidratar
      // (imposible en render: dependen de window).
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
    },
  },
];
