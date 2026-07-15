import { AUTH_URL, PROJECTS_URL, MAP_URL } from "@shared/urls"

export function NavBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <a href={PROJECTS_URL} className="text-sm font-semibold text-foreground">
          GeoBIM Stratum
        </a>
        <nav className="flex items-center gap-1">
          {[
            { label: "프로젝트", href: PROJECTS_URL },
            { label: "지도", href: MAP_URL },
            { label: "업로드", href: null },
          ].map(({ label, href }) =>
            href ? (
              <a
                key={label}
                href={href}
                className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {label}
              </a>
            ) : (
              <span
                key={label}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-foreground cursor-default"
              >
                {label}
              </span>
            ),
          )}
          <button
            onClick={() => {
              window.location.href = AUTH_URL
            }}
            className="ml-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            로그아웃
          </button>
        </nav>
      </div>
    </header>
  )
}
