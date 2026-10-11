type WavedashSdk = {
  init: () => boolean;
  updateLoadProgressZeroToOne: (progress: number) => void;
};

export const wavedashBuild = import.meta.env.VITE_WAVEDASH === '1';

// Wavedash injects the SDK before the game starts; regular web builds have none.
export function finishWavedashLoading(): void {
  const sdk = (window as Window & { Wavedash?: WavedashSdk }).Wavedash;
  if (!sdk) return;
  sdk.updateLoadProgressZeroToOne(1);
  sdk.init();
}
