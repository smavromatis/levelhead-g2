/**
 * Phone-side screen. One strip under the preview always says what is
 * happening and offers the one thing to do next; everything else is options.
 */
import {
  CalibrationError,
  MIN_POSE_ANGLE,
  angleBetween,
  mean,
  sameAxis,
  solveCalibration,
  type MotionEngine,
  type Vec3,
} from './motion'
import { CUE_Y, SCREEN_H, SCREEN_W, cueX, drawCue, type View } from './render'
import type { Settings } from './settings'

export interface Status {
  tone: 'on' | 'warn' | 'off'
  text: string
  detail?: string
}

export interface UIHost {
  settings: Settings
  engine: MotionEngine
  getView(): View
  /** Apply a settings change made on the phone. */
  change(patch: Partial<Settings>): void
  recenter(): boolean
  /** Mirror calibration prompts onto the glasses; null when finished. */
  calibrationPrompt(step: number | null, text?: string): void
  status(): Status
  /** False when there are no glasses to read from. */
  canCalibrate(): boolean
  isDemo(): boolean
  diagnostics(): { link: string; battery: string; gps: string; gpsNote: string }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const STRENGTH = ['Gentle', 'Medium', 'Strong']
const MODE_HELP = {
  ship: 'For boats and ferries. A line that stays level with the horizon.',
  car: 'For cars, buses and trains. Dots that move with each turn and brake.',
}

const POSES = [
  { prompt: 'Look straight ahead', note: 'Sit the way you will ride, head level, and hold still.' },
  { prompt: 'Tilt your head toward your right shoulder', note: 'About halfway down, then hold it there.' },
  { prompt: 'Lower your chin toward your chest', note: 'Head straight, not tilted, then hold it there.' },
]

/** How long a pose must be held, and how still, to be captured. */
const HOLD_MS = 1200
const STILL_DEGREES = 4
const READ_PROMPT_MS = 800
const NO_DATA_MS = 2500
const GIVE_UP_MS = 30000

const CANCELLED = Symbol('cancelled')

export class UI {
  private readonly host: UIHost
  private abort: (() => void) | null = null
  /** While calibrating: step index and how far the head is from level. */
  private pose: { step: number; angle: number } | null = null

  constructor(host: UIHost) {
    this.host = host
    this.bindSettings()
    $('now-primary').addEventListener('click', () => {
      if (this.host.settings.calib) this.recenter()
      else void this.calibrate()
    })
    $('now-secondary').addEventListener('click', () => {
      window.scrollTo({ top: 0 })
      void this.calibrate()
    })
    $('calib-cancel').addEventListener('click', () => (this.abort ? this.abort() : this.showIdle()))
    $('calib-retry').addEventListener('click', () => void this.calibrate())
    const info = $<HTMLDialogElement>('info')
    $('info-open').addEventListener('click', () => {
      info.showModal()
      info.scrollTop = 0
    })
    $('info-close').addEventListener('click', () => info.close())
    this.sync()
    this.startPreview()
    setInterval(() => this.refresh(), 500)
  }

  /** Reflect current settings in every control. */
  sync(): void {
    const s = this.host.settings
    for (const group of document.querySelectorAll<HTMLElement>('[data-setting]')) {
      const current = String(s[group.dataset.setting as 'mode' | 'intensity' | 'layout'])
      for (const b of group.querySelectorAll('button')) {
        b.setAttribute('aria-checked', String(b.dataset.value === current))
      }
    }
    for (const box of document.querySelectorAll<HTMLInputElement>('[data-toggle]')) {
      box.checked = s[box.dataset.toggle as 'demo']
    }
    for (const row of document.querySelectorAll<HTMLElement>('[data-for-mode]')) {
      row.hidden = row.dataset.forMode !== s.mode
    }
    $('strength-name').textContent = STRENGTH[s.intensity]
    $('mode-help').textContent = MODE_HELP[s.mode]
    $<HTMLButtonElement>('weaker').disabled = s.intensity === 0
    $<HTMLButtonElement>('stronger').disabled = s.intensity === 2
    this.refresh()
  }

  // ------------------------------------------------------------------ setup

