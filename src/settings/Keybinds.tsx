import { useEffect, useState } from 'react';
import { sfxProps } from '../deck-core';
import { DEFAULT_KEYBINDS, KEYBIND_ACTIONS, type KeybindAction } from '../game/constants';
import { IconReset } from './icons';
import { keyLabel } from './keys';

type Binds = Record<KeybindAction, string>;

// Assign a key to an action. Swaps with any action already using that key so
// nothing ends up unbound.
function assign(binds: Binds, action: KeybindAction, code: string): Binds {
  const next = { ...binds };
  const prev = next[action];
  const conflict = (Object.keys(next) as KeybindAction[]).find((a) => a !== action && next[a] === code);
  next[action] = code;
  if (conflict) next[conflict] = prev;
  return next;
}

// Click a keycap, then press a key (Esc cancels). Shown as a grid of keycap chips.
export function KeybindGrid({ keybinds, onChange }: { keybinds: Binds; onChange: (b: Binds) => void }) {
  const [listening, setListening] = useState<KeybindAction | null>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListening(null);
        return;
      }
      onChange(assign(keybinds, listening, e.code));
      setListening(null);
    };
    // Capture phase + stopPropagation so the in-game InputManager doesn't also
    // see the rebind keypress.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, keybinds, onChange]);

  return (
    <div className='st-keys-wrap'>
      <div className='st-keys'>
        {KEYBIND_ACTIONS.map(({ id, label }) => {
          const dirty = keybinds[id] !== DEFAULT_KEYBINDS[id];
          const on = listening === id;
          return (
            <div key={id} className='st-krow' data-dirty={dirty ? 'true' : undefined}>
              <span className='st-krow-label'>
                {label}
                {dirty && <span className='st-dot' role='img' aria-label='changed from default' />}
              </span>
              <button
                type='button'
                className={`st-key ${on ? 'is-listening' : ''}`}
                onClick={() => setListening(on ? null : id)}
                aria-pressed={on}
                aria-label={`${label}: ${on ? 'press a key' : keyLabel(keybinds[id])}. Activate to rebind.`}
                {...sfxProps('uiClick')}
              >
                {on ? 'Press a key' : keyLabel(keybinds[id])}
              </button>
              <button
                type='button'
                className='st-reset'
                onClick={() => onChange(assign(keybinds, id, DEFAULT_KEYBINDS[id]))}
                aria-label={`Reset ${label} to ${keyLabel(DEFAULT_KEYBINDS[id])}`}
                title='Reset to default'
                tabIndex={dirty ? 0 : -1}
                aria-hidden={dirty ? undefined : true}
                data-shown={dirty ? 'true' : 'false'}
                {...sfxProps('uiClick')}
              >
                <IconReset />
              </button>
            </div>
          );
        })}
      </div>
      <p className='st-keys-foot'>
        <span>Click a key, then press the new one. Esc cancels.</span>
        <span className='st-keys-fixed'>
          <kbd className='st-key is-static'>LMB</kbd> Fire
          <kbd className='st-key is-static'>RMB</kbd> Boost
        </span>
      </p>
    </div>
  );
}
