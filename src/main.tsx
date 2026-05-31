import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import Landing from './pages/Landing';

// Code-split the game client: it drags in the whole Three.js engine (~1MB), and
// the landing page shouldn't pay for that on first paint. The /play route loads
// it lazily; Landing stays eager so the splash is instant.
const InstagibClient = lazy(() => import('./InstagibClient'));
const PodiumLab = lazy(() => import('./PodiumLab'));
const LockerLab = lazy(() => import('./LockerLab'));

// Minimal full-screen fallback while the game chunk downloads — matches the
// app's dark background so there's no flash.
const Loading = () => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0b',
      color: '#6b7280',
      fontFamily: 'system-ui, sans-serif',
    }}
  >
    Loading…
  </div>
);

// NOTE: intentionally NOT wrapped in <StrictMode>. The game client owns a WebGL
// context, pointer-lock, and a WebSocket; React 18/19 StrictMode double-invokes
// effects in dev, which would spin up two GL contexts / two sockets. Production
// builds never run StrictMode anyway, so we keep dev and prod identical here.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/play"
        element={
          <Suspense fallback={<Loading />}>
            <InstagibClient />
          </Suspense>
        }
      />
      <Route
        path="/podiumlab"
        element={
          <Suspense fallback={<Loading />}>
            <PodiumLab />
          </Suspense>
        }
      />
      <Route
        path="/lockerlab"
        element={
          <Suspense fallback={<Loading />}>
            <LockerLab />
          </Suspense>
        }
      />
    </Routes>
  </BrowserRouter>,
);