  private bindSettings(): void {
    for (const group of document.querySelectorAll<HTMLElement>('[data-setting]')) {
      group.addEventListener('click', (e) => {
        const button = (e.target as HTMLElement).closest('button')
        if (!button) return
        const key = group.dataset.setting!
        const raw = button.dataset.value!
        this.host.change({ [key]: key === 'intensity' ? Number(raw) : raw } as Partial<Settings>)
      })
    }
    const step = (by: number) => () => {
      const next = Math.min(2, Math.max(0, this.host.settings.intensity + by))
      this.host.change({ intensity: next as Settings['intensity'] })
    }
    $('weaker').addEventListener('click', step(-1))
    $('stronger').addEventListener('click', step(1))
    for (const box of document.querySelectorAll<HTMLInputElement>('[data-toggle]')) {
      box.addEventListener('change', () =>
        this.host.change({ [box.dataset.toggle!]: box.checked } as Partial<Settings>),
      )
    }
  }

  /** Status strip and readouts; cheap enough to run twice a second. */
  private refresh(): void {
    const { engine, settings } = this.host
    const status = this.host.status()
    $('now').dataset.tone = status.tone
    $('now-text').textContent = status.text
    $('now-detail').textContent = status.detail ?? ''

    const primary = $<HTMLButtonElement>('now-primary')
    const secondary = $<HTMLButtonElement>('now-secondary')
    primary.textContent = settings.calib ? 'Re-level' : 'Set Up'
    primary.disabled = !this.host.canCalibrate()
    secondary.disabled = !this.host.canCalibrate()

    const live = engine.isLive(performance.now())
    const n = (v: number, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d)
    $('d-rate').textContent = live ? `${engine.rateHz.toFixed(1)} per second` : 'None'
    $('d-raw').textContent = live && engine.raw ? engine.raw.map((v) => n(v)).join('  ') : '–'
    const s = this.host.getView().state
    $('d-angles').textContent = `${n(s.roll, 1)}°  ${n(s.pitch, 1)}°`
    $('d-accel').textContent = `${n(s.turn)} g  ${n(s.surge)} g`
    const d = this.host.diagnostics()
    $('d-link').textContent = d.link
    $('d-battery').textContent = d.battery
    $('d-gps').textContent = d.gps
    $('gps-note').textContent = d.gpsNote
  }

  private recenter(): void {
    if (!this.host.recenter()) {
      $('now-detail').textContent = 'Could not re-level: the glasses are not sending motion.'
    }
  }

  // ---------------------------------------------------------------- preview

