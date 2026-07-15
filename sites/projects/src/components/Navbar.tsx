import { Database, LogOut, Map, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AUTH_URL, PROJECTS_URL, MAP_URL, UPLOAD_URL, API_URL } from "@shared/urls"

interface Props {
  active?: "projects" | "map" | "upload" | "admin"
}

async function handleLogout() {
  try {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    })
  } finally {
    window.location.href = AUTH_URL
  }
}

export default function Navbar({ active }: Props) {
  return (
    <header className="h-12 border-b border-border bg-card px-4 flex items-center justify-between shrink-0">
      <a href="/" className="flex items-center gap-2">
        <div className="h-6 w-6 rounded bg-stone-400" />
        <span className="text-sm font-semibold">GeoBIM Stratum</span>
      </a>

      <nav className="flex items-center gap-1">
        <Button
          variant={active === "projects" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => { window.location.href = PROJECTS_URL }}
        >
          프로젝트
        </Button>
        <Button
          variant={active === "map" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => { window.location.href = MAP_URL }}
        >
          <Map className="mr-1 h-3.5 w-3.5" /> 지도
        </Button>
        <Button
          variant={active === "upload" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => { window.location.href = UPLOAD_URL }}
        >
          <Upload className="mr-1 h-3.5 w-3.5" /> 업로드
        </Button>
        <Button
          variant={active === "admin" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 text-xs"
          onClick={() => { window.location.href = `${PROJECTS_URL}/admin/boreholes` }}
        >
          <Database className="mr-1 h-3.5 w-3.5" /> 시추공 관리
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground"
          onClick={handleLogout}
        >
          <LogOut className="mr-1 h-3.5 w-3.5" /> 로그아웃
        </Button>
      </nav>
    </header>
  )
}
