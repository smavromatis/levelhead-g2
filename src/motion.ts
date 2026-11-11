/**
 * Turns the glasses' accelerometer (and, in a car, the phone's GPS) into the
 * signals the two modes draw. Runs entirely on the device.
 *
 * The SDK does not document the IMU's axes, sign or units. A three-pose
 * set-up (level, tilt right, chin down) measures the axes, and every output
 * is a ratio of accelerometer components, so none of that matters.
 *
 * An accelerometer cannot tell a tilt from an acceleration: right ear down
 * reads like accelerating left, chin down reads like braking. That fixes the
 * sign of the car signals, and is also why car mode needs GPS.
 */

import { Predictor } from './predict.ts'

export type Vec3 = [number, number, number]
export type Mode = 'ship' | 'car'

export interface Calibration {
  /** Accelerometer direction when the head is level (unit vector). */
  up: Vec3
  /** Direction the reading moves toward when the right ear tips down. */
  right: Vec3
  /** Direction the reading moves toward when the nose tips down. */
  fwd: Vec3
  /** When it was captured (Unix ms). */
  at: number
}

export interface MotionState {
  /** Head roll in degrees, + = right ear down. Absolute against gravity. */
  roll: number
  /** Head pitch in degrees, + = nose down. Slow posture drift removed. */
  pitch: number
  /** Lateral acceleration in g, + = vehicle accelerating right (right turn). */
  turn: number
  /** Longitudinal acceleration in g, + = speeding up, - = braking. */
  surge: number
}

export interface GpsFix {
  /** Metres per second. */
  speed: number
  /** Degrees clockwise from north. */
  heading: number
}

const ZERO: MotionState = { roll: 0, pitch: 0, turn: 0, surge: 0 }
const G = 9.81

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: Vec3): Vec3 => {
  const l = len(a)
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0]
}
/** Component of `a` perpendicular to unit vector `n`. */
const reject = (a: Vec3, n: Vec3): Vec3 => sub(a, scale(n, dot(a, n)))
const deg = (rad: number) => (rad * 180) / Math.PI
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const smooth = (lo: number, hi: number, x: number) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1)
  return t * t * (3 - 2 * t)
}
/** Low-pass coefficient for a time step and time constant. */
const lp = (dt: number, tau: number) => 1 - Math.exp(-dt / tau)

export const angleBetween = (a: Vec3, b: Vec3) => deg(Math.acos(clamp(dot(norm(a), norm(b)), -1, 1)))
export const mean = (vs: Vec3[]): Vec3 =>
  scale(
    vs.reduce<Vec3>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]),
    1 / Math.max(vs.length, 1),
  )
/** How much two poses, both measured from level, lean along the same axis (0-1). */
export const sameAxis = (level: Vec3, a: Vec3, b: Vec3) => {
  const up = norm(level)
  return Math.abs(dot(norm(reject(a, up)), norm(reject(b, up))))
}

/** Response time of the smoothing filter on the car signals (seconds). */
const SMOOTH_TAU = 0.25
const RATE_TAU = 0.25
/** Cap on how far look-ahead may move a car signal, so a jolt cannot fling it (g). */
const MAX_CAR_LEAD = 0.12
/** A head tilt jumps several degrees in one sample; a swell does not. */
const ANGLE_PREDICTION = { joltFloor: 2.5, maxRate: 25 }

/** How slowly the resting posture is re-learned (seconds). */
const PITCH_BASE_TAU = 30
const CAR_BASE_TAU = 25

/** GPS supplies the slow part of the car signals; the accelerometer only the first seconds of a change. */
const GPS_BLEND_TAU = 2
const GPS_STALE_MS = 3000
/** Largest swing the head sensor may add on top of what GPS reports (g). */
const HEAD_ALLOWANCE = 0.2
/** Below walking pace a car cannot be cornering, whatever the head does. */
const TURN_SPEED_GATE: [number, number] = [0.5, 3]
/** GPS heading is noise until the car is properly moving (m/s). */
const MIN_HEADING_SPEED = 2

/** Working out which way the head faces: response time, and the smallest push (g) worth reading. */
const FACING_TAU = 1.5
const FACING_FORGET_TAU = 20
const FACING_MIN_G = 0.06

