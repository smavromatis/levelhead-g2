import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { isCalibration, type Calibration, type Mode } from './motion'
import type { Intensity } from './render'

export interface Settings {
  mode: Mode
  intensity: Intensity
  /** Drive the cue from synthetic motion instead of the glasses' sensor. */
  demo: boolean
  calib: Calibration | null
}

export const DEFAULTS: Settings = {
  mode: 'ship',
  intensity: 1,
  demo: false,
  calib: null,
}

const KEY = 'levelhead.settings.v4'

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

function parse(json: string): Settings {
  try {
    const o = JSON.parse(json) as Partial<Settings>
    return {
      mode: pick(o.mode, ['ship', 'car'] as const, DEFAULTS.mode),
      intensity: pick(o.intensity, [0, 1, 2] as const, DEFAULTS.intensity),
      demo: o.demo === true,
      calib: isCalibration(o.calib) ? o.calib : null,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Stored in the Even app, whose WebView localStorage is not reliable. Falls back to localStorage in a browser. */
export class SettingsStore {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Settings | null = null
  private readonly bridge: EvenAppBridge | null

  constructor(bridge: EvenAppBridge | null) {
    this.bridge = bridge
  }

  async load(): Promise<Settings> {
    try {
      const raw = this.bridge ? await this.bridge.getLocalStorage(KEY) : localStorage.getItem(KEY)
      return raw ? parse(raw) : { ...DEFAULTS }
    } catch {
      return { ...DEFAULTS }
    }
  }

  /** Debounced: storage shares the link the display frames travel on. */
  save(s: Settings): void {
    this.pending = { ...s }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 600)
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    const s = this.pending
    if (!s) return
    this.pending = null
    const raw = JSON.stringify(s)
    try {
      if (this.bridge) await this.bridge.setLocalStorage(KEY, raw)
      else localStorage.setItem(KEY, raw)
    } catch (e) {
      console.warn('[levelhead] could not save settings', e)
    }
  }
}
