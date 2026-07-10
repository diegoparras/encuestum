// Marca de Encuestum: barras de histograma + check con halo del color del fondo.
// Acento oliva-limón #8FAF0E (identidad dentro del stack Escriba).
export function EncuestumLogo({
  size = 22,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Encuestum"
      className={className}
    >
      <rect width="64" height="64" rx="15" fill="#8faf0e" />
      <rect x="14" y="32" width="7" height="18" rx="1.6" fill="#ffffff" />
      <rect x="26" y="24" width="7" height="26" rx="1.6" fill="#ffffff" />
      <rect x="38" y="16" width="7" height="34" rx="1.6" fill="#ffffff" />
      <path
        d="M35 24 l6 6 l8 -10"
        fill="none"
        stroke="#8faf0e"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M35 24 l6 6 l8 -10"
        fill="none"
        stroke="#ffffff"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