/** Re-level averages this much history, so a boat's roll cancels out. */
const RELEVEL_WINDOW_MS = 8000
/** A gap this long in the sensor stream makes older samples useless for look-ahead. */
const GAP_RESET_S = 0.5

/** Smallest head movement (degrees) accepted for a calibration pose. */
export const MIN_POSE_ANGLE = 10

export class CalibrationError extends Error {}

export class MotionEngine {
  calib: Calibration | null = null
  mode: Mode = 'ship'
  state: MotionState = { ...ZERO }

  /** Last raw sample and measured sample rate, for the diagnostics panel. */
  raw: Vec3 | null = null
  rateHz = 0
  lastSampleAt = 0
  /** Latest GPS-derived car motion, if any. */
  gps: { turn: number; surge: number; speed: number; at: number } | null = null

  private g: Vec3 | null = null
  private lastT = 0
  private base = { pitch: 0, turn: 0, surge: 0 }
  private blend = { gTurn: 0, gSurge: 0, aTurn: 0, aSurge: 0 }
  /** Direction the head faces relative to the car, as a unit vector. */
  private facing = { cos: 1, sin: 0 }
  private recent: Array<{ v: Vec3; t: number }> = []
  private rollAhead = new Predictor(ANGLE_PREDICTION)
  private pitchAhead = new Predictor(ANGLE_PREDICTION)
  private car = { turn: 0, surge: 0, turnRate: 0, surgeRate: 0, primed: false }
  private samplePeriod = 0.1
  private lastFix: (GpsFix & { at: number }) | null = null
  private listeners = new Set<(v: Vec3, tMs: number) => void>()

