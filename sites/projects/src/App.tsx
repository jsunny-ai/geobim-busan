import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import ProjectListPage from "@/pages/ProjectListPage"
import ProjectDetailPage from "@/pages/ProjectDetailPage"
import AdminBoreholeManagementPage from "@/pages/AdminBoreholeManagementPage"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 30_000 },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ProjectListPage />} />
          <Route path="/detail/:id" element={<ProjectDetailPage />} />
          <Route path="/admin/boreholes" element={<AdminBoreholeManagementPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
