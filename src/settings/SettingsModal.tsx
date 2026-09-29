import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { DeckButton, DeckTab, ModalShell, TextButton } from '../deck';
import { toast } from '../deck-core';
import { FeedbackModal } from '../FeedbackModal';
import {
  cm360,
  MAX_DPI,
  MAX_FOV,
  MAX_SENSITIVITY,
  MAX_VERT_SCALE,
  MAX_VIEWMODEL_OFFSET,
  MAX_ZOOM_FOV,
  MIN_DPI,
  MIN_FOV,
  MIN_SENSITIVITY,
  MIN_VERT_SCALE,
  MIN_VIEWMODEL_OFFSET,
  MIN_ZOOM_FOV,
  SENSITIVITY_STEP,
} from '../game/constants';
import type { CrosshairConfig, Settings } from '../app-types';
import { DEFAULT_CROSSHAIR, DEFAULT_SETTINGS } from './codec';
import { CrosshairColorPresets, CrosshairPreview, CrosshairShapePresets } from './CrosshairPreview';
import {
  AnnouncerPackRow,
  ColorRow,
  CrosshairShare,
  NumberRow,
  SegRow,
  SelectRow,
  SettingRow,
  SettingsCard,
  SettingsShare,
  SliderRow,
  TextRow,
  ToggleRow,
} from './fields';
import { IconAccess, IconAudio, IconClear, IconControls, IconCrosshair, IconProfile, IconSearch, IconVideo } from './icons';
import { KeybindGrid } from './Keybinds';
import './settings.css';

export type SettingsTab = 'controls' | 'crosshair' | 'video' | 'audio' | 'accessibility' | 'profile';

const TABS: ReadonlyArray<{ id: SettingsTab; label: string; blurb: string; icon: ReactNode }> = [
  { id: 'controls', label: 'Controls', blurb: 'Mouse, field of view and key bindings.', icon: <IconControls /> },
  { id: 'crosshair', label: 'Crosshair', blurb: 'Shape, color and outline, with a live preview.', icon: <IconCrosshair /> },
  { id: 'video', label: 'Video', blurb: 'Frame rate, quality, post-processing and the weapon viewmodel.', icon: <IconVideo /> },
  { id: 'audio', label: 'Audio', blurb: 'Volumes, UI sounds and the announcer.', icon: <IconAudio /> },
  { id: 'accessibility', label: 'Accessibility', blurb: 'Reduce motion, hide chat and make enemies easier to see.', icon: <IconAccess /> },
  { id: 'profile', label: 'Profile', blurb: 'Your name, server and settings backup.', icon: <IconProfile /> },
];

// Which Settings keys each tab owns — drives the "changed" dot on the rail.
const TAB_KEYS: Record<SettingsTab, ReadonlyArray<keyof Settings>> = {
  controls: ['sensitivity', 'dpi', 'vertScale', 'zoomSens', 'rawInput', 'keybinds', 'fov', 'zoomFov'],
  crosshair: ['crosshair'],
  video: [
    'showFps', 'showPing', 'fpsLimit', 'resolutionScale', 'lowSpec', 'uiScale', 'bloom', 'bloomIntensity',
    'shadows', 'antialias', 'vignette', 'hideViewmodel', 'viewmodelMotion', 'viewmodelOffset', 'worldColor',
    'worldBrightness',
  ],
  audio: ['volume', 'sfxVolume', 'uiSounds', 'announcerEnabled', 'announcerVolume', 'announcerPack', 'captions'],
  accessibility: ['reducedEffects', 'hideChat', 'enemyBright', 'enemyColor'],
  profile: [],
};

type RowSpec = { id: string; text: string; node: ReactNode };
type CardSpec = { id: string; tab: SettingsTab; title: string; note?: ReactNode; rows: RowSpec[]; bare?: boolean };

const row = (id: string, text: string, node: ReactNode): RowSpec => ({ id, text: text.toLowerCase(), node });

