import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import Landing from './pages/Landing';
import InstagibClient from './InstagibClient';

// NOTE: intentionally NOT wrapped in <StrictMode>. The game client owns a WebGL
// context, pointer-lock, and a WebSocket; React 18/19 StrictMode double-invokes
// effects in dev, which would spin up two GL contexts / two sockets. Production
// builds never run StrictMode anyway, so we keep dev and prod identical here.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/play" element={<InstagibClient />} />
    </Routes>
  </BrowserRouter>,
);