  /** Subscribe to raw samples (used by calibration). Returns unsubscribe. */
  onSample(fn: (v: Vec3, tMs: number) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Feed one accelerometer sample. `tMs` is a monotonic timestamp. */
  push(v: Vec3, tMs: number): void {
    if (!v.every(Number.isFinite) || len(v) < 1e-6) return

    const dt = this.lastT ? clamp((tMs - this.lastT) / 1000, 0.005, 1) : 0.1
    if (this.lastT) this.rateHz += (1 / dt - this.rateHz) * 0.1
    this.lastT = tMs
    this.lastSampleAt = tMs
    this.raw = v
    this.recent.push({ v, t: tMs })
    while (tMs - this.recent[0].t > RELEVEL_WINDOW_MS) this.recent.shift()
    for (const fn of this.listeners) fn(v, tMs)

    const a = lp(dt, SMOOTH_TAU)
    this.g = this.g
      ? [
          this.g[0] + (v[0] - this.g[0]) * a,
          this.g[1] + (v[1] - this.g[1]) * a,
          this.g[2] + (v[2] - this.g[2]) * a,
        ]
      : v

    const c = this.calib
    if (!c) return
    if (dt >= GAP_RESET_S) {
      // Samples from before a drop-out are no basis for look-ahead.
      this.rollAhead.reset()
      this.pitchAhead.reset()
      this.car.primed = false
    } else {
      this.samplePeriod += (dt - this.samplePeriod) * 0.05
    }

    // Roll and pitch use the raw sample; the predictor does its own smoothing.
    const vu = dot(v, c.up)
    // More than ~75 degrees off level: the ratios stop being meaningful.
    if (vu < 0.25 * len(v)) return
    const pitchRaw = deg(Math.atan2(dot(v, c.fwd), vu))
    // Follow slow posture changes so the line stays on the display.
    this.base.pitch += (pitchRaw - this.base.pitch) * lp(dt, PITCH_BASE_TAU)
    this.rollAhead.push(deg(Math.atan2(dot(v, c.right), vu)))
    this.pitchAhead.push(pitchRaw - this.base.pitch)

    // Car signals are small next to head noise, so these are smoothed first.
    const u = dot(this.g, c.up)
    if (u < 0.25 * len(this.g)) return
    const turnRaw = clamp(-dot(this.g, c.right) / u, -1, 1)
    const surgeRaw = clamp(-dot(this.g, c.fwd) / u, -1, 1)
    this.base.turn += (turnRaw - this.base.turn) * lp(dt, CAR_BASE_TAU)
    this.base.surge += (surgeRaw - this.base.surge) * lp(dt, CAR_BASE_TAU)

    let turn = turnRaw - this.base.turn
    let surge = surgeRaw - this.base.surge
    if (this.gpsLive(tMs)) {
      const gps = this.gps!
      const k = lp(dt, GPS_BLEND_TAU)
      const b = this.blend
      b.gTurn += (gps.turn - b.gTurn) * k
      b.gSurge += (gps.surge - b.gSurge) * k
      b.aTurn += (turnRaw - b.aTurn) * k
      b.aSurge += (surgeRaw - b.aSurge) * k
      // GPS reports along the car's axes; the picture is drawn in the head's.
      // While the car manoeuvres, compare the two directions to find which
      // way the head is turned, and rotate the GPS figure to match.
      const f = this.facing
      const aT = b.aTurn - this.base.turn
      const aS = b.aSurge - this.base.surge
      const gSize = Math.hypot(b.gTurn, b.gSurge)
      const aSize = Math.hypot(aT, aS)
      if (gSize > FACING_MIN_G && aSize > FACING_MIN_G) {
        const kf = lp(dt, FACING_TAU)
        f.cos += ((b.gTurn * aT + b.gSurge * aS) / (gSize * aSize) - f.cos) * kf
        f.sin += ((b.gTurn * aS - b.gSurge * aT) / (gSize * aSize) - f.sin) * kf
      } else {
        // Nothing to go on: drift back to assuming the wearer faces forward.
        const kf = lp(dt, FACING_FORGET_TAU)
        f.cos += (1 - f.cos) * kf
        f.sin += (0 - f.sin) * kf
      }
      const fSize = Math.hypot(f.cos, f.sin)
      const [fc, fs] = fSize > 1e-3 ? [f.cos / fSize, f.sin / fSize] : [1, 0]

      const fast = (raw: number, slow: number) => clamp(raw - slow, -HEAD_ALLOWANCE, HEAD_ALLOWANCE)
      turn = b.gTurn * fc - b.gSurge * fs + fast(turnRaw, b.aTurn) * smooth(...TURN_SPEED_GATE, gps.speed)
      surge = b.gTurn * fs + b.gSurge * fc + fast(surgeRaw, b.aSurge)
    }
    const car = this.car
    if (car.primed) {
      const kr = lp(dt, RATE_TAU)
      car.turnRate += ((turn - car.turn) / dt - car.turnRate) * kr
      car.surgeRate += ((surge - car.surge) / dt - car.surgeRate) * kr
    }
    car.turn = turn
    car.surge = surge
    car.primed = true

    this.state = this.stateAt(0)
  }

  /**
   * The motion as it will be `aheadS` seconds after the newest sample. The
   * display asks for the moment each picture will actually be on screen.
   */
  stateAt(aheadS: number): MotionState {
    const car = this.car
    // The smoothing filter is itself about SMOOTH_TAU late.
    const carAhead = aheadS + SMOOTH_TAU
    const lead = (rate: number) => clamp(rate * carAhead, -MAX_CAR_LEAD, MAX_CAR_LEAD)
    return {
      roll: this.rollAhead.at(aheadS, this.samplePeriod),
      pitch: this.pitchAhead.at(aheadS, this.samplePeriod),
      turn: car.turn + lead(car.turnRate),
      surge: car.surge + lead(car.surgeRate),
    }
  }

  /** Feed one GPS fix from the phone. `tMs` is on the same clock as push(). */
  pushGps(fix: GpsFix, tMs: number): void {
    if (!Number.isFinite(fix.speed) || fix.speed < 0) return
    const last = this.lastFix
    this.lastFix = { ...fix, at: tMs }
    if (!last) return
    const dt = (tMs - last.at) / 1000
    if (dt < 0.3 || dt > 3) return

    const surge = clamp((fix.speed - last.speed) / dt / G, -0.6, 0.6)
    let turn = 0
    const moving = fix.speed > MIN_HEADING_SPEED && last.speed > MIN_HEADING_SPEED
    if (moving && Number.isFinite(fix.heading) && Number.isFinite(last.heading)) {
      // Shortest way round the compass, in radians per second.
      const swing = ((fix.heading - last.heading + 540) % 360) - 180
      turn = clamp((fix.speed * ((swing * Math.PI) / 180 / dt)) / G, -0.6, 0.6)
    }
    if (!this.gpsLive(tMs)) this.blend = { gTurn: turn, gSurge: surge, aTurn: 0, aSurge: 0 }
    this.gps = { turn, surge, speed: fix.speed, at: tMs }
  }

  /** Forget GPS, e.g. on leaving car mode. */
  clearGps(): void {
    this.gps = null
    this.lastFix = null
  }

  gpsLive(nowMs: number): boolean {
    return this.mode === 'car' && this.gps !== null && nowMs - this.gps.at < GPS_STALE_MS
  }

  setMode(mode: Mode): void {
    this.mode = mode
    this.reset()
  }

  setCalibration(c: Calibration | null): void {
    this.calib = c
    this.reset()
  }

  private reset(): void {
    this.base = { pitch: 0, turn: 0, surge: 0 }
    this.rollAhead.reset()
    this.pitchAhead.reset()
    this.car = { turn: 0, surge: 0, turnRate: 0, surgeRate: 0, primed: false }
    this.state = { ...ZERO }
  }

  /** True when samples are arriving. */
  isLive(nowMs: number): boolean {
    return this.lastSampleAt > 0 && nowMs - this.lastSampleAt < 1500
  }

  /** Reset level to the average recent pose, keeping the measured axes. */
  recenter(): boolean {
    if (!this.calib || this.recent.length < 5) return false
    const up = norm(mean(this.recent.map((r) => r.v)))
    const right = norm(reject(this.calib.right, up))
    const fwd = norm(reject(reject(this.calib.fwd, up), right))
    if (len(right) === 0 || len(fwd) === 0) return false
    this.setCalibration({ up, right, fwd, at: Date.now() })
    return true
  }
}

/** Build a calibration from the three captured poses, validating each. */
export function solveCalibration(level: Vec3, tiltRight: Vec3, chinDown: Vec3): Calibration {
  const up = norm(level)
  if (angleBetween(level, tiltRight) < MIN_POSE_ANGLE - 2) {
    throw new CalibrationError('The tilt was too small to read. Tip your head further toward your right shoulder.')
  }
  if (angleBetween(level, chinDown) < MIN_POSE_ANGLE - 2) {
    throw new CalibrationError('The nod was too small to read. Lower your chin further.')
  }
  // The nod must move the reading on a clearly different axis from the tilt.
  if (sameAxis(level, tiltRight, chinDown) > 0.6) {
    throw new CalibrationError('The tilt and the nod looked alike. Make them two distinct movements.')
  }
  const right = norm(reject(tiltRight, up))
  const fwd = norm(reject(reject(chinDown, up), right))
  return { up, right, fwd, at: Date.now() }
}

export function isCalibration(c: unknown): c is Calibration {
  const ok = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))
  const o = c as Calibration | null
  return !!o && ok(o.up) && ok(o.right) && ok(o.fwd)
}

/**
 * Synthetic motion for the simulator and for trying the visuals on dry land:
 * a two-component swell for the ship, a looping drive for the car.
 */
export function demoState(mode: Mode, tSec: number): MotionState {
  if (mode === 'ship') {
    const w = (period: number, phase = 0) => Math.sin((2 * Math.PI * tSec) / period + phase)
    return {
      ...ZERO,
      roll: 8 * w(8) + 3 * w(3.1, 1.3),
      pitch: 3.5 * w(6, 0.8) + 1.2 * w(2.4),
    }
  }
  const t = tSec % 24
  // pull away, right bend, cruise, left bend, brake
  const bump = (start: number, end: number) => {
    if (t < start || t > end) return 0
    return Math.sin((Math.PI * (t - start)) / (end - start)) ** 2
  }
  return {
    ...ZERO,
    turn: 0.32 * bump(5, 10) - 0.36 * bump(13, 18),
    surge: 0.22 * bump(0, 4.5) - 0.3 * bump(19, 23.5),
  }
}
