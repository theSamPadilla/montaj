import React, { lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import App from './App'
import ProjectList from './app/ProjectList'
import NotFound from './app/NotFound'
import { useIsMobile } from './lib/useIsMobile'
import MobileProjectList from './app/MobileProjectList'
import './index.css'

const EditorPage    = lazy(() => import('./app/editor/EditorPage'))
const WorkflowsPage = lazy(() => import('./app/WorkflowsPage'))
const OverlaysPage  = lazy(() => import('./app/overlays/OverlaysPage'))
const ProfilesPage  = lazy(() => import('./app/profiles/ProfilesPage'))

function ProjectListRoute() {
  return useIsMobile() ? <MobileProjectList /> : <ProjectList />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<ProjectListRoute />} />
          <Route path="projects/:id" element={<EditorPage />} />
          <Route path="workflows" element={<WorkflowsPage />} />
          <Route path="overlays"  element={<OverlaysPage />} />
          <Route path="profiles" element={<ProfilesPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