const pct = (v: number) => `${Math.round(v * 100)}%`;
const deg = (v: number) => `${v.toFixed(0)}°`;
const px = (v: number) => `${v}px`;
const times = (v: number) => `${v.toFixed(2)}×`;

function matches(q: string, ...parts: string[]): boolean {
  const hay = parts.join(' ').toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

export function SettingsModal({
  settings,
  onChange,
  onClose,
  initialTab = 'controls',
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const ch = settings.crosshair;
  const setCh = (patch: Partial<CrosshairConfig>) => onChange({ ...settings, crosshair: { ...ch, ...patch } });
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  // Your name is your identity (account username, or "Guest" — set by the auth
  // effect in the parent), and is server-authoritative, so the field is shown
  // read-only. Guests can't pick a name; in matches they appear as "Guest N".
  const isGuestName = !settings.playerName || settings.playerName === 'Guest';
  const D = DEFAULT_SETTINGS;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  // Settings save continuously; "Done" only confirms (toast) if anything
  // actually changed while the sheet was open.
  const openedWith = useRef(settings);
  const paneRef = useRef<HTMLDivElement>(null);

  const cm = cm360(settings.sensitivity, settings.dpi);
  const lowSpec = settings.lowSpec;

  const cards: CardSpec[] = [
    /* ── Controls ── */
    {
      id: 'mouse',
      tab: 'controls',
      title: 'Mouse',
      rows: [
        row(
          'sens',
          'sensitivity sens cm 360 inches',
          <SliderRow
            label='Sensitivity'
            hint={`${cm.toFixed(1)} cm / 360° (${(cm / 2.54).toFixed(1)} in) at ${settings.dpi} DPI`}
            value={settings.sensitivity}
            min={MIN_SENSITIVITY}
            max={MAX_SENSITIVITY}
            step={SENSITIVITY_STEP}
            def={D.sensitivity}
            format={(v) => v.toFixed(2)}
            onChange={(v) => set({ sensitivity: v })}
          />,
        ),
        row(
          'dpi',
          'mouse dpi',
          <NumberRow
            label='Mouse DPI'
            hint='Your mouse’s hardware setting, used for the cm / 360° readout.'
            value={settings.dpi}
            min={MIN_DPI}
            max={MAX_DPI}
            step={50}
            def={D.dpi}
            onChange={(v) => set({ dpi: v })}
          />,
        ),
        row(
          'vert',
          'vertical sens scale',
          <SliderRow
            label='Vertical sensitivity'
            value={settings.vertScale}
            min={MIN_VERT_SCALE}
            max={MAX_VERT_SCALE}
            step={0.05}
            def={D.vertScale}
            format={times}
            onChange={(v) => set({ vertScale: v })}
          />,
        ),
        row(
          'raw',
          'raw input accel acceleration',
          <ToggleRow
            label='Raw input'
            hint='Bypass OS mouse acceleration.'
            value={settings.rawInput}
            def={D.rawInput}
            onChange={(v) => set({ rawInput: v })}
          />,
        ),
      ],
    },
    {
      id: 'fov',
      tab: 'controls',
      title: 'Field of view',
      rows: [
        row(
          'fov',
          'field of view fov',
          <SliderRow label='Field of view' value={settings.fov} min={MIN_FOV} max={MAX_FOV} step={1} def={D.fov} format={deg} onChange={(v) => set({ fov: v })} />,
        ),
        row(
          'zoomfov',
          'zoom fov ads',
          <SliderRow label='Zoom FOV' hint='Your view while holding Zoom.' value={settings.zoomFov} min={MIN_ZOOM_FOV} max={MAX_ZOOM_FOV} step={1} def={D.zoomFov} format={deg} onChange={(v) => set({ zoomFov: v })} />,
        ),
        row(
          'zoomsens',
          'ads zoom sensitivity aim',
          <SliderRow
            label='Zoom sensitivity'
            hint='Look speed while zoomed, on top of the FOV-scaled default. Lower it for precise long-range flicks.'
            value={settings.zoomSens}
            min={0.1}
            max={2}
            step={0.05}
            def={D.zoomSens}
            format={times}
            onChange={(v) => set({ zoomSens: v })}
          />,
        ),
      ],
    },
    {
      id: 'keybinds',
      tab: 'controls',
      title: 'Keybinds',
      rows: [
        row(
          'keys',
          'keybind bind key rebind move forward back strafe left right jump dash zoom scoreboard chat taunt inspect weapon',
          <KeybindGrid keybinds={settings.keybinds} onChange={(b) => set({ keybinds: b })} />,
        ),
      ],
    },

    /* ── Crosshair ── */
    {
      id: 'xh-preview',
      tab: 'crosshair',
      title: 'Preview',
      bare: true,
      rows: [row('preview', 'crosshair preview reticle', <CrosshairPreview cfg={ch} />)],
    },
    {
      id: 'xh-shape',
      tab: 'crosshair',
      title: 'Shape',
      rows: [
        row('presets', 'presets shape plus dot', <CrosshairShapePresets cfg={ch} onPick={setCh} />),
        row(
          'style',
          'style cross dot circle',
          <SegRow
            label='Style'
            value={ch.style}
            def={DEFAULT_CROSSHAIR.style}
            options={[
              { id: 'cross', label: 'Cross' },
              { id: 'cross-dot', label: 'Cross + dot' },
              { id: 'dot', label: 'Dot' },
              { id: 'circle', label: 'Circle' },
            ]}
            onChange={(v) => setCh({ style: v })}
          />,
        ),
        row('size', 'size length', <SliderRow label='Size' value={ch.size} min={0} max={30} step={1} def={DEFAULT_CROSSHAIR.size} format={px} onChange={(v) => setCh({ size: v })} />),
        row('thick', 'thickness width', <SliderRow label='Thickness' value={ch.thickness} min={1} max={8} step={1} def={DEFAULT_CROSSHAIR.thickness} format={px} onChange={(v) => setCh({ thickness: v })} />),
        row('gap', 'gap spread', <SliderRow label='Gap' value={ch.gap} min={0} max={20} step={1} def={DEFAULT_CROSSHAIR.gap} format={px} onChange={(v) => setCh({ gap: v })} />),
        row('dot', 'center dot', <SliderRow label='Center dot' value={ch.dotSize} min={0} max={10} step={1} def={DEFAULT_CROSSHAIR.dotSize} format={(v) => (v === 0 ? 'off' : `${v}px`)} onChange={(v) => setCh({ dotSize: v })} />),
      ],
    },
    {
      id: 'xh-color',
      tab: 'crosshair',
      title: 'Color and outline',
      rows: [
        row(
          'color',
          'color colour',
          <ColorRow label='Color' value={ch.color} def={DEFAULT_CROSSHAIR.color} onChange={(v) => setCh({ color: v })} />,
        ),
        row(
          'colorpresets',
          'color presets high visibility',
          <SettingRow label='High-visibility colors' hint='One-click colors that read on most maps.'>
            <CrosshairColorPresets value={ch.color} onPick={(c) => setCh({ color: c })} />
          </SettingRow>,
        ),
        row('outline', 'outline', <ToggleRow label='Outline' hint='A thin border keeps the crosshair readable on bright walls.' value={ch.outline} def={DEFAULT_CROSSHAIR.outline} onChange={(v) => setCh({ outline: v })} />),
        ...(ch.outline
          ? [
              row('outw', 'outline width thickness', <SliderRow label='Outline width' value={ch.outlineThickness} min={1} max={4} step={1} def={DEFAULT_CROSSHAIR.outlineThickness} format={px} onChange={(v) => setCh({ outlineThickness: v })} />),
              row('outc', 'outline color', <ColorRow label='Outline color' value={ch.outlineColor} def={DEFAULT_CROSSHAIR.outlineColor} onChange={(v) => setCh({ outlineColor: v })} />),
            ]
          : []),
      ],
    },
    {
      id: 'xh-share',
      tab: 'crosshair',
      title: 'Share',
      rows: [row('share', 'share code import export crosshair', <CrosshairShare cfg={ch} onImport={(next) => set({ crosshair: next })} />)],
    },

    /* ── Video ── */
    {
      id: 'display',
      tab: 'video',
      title: 'Display',
      rows: [
        row('fps', 'show fps counter', <ToggleRow label='Show FPS' value={settings.showFps} def={D.showFps} onChange={(v) => set({ showFps: v })} />),
        row(
          'ping',
          'show ping scoreboard latency',
          <ToggleRow
            label='Show ping on scoreboard'
            hint='Each player’s connection to the server, on the Tab scoreboard (online matches).'
            value={settings.showPing}
            def={D.showPing}
            onChange={(v) => set({ showPing: v })}
          />,
        ),
        row(
          'fpslimit',
          'frame rate limit fps vsync unlimited',
          <SelectRow
            label='Frame rate limit'
            hint='VSync matches your monitor. “Unlimited” gives the lowest input latency at much higher CPU/GPU use.'
            value={String(settings.fpsLimit)}
            def={String(D.fpsLimit)}
            options={[
              { id: '0', label: 'VSync (display refresh)' },
              { id: '240', label: '240 fps' },
              { id: '144', label: '144 fps' },
              { id: '120', label: '120 fps' },
              { id: '60', label: '60 fps' },
              { id: '-1', label: 'Unlimited (uncapped)' },
            ]}
            onChange={(v) => set({ fpsLimit: Number(v) })}
          />,
        ),
      ],
    },
    {
      id: 'quality',
      tab: 'video',
      title: 'Quality',
      rows: [
        row('res', 'resolution scale render', <SliderRow label='Resolution scale' hint='Lower it if the game runs hot.' value={settings.resolutionScale} min={0.5} max={2} step={0.05} def={D.resolutionScale} format={pct} onChange={(v) => set({ resolutionScale: v })} />),
        row(
          'lowspec',
          'low spec performance',
          <ToggleRow
            label='Low-spec mode'
            hint='Caps high-DPI rendering, thins particle effects and turns off the post-processing below.'
            value={settings.lowSpec}
            def={D.lowSpec}
            onChange={(v) => set({ lowSpec: v })}
          />,
        ),
        row('ui', 'ui scale hud size', <SliderRow label='UI scale' hint='Resizes the in-match HUD.' value={settings.uiScale} min={0.7} max={1.5} step={0.05} def={D.uiScale} format={pct} onChange={(v) => set({ uiScale: v })} />),
      ],
    },
    {
      id: 'post',
      tab: 'video',
      title: 'Post-processing',
      note: lowSpec ? 'Off on low-spec. Turn off Low-spec mode to use these.' : 'Each costs a little GPU.',
      rows: [
        row('bloom', 'bloom glow', <ToggleRow label='Bloom' hint='Glows rail beams and lights.' value={settings.bloom} def={D.bloom} disabled={lowSpec} onChange={(v) => set({ bloom: v })} />),
        row('bloomi', 'bloom intensity glow', <SliderRow label='Bloom intensity' value={settings.bloomIntensity ?? 0.8} min={0} max={1.5} step={0.05} def={0.8} format={pct} onChange={(v) => set({ bloomIntensity: v })} />),
        row('shadows', 'shadows shadow', <ToggleRow label='Shadows' hint='Grounds players and cover in the arena.' value={settings.shadows} def={D.shadows} disabled={lowSpec} onChange={(v) => set({ shadows: v })} />),
        row('aa', 'anti-aliasing antialiasing smaa aa edges', <ToggleRow label='Anti-aliasing' hint='SMAA smooths jagged edges.' value={settings.antialias} def={D.antialias} disabled={lowSpec} onChange={(v) => set({ antialias: v })} />),
        row('vig', 'vignette corners', <ToggleRow label='Vignette' hint='Darkens the screen corners.' value={settings.vignette} def={D.vignette} disabled={lowSpec} onChange={(v) => set({ vignette: v })} />),
      ],
    },
    {
      id: 'viewmodel',
      tab: 'video',
      title: 'Weapon viewmodel',
      note: 'The railgun sits low and to the side so it never blocks your aim. Bind “Zoom (hold)” under Controls to narrow your FOV.',
      rows: [
        row('hidevm', 'hide viewmodel weapon gun', <ToggleRow label='Hide viewmodel' value={settings.hideViewmodel} def={D.hideViewmodel} onChange={(v) => set({ hideViewmodel: v })} />),
        ...(settings.hideViewmodel
          ? []
          : [
              row(
                'motion',
                'weapon motion bob sway',
                <SliderRow
                  label='Weapon motion'
                  hint='Scales the bob, sway and landing dip. 0% holds the gun still; the fire kick always stays.'
                  value={settings.viewmodelMotion}
                  min={0}
                  max={1}
                  step={0.05}
                  def={D.viewmodelMotion}
                  format={pct}
                  onChange={(v) => set({ viewmodelMotion: v })}
                />,
              ),
              ...(['x', 'y', 'z'] as const).map((axis) =>
                row(
                  `off${axis}`,
                  `weapon offset ${axis} position`,
                  <SliderRow
                    label={`Offset ${axis.toUpperCase()}`}
                    value={settings.viewmodelOffset[axis]}
                    min={MIN_VIEWMODEL_OFFSET}
                    max={MAX_VIEWMODEL_OFFSET}
                    step={0.01}
                    def={D.viewmodelOffset[axis]}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => set({ viewmodelOffset: { ...settings.viewmodelOffset, [axis]: v } })}
                  />,
                ),
              ),
            ]),
      ],
    },
    {
      id: 'map',
      tab: 'video',
      title: 'Map',
      rows: [
        row('tint', 'map tint color', <ColorRow label='Map tint' value={settings.worldColor} def={D.worldColor} onChange={(v) => set({ worldColor: v })} />),
        row('bright', 'map brightness', <SliderRow label='Map brightness' value={settings.worldBrightness} min={0} max={1} step={0.05} def={D.worldBrightness} format={pct} onChange={(v) => set({ worldBrightness: v })} />),
      ],
    },

    /* ── Audio ── */
    {
      id: 'volume',
      tab: 'audio',
      title: 'Volume',
      rows: [
        row('master', 'master volume sound', <SliderRow label='Master volume' value={settings.volume} min={0} max={1} step={0.01} def={D.volume} format={pct} onChange={(v) => set({ volume: v })} />),
        row('sfx', 'sfx effects volume', <SliderRow label='SFX volume' value={settings.sfxVolume} min={0} max={1} step={0.01} def={D.sfxVolume} format={pct} onChange={(v) => set({ sfxVolume: v })} />),
        row(
          'uisounds',
          'ui sounds click menu interface',
          <ToggleRow
            label='UI sounds'
            hint='Menu clicks, hovers and toggles. Follows the master and SFX sliders.'
            value={settings.uiSounds}
            def={D.uiSounds}
            onChange={(v) => set({ uiSounds: v })}
          />,
        ),
      ],
    },
    {
      id: 'announcer',
      tab: 'audio',
      title: 'Announcer',
      rows: [
        row('annon', 'announcer voice', <ToggleRow label='Announcer' value={settings.announcerEnabled} def={D.announcerEnabled} onChange={(v) => set({ announcerEnabled: v })} />),
        ...(settings.announcerEnabled
          ? [
              row('annvol', 'announcer volume', <SliderRow label='Announcer volume' value={settings.announcerVolume} min={0} max={1} step={0.01} def={D.announcerVolume} format={pct} onChange={(v) => set({ announcerVolume: v })} />),
              row('annpack', 'announcer pack voice', <AnnouncerPackRow value={settings.announcerPack} onChange={(v) => set({ announcerPack: v })} />),
            ]
          : []),
        row(
          'captions',
          'announcer captions subtitles deaf',
          <ToggleRow
            label='Announcer captions'
            hint='Show medal and match callouts as on-screen text. Callouts are also exposed to screen readers.'
            value={settings.captions}
            def={D.captions}
            onChange={(v) => set({ captions: v })}
          />,
        ),
      ],
    },

    /* ── Accessibility ── */
    {
      id: 'comfort',
      tab: 'accessibility',
      title: 'Comfort',
      rows: [
        row(
          'reduced',
          'reduced effects shake flash motion explosions',
          <ToggleRow
            label='Reduced effects'
            hint='Suppresses camera shake, the kill flash and heavy explosions (small sparks instead). Defaults to your system’s reduce-motion setting.'
            value={settings.reducedEffects}
            def={D.reducedEffects}
            onChange={(v) => set({ reducedEffects: v })}
          />,
        ),
        row(
          'hidechat',
          'hide chat',
          <ToggleRow
            label='Hide chat'
            hint='Hides the in-game chat log and disables opening it. Rebind the Chat key under Controls.'
            value={settings.hideChat}
            def={D.hideChat}
            onChange={(v) => set({ hideChat: v })}
          />,
        ),
      ],
    },
    {
      id: 'visibility',
      tab: 'accessibility',
      title: 'Visibility',
      rows: [
        row(
          'bright',
          'bright enemies colorblind visibility',
          <ToggleRow
            label='Bright enemies'
            hint='Opponents glow a color you pick, for visibility or colorblindness.'
            value={settings.enemyBright}
            def={D.enemyBright}
            onChange={(v) => set({ enemyBright: v })}
          />,
        ),
        ...(settings.enemyBright
          ? [row('enemyc', 'enemy color', <ColorRow label='Enemy color' value={settings.enemyColor} def={D.enemyColor} onChange={(v) => set({ enemyColor: v })} />)]
          : []),
      ],
    },

    /* ── Profile ── */
    {
      id: 'player',
      tab: 'profile',
      title: 'Player',
      rows: [
        row(
          'name',
          'player name profile username guest',
          <TextRow
            label='Player name'
            value={isGuestName ? 'Guest' : settings.playerName}
            readOnly
            hint={
              isGuestName
                ? 'Guests appear as Guest 1, 2, 3… in matches. Log in or create an account to set a name.'
                : 'Your account username, shown to other players. Set when you register.'
            }
            onChange={() => {}}
          />,
        ),
        // Custom server URL is dev/LAN-only — hidden in production, where the
        // client always uses the same-origin server (see serverUrl).
        ...(import.meta.env.DEV
          ? [
              row(
                'server',
                'server url lan',
                <TextRow
                  label='Server URL'
                  hint='Blank uses this server. LAN / dev only.'
                  value={settings.serverUrl}
                  placeholder='wss://your-server.example/ws/instagib'
                  onChange={(v) => set({ serverUrl: v.trim() })}
                />,
              ),
            ]
          : []),
      ],
    },
    {
      id: 'backup',
      tab: 'profile',
      title: 'Backup',
      rows: [row('backup', 'backup transfer import export share code settings', <SettingsShare settings={settings} onImport={onChange} />)],
    },
  ];

  const tabDirty = (t: SettingsTab) =>
    TAB_KEYS[t].some((k) => JSON.stringify(settings[k]) !== JSON.stringify(DEFAULT_SETTINGS[k]));

  // Search filters rows across every tab; grouped results replace the tab view.
  const visible: CardSpec[] = [];
  const counts: Record<SettingsTab, number> = { controls: 0, crosshair: 0, video: 0, audio: 0, accessibility: 0, profile: 0 };
  let total = 0;
  for (const c of cards) {
    const tabMeta = TABS.find((t) => t.id === c.tab)!;
    const rows = q ? c.rows.filter((r) => matches(q, c.title, tabMeta.label, r.text)) : c.rows;
    if (q) {
      counts[c.tab] += rows.length;
      total += rows.length;
    }
    if (rows.length && (q || c.tab === tab)) visible.push({ ...c, rows });
  }

  const activeMeta = TABS.find((t) => t.id === tab)!;

  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab, q]);
  // Narrow layout: keep the active tab visible in the scrolling top strip.
  useEffect(() => {
    document.getElementById(`st-tab-${tab}`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [tab]);

  const pick = (id: SettingsTab) => {
    setSearch('');
    setTab(id);
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const n = TABS.length;
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    pick(TABS[next].id);
    document.getElementById(`st-tab-${TABS[next].id}`)?.focus();
  };

  return (
    <ModalShell
      title='Settings'
      onClose={onClose}
      width='w-[1080px]'
      padded={false}
      className='st-shell'
      panelClassName='st-panel'
      bodyClassName='st-body'
      actions={
        <TextButton onClick={() => setFeedbackOpen(true)} className='text-cyan-300/70 hover:text-cyan-200'>
          Feedback
        </TextButton>
      }
      footer={({ close }) => (
        <>
          <TextButton onClick={() => onChange(DEFAULT_SETTINGS)}>Reset to defaults</TextButton>
          <DeckButton
            onClick={() => {
              if (settings !== openedWith.current) toast('Settings saved', { tone: 'ok', sound: 'none' });
              close();
            }}
            solid
            accent='emerald'
            size='sm'
            center
          >
            Done
          </DeckButton>
        </>
      )}
    >
      {feedbackOpen && (
        <FeedbackModal onClose={() => setFeedbackOpen(false)} playerName={isGuestName ? undefined : settings.playerName} />
      )}
      <div className='st-rail'>
        <div className='st-search'>
          <IconSearch />
          <input
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.preventDefault();
                setSearch('');
              }
            }}
            placeholder='Search settings'
            aria-label='Search settings'
            autoComplete='off'
            spellCheck={false}
          />
          {search && (
            <button type='button' className='st-search-clear' onClick={() => setSearch('')} aria-label='Clear search'>
              <IconClear />
            </button>
          )}
        </div>
        <div role='tablist' aria-label='Settings sections' aria-orientation='vertical' className='st-tabs' onKeyDown={onTabKey}>
          {TABS.map((t) => {
            const active = !q && tab === t.id;
            const dirty = tabDirty(t.id);
            return (
              <DeckTab
                key={t.id}
                active={active}
                onClick={() => pick(t.id)}
                data-tab={t.id}
                className={`st-tab ${q && counts[t.id] === 0 ? 'is-empty' : ''}`}
                tabIndex={tab === t.id ? 0 : -1}
                id={`st-tab-${t.id}`}
                data-autofocus={tab === t.id ? '' : undefined}
                aria-controls='st-panel'
              >
                <span className='st-tab-icon'>{t.icon}</span>
                <span className='st-tab-label'>{t.label}</span>
                {q ? (
                  counts[t.id] > 0 && <span className='st-tab-count'>{counts[t.id]}</span>
                ) : (
                  dirty && <span className='st-dot' role='img' aria-label='has changes' />
                )}
              </DeckTab>
            );
          })}
        </div>
      </div>

      <div className='st-pane' ref={paneRef} id='st-panel' role='tabpanel' aria-labelledby={q ? undefined : `st-tab-${tab}`} aria-label={q ? 'Search results' : undefined}>
        <header className='st-pane-head'>
          <h3>{q ? 'Search results' : activeMeta.label}</h3>
          <p>{q ? `${total} ${total === 1 ? 'setting matches' : 'settings match'} “${search.trim()}”` : activeMeta.blurb}</p>
        </header>
        {q && total === 0 ? (
          <div className='st-empty'>
            <p>No settings match “{search.trim()}”.</p>
            <button type='button' className='st-empty-btn' onClick={() => setSearch('')}>
              Clear search
            </button>
          </div>
        ) : (
          visible.map((c) =>
            c.bare ? (
              <div key={c.id} className='st-sticky'>
                {c.rows.map((r) => (
                  <div key={r.id}>{r.node}</div>
                ))}
              </div>
            ) : (
              <SettingsCard key={c.id} title={c.title} note={c.note} tag={q ? TABS.find((t) => t.id === c.tab)!.label : undefined}>
                {c.rows.map((r) => (
                  <div key={r.id} className='st-item'>
                    {r.node}
                  </div>
                ))}
              </SettingsCard>
            )
          )
        )}
      </div>
    </ModalShell>
  );
}
