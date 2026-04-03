import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import App from './App'
import ProjectList from './app/ProjectList'
import EditorPage from './app/editor/EditorPage'
import WorkflowsPage from './app/WorkflowsPage'
import OverlaysPage from './app/overlays/OverlaysPage'
import ProfilesPage from './app/profiles/ProfilesPage'
import NotFound from './app/NotFound'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<ProjectList />} />
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
