import { waitForEvenAppBridge, type DeviceStatus, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import './style.css'
import { GlassesLink, type GlassesAction } from './glasses'
import { MotionEngine, demoState, type Mode } from './motion'
import type { Intensity, View } from './render'
import { DEFAULTS, SettingsStore, type Settings } from './settings'
import { UI, type Status } from './ui'

const HINT: Record<Mode, string> = {
  ship: 'tap  mode      hold  re-level',
  car: 'tap  mode      hold  re-level      swipe  strength',
}
const MODE_LABEL: Record<Mode, string> = {
  ship: 'Ship mode',
  car: 'Car mode',
}

/** How long to wait for the Even app before running as a browser preview. */
const BRIDGE_WAIT_MS = 2500

const engine = new MotionEngine()
let settings: Settings = { ...DEFAULTS }
let store = new SettingsStore(null)
let link: GlassesLink | null = null
let device: DeviceStatus | null = null
let calibrating = false

/**
 * Demo motion is forced when there are no glasses to read from at all, or
 * with `?demo` in the URL (handy in the simulator, which has no IMU).
 */
const forceDemo = new URLSearchParams(location.search).has('demo')
const demoOn = () => settings.demo || forceDemo || !link

const sensing = () =>
  engine.calib !== null && engine.isLive(performance.now()) && device?.isWearing !== false

function getView(aheadS = 0): View {
  const demo = demoOn()
  return {
    mode: settings.mode,
    layout: settings.layout,
    intensity: settings.intensity,
    state: demo
      ? demoState(settings.mode, performance.now() / 1000 + aheadS)
      : // Count from the newest reading, however long ago it arrived.
        engine.stateAt(aheadS + Math.min(performance.now() - engine.lastSampleAt, 300) / 1000),
    // A frozen or guessed horizon would be a false reference, so the cue is
    // only drawn from fresh data, and never while the glasses are off.
    active: !calibrating && (demo || sensing()),
  }
}

/** Put the right message on the glasses for the current situation. */
function announce(label = MODE_LABEL[settings.mode], hint = HINT[settings.mode]): void {
  if (!link) return
  if (!demoOn() && !engine.calib) {
    link.showChrome('Set up in the Levelhead phone app', ' ', true)
  } else {
    link.showChrome(label, hint)
  }
}

/** What is happening, in one sentence, with what to do about it. */
function status(): Status {
  if (!link) {
    return {
      tone: 'off',
      text: 'Preview only',
      detail: 'Open Levelhead in the Even app with your glasses connected to use it for real.',
    }
  }
  if (settings.demo || forceDemo) {
    return { tone: 'warn', text: 'Showing pretend motion', detail: 'Switch it off under More to use real motion.' }
  }
  if (device && !device.isConnected()) {
    return { tone: 'warn', text: 'Glasses are not connected', detail: 'Reconnect them in the Even app.' }
  }
  if (!engine.calib) {
    return {
      tone: 'warn',
      text: 'Set up to start',
      detail: 'Put the glasses on and sit still. Takes about ten seconds. Do it before you set off: it is remembered.',
    }
  }
  if (device?.isWearing === false) {
    return { tone: 'off', text: 'Paused while the glasses are off', detail: 'It starts again when you put them on.' }
  }
  if (!engine.isLive(performance.now())) {
    return { tone: 'warn', text: 'Waiting for the glasses', detail: 'They are not sending motion yet, so they show nothing.' }
  }
  return {
    tone: 'on',
    text: `${MODE_LABEL[settings.mode]} is on`,
    detail: 'Picture sitting crooked? Keep your head straight for a few seconds, then tap Re-level.',
  }
}

/** The phone's location is used in the car, where it tells car from head. */
function syncLocation(): void {
  const want = settings.mode === 'car'
  if (!want) engine.clearGps()
  void link?.setLocation(want)
}

function change(patch: Partial<Settings>): void {
  const before = settings
  settings = { ...settings, ...patch }
  if (settings.mode !== before.mode) engine.setMode(settings.mode)
  if (settings.calib !== before.calib) engine.setCalibration(settings.calib)
  if (settings.layout !== before.layout) void link?.setLayout(settings.layout)
  syncLocation()
  store.save(settings)
  link?.invalidate()
  ui.sync()

  if (settings.intensity !== before.intensity) {
    const dots = [0, 1, 2].map((i) => (i <= settings.intensity ? '●' : '○')).join(' ')
    announce(`Strength   ${dots}`, ' ')
  } else if (!calibrating) {
    announce()
  }
}

function recenter(): boolean {
  if (demoOn()) return false
  const ok = engine.recenter()
  if (ok) {
    settings = { ...settings, calib: engine.calib }
    store.save(settings)
    announce('Level reset', ' ')
  }
  return ok
}

function onAction(action: GlassesAction): void {
  switch (action) {
    case 'toggleMode':
      return change({ mode: settings.mode === 'ship' ? 'car' : 'ship' })
    case 'intensityUp':
    case 'intensityDown': {
      // The ship line is always true to the horizon; only the dots scale.
      if (settings.mode === 'ship') return announce('Strength is for Car mode', ' ')
      const step = action === 'intensityUp' ? 1 : -1
      return change({ intensity: Math.min(2, Math.max(0, settings.intensity + step)) as Intensity })
    }
    case 'recenter':
      if (!recenter()) announce(demoOn() ? 'Pretend motion is on' : 'Set up on your phone first', ' ')
  }
}

const ui = new UI({
  get settings() {
    return settings
  },
  engine,
  getView,
  change,
  recenter,
  calibrationPrompt(step, text) {
    calibrating = step !== null
    link?.invalidate()
    if (step === null) announce()
    else link?.showChrome(`Set up   ${step + 1} of 3`, text, true)
  },
  isDemo: demoOn,
  status,
  canCalibrate: () => link !== null && !settings.demo && !forceDemo,
  diagnostics() {
    const stats = link?.stats
    const now = performance.now()
    const gpsLive = engine.gpsLive(now)
    return {
      link: stats
        ? `${stats.fps.toFixed(1)} per second, drawn ${(stats.leadMs / 1000).toFixed(2)} s ahead${stats.failures ? `, ${stats.failures} failed` : ''}`
        : 'No glasses',
      battery: device?.batteryLevel != null ? `${device.batteryLevel}%` : '–',
      gps: gpsLive ? `${(engine.gps!.speed * 3.6).toFixed(0)} km/h` : 'None',
      gpsNote: gpsLive
        ? ''
        : 'Finding your location. Until then, moving your head also moves the dots.',
    }
  },
})

function applyLoaded(loaded: Settings): void {
  settings = loaded
  engine.setMode(settings.mode)
  engine.setCalibration(settings.calib)
  ui.sync()
}

async function attach(bridge: EvenAppBridge): Promise<void> {
  store = new SettingsStore(bridge)
  applyLoaded(await store.load())

  const glasses = new GlassesLink(bridge, {
    getView,
    onImu: (v, t) => engine.push(v, t),
    onGps: (fix, t) => engine.pushGps(fix, t),
    onAction,
    onDevice(next) {
      device = next
    },
  })
  if (!(await glasses.start(settings.layout))) return
  link = glasses
  device = (await bridge.getDeviceInfo().catch(() => null))?.status ?? null
  syncLocation()
  announce()

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void store.flush()
  })
}

// Start as a browser preview straight away; become the real thing as soon as
// the Even app's bridge answers, however late that is.
applyLoaded(await store.load())
const bridgeReady = waitForEvenAppBridge()
const early = await Promise.race([
  bridgeReady,
  new Promise<null>((r) => setTimeout(() => r(null), BRIDGE_WAIT_MS)),
]).catch(() => null)
if (early) await attach(early)
else bridgeReady.then(attach).catch((e) => console.warn('[levelhead] no bridge', e))
