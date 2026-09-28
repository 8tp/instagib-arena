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
const RewardsLab = lazy(() => import('./ui/RewardsLab'));
const GunLab = lazy(() => import('./game/gun/GunLab'));
const AdminDashboard = lazy(() => import('./AdminDashboard'));

// Full-screen fallback while a route chunk downloads. Same deck ground as the
// pages either side of it (no flash), the crosshair mark from the favicon /
// landing page, and a thin cyan sweep so it reads as "loading", not "hung".
// The sweep + pulse are CSS and go still under prefers-reduced-motion.
const Loading = () => (
  <div
    role='status'
    aria-live='polite'
    className='menu-root fixed inset-0 flex flex-col items-center justify-center text-white'
  >
    {/* The menu's wordmark (same classes), so the hand-off reads as one screen. */}
    <div className='menu-wordmark items-center text-center'>
      <span className='menu-wordmark-main' style={{ fontSize: 'clamp(2.75rem, 6vw, 4.5rem)' }}>
        Instagib
      </span>
      <span className='menu-wordmark-sub justify-center'>
        <span aria-hidden='true' className='menu-beam' />
        <span>Arena</span>
      </span>
    </div>
    <div className='mt-8 font-mono text-[10px] uppercase tracking-[0.3em] text-white/45'>Loading</div>
    <div className='deck-loader-bar mt-3 w-48' aria-hidden='true' />
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
        path="/rewardslab"
        element={
          <Suspense fallback={<Loading />}>
            <RewardsLab />
          </Suspense>
        }
      />
      <Route
        path="/gunlab"
        element={
          <Suspense fallback={<Loading />}>
            <GunLab />
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