  private startPreview(): void {
    const canvas = $<HTMLCanvasElement>('preview')
    const ctx = canvas.getContext('2d')!
    const tick = () => {
      const view = this.host.getView()
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
      if (this.pose) {
        this.drawPoseGauge(ctx)
      } else {
        ctx.save()
        ctx.translate(cueX(view.layout), CUE_Y)
        drawCue(ctx, view)
        ctx.restore()
      }
      $('preview-tag').textContent = this.pose
        ? ''
        : view.active
          ? this.host.isDemo()
            ? 'Pretend motion'
            : 'Live from your glasses'
          : 'Glasses are showing nothing'
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  /** During calibration the preview shows how far the head has moved. */
  private drawPoseGauge(ctx: CanvasRenderingContext2D): void {
    const { step, angle } = this.pose!
    const cx = SCREEN_W / 2
    const cy = SCREEN_H / 2
    ctx.save()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.font = '600 22px system-ui, sans-serif'
    if (step === 0) {
      ctx.fillText('Hold level', cx, cy + 8)
    } else {
      const width = 320
      const full = 25
      const x0 = cx - width / 2
      ctx.fillText(`${angle.toFixed(0)}°`, cx, cy - 10)
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.fillRect(x0, cy + 14, width, 6)
      ctx.fillStyle = '#fff'
      ctx.fillRect(x0, cy + 14, (Math.min(angle, full) / full) * width, 6)
      // Target mark: far enough.
      ctx.fillRect(x0 + (MIN_POSE_ANGLE / full) * width - 1, cy + 6, 2, 22)
      ctx.font = '14px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillText(
        angle >= MIN_POSE_ANGLE ? 'Far enough. Hold still.' : 'Keep going to the mark',
        cx,
        cy + 52,
      )
    }
    ctx.restore()
  }

  // ------------------------------------------------------------ calibration

  private showIdle(): void {
    this.pose = null
    this.abort = null
    $('now-calibrating').hidden = true
    $('now-idle').hidden = false
    this.host.calibrationPrompt(null)
    this.refresh()
  }

  /**
   * Hands-free: each pose is captured on its own once it has been held still,
   * so there is nothing to tap while your head is tilted.
   */
  private async calibrate(): Promise<void> {
    $('now-idle').hidden = true
    $('now-calibrating').hidden = false
    $('calib-retry').hidden = true
    const poses: Vec3[] = []
    try {
      for (let step = 0; step < POSES.length; step++) {
        this.showPose(step)
        poses.push(await this.holdPose(step, poses))
        navigator.vibrate?.(60)
      }
      this.host.change({ calib: solveCalibration(poses[0], poses[1], poses[2]) })
      this.showIdle()
    } catch (e) {
      if (e === CANCELLED) return this.showIdle()
      this.pose = null
      this.abort = null
      this.host.calibrationPrompt(null)
      const note = $('calib-note')
      note.textContent = e instanceof CalibrationError ? e.message : 'Something went wrong.'
      note.setAttribute('data-error', '')
      $('calib-prompt').textContent = 'Set-up stopped'
      $('calib-retry').hidden = false
      this.setBar(0)
    }
  }

  private showPose(step: number): void {
    const steps = $('calib-steps').children
    for (let k = 0; k < steps.length; k++) {
      ;(steps[k] as HTMLElement).dataset.state = k < step ? 'done' : k === step ? 'current' : ''
    }
    $('calib-prompt').textContent = POSES[step].prompt
    const note = $('calib-note')
    note.textContent = `${POSES[step].note} It captures by itself.`
    note.removeAttribute('data-error')
    this.setBar(0)
    this.pose = { step, angle: 0 }
    this.host.calibrationPrompt(step, POSES[step].prompt)
  }

  private setBar(fraction: number): void {
    $('calib-bar').style.width = `${Math.min(1, Math.max(0, fraction)) * 100}%`
  }

  /** Resolve with the averaged reading once the right pose is held still. */
  private holdPose(step: number, poses: Vec3[]): Promise<Vec3> {
    return new Promise((resolve, reject) => {
      const started = performance.now()
      let held: Array<{ v: Vec3; t: number }> = []
      let seen = false

      const inPose = (v: Vec3) => {
        if (step === 0) return true
        if (angleBetween(poses[0], v) < MIN_POSE_ANGLE) return false
        // The nod has to be a different movement from the tilt just captured.
        return step === 1 || sameAxis(poses[0], poses[1], v) < 0.6
      }

      const stop = () => {
        off()
        clearInterval(watchdog)
      }
      const off = this.host.engine.onSample((v, t) => {
        seen = true
        if (this.pose) this.pose.angle = step === 0 ? 0 : angleBetween(poses[0], v)
        if (t - started < READ_PROMPT_MS) return
        const moved = held.length > 0 && angleBetween(v, mean(held.map((h) => h.v))) > STILL_DEGREES
        if (moved || !inPose(v)) held = []
        else held.push({ v, t })
        const span = held.length ? t - held[0].t : 0
        this.setBar(span / HOLD_MS)
        if (span >= HOLD_MS && held.length >= 4) {
          stop()
          resolve(mean(held.map((h) => h.v)))
        }
      })
      const watchdog = setInterval(() => {
        const waited = performance.now() - started
        if (!seen && waited > NO_DATA_MS) {
          stop()
          reject(new CalibrationError('The glasses are not sending motion. Check they are connected and on your face.'))
        } else if (waited > GIVE_UP_MS) {
          stop()
          reject(new CalibrationError('Could not get a steady reading. Set-up needs calm: try before you set off, or in still water.'))
        }
      }, 250)
      this.abort = () => {
        stop()
        reject(CANCELLED)
      }
    })
  }
}
