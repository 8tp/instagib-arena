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
const AdminDashboard = lazy(() => import('./AdminDashboard'));

// Full-screen fallback while a route chunk downloads. Same deck ground as the
// pages either side of it (no flash), the crosshair mark from the favicon /
// landing page, and a thin cyan sweep so it reads as "loading", not "hung".
// The sweep + pulse are CSS and go still under prefers-reduced-motion.
const Loading = () => (
  <div
    role='status'
    aria-live='polite'
    className='deck-bg fixed inset-0 flex flex-col items-center justify-center text-white'
  >
    <div className='deck-scan pointer-events-none absolute inset-0' aria-hidden='true' />
    <svg viewBox='0 0 32 32' width='40' height='40' aria-hidden='true' className='deck-pulse text-cyan-300'>
      <circle cx='16' cy='16' r='9' fill='none' stroke='currentColor' strokeWidth='2' />
      <line x1='16' y1='3' x2='16' y2='11' stroke='currentColor' strokeWidth='2' />
      <line x1='16' y1='21' x2='16' y2='29' stroke='currentColor' strokeWidth='2' />
      <line x1='3' y1='16' x2='11' y2='16' stroke='currentColor' strokeWidth='2' />
      <line x1='21' y1='16' x2='29' y2='16' stroke='currentColor' strokeWidth='2' />
      <circle cx='16' cy='16' r='1.6' fill='currentColor' />
    </svg>
    <div className='mt-5 font-display text-2xl font-bold uppercase leading-none tracking-[0.3em]'>
      Instagib <span className='text-cyan-300'>Arena</span>
    </div>
    <div className='mt-3 font-mono text-[10px] uppercase tracking-[0.3em] text-white/40'>Loading arena</div>
    <div className='deck-loader-bar mt-6 w-48' aria-hidden='true' />
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
      <Route
        path="/admin"
        element={
          <Suspense fallback={<Loading />}>
            <AdminDashboard />
          </Suspense>
        }
      />
    </Routes>
  </BrowserRouter>,
);
