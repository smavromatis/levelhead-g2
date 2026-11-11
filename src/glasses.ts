/**
 * The link to the glasses: page layout, frame loop, touch input, IMU stream
 * and lifecycle.
 *
 * Page (576 x 288): a full-screen empty text container that captures input,
 * a label and a hint line that show briefly, and one 288 x 144 image that
 * carries the cue.
 */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  AppLocationAccuracy,
  ImuReportPace,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { GpsFix, Vec3 } from './motion'
import {
  CUE_Y,
  SCREEN_H,
  SCREEN_W,
  TILE_H,
  TILE_W,
  CUE_X,
  drawCue,
  viewKey,
  type View,
} from './render'

export type GlassesAction = 'toggleMode' | 'recenter' | 'intensityUp' | 'intensityDown'

export interface GlassesHost {
  /** The view as it will be `aheadS` seconds from now. */
  getView(aheadS: number): View
  onImu(v: Vec3, tMs: number): void
  onGps(fix: GpsFix, tMs: number): void
  onAction(a: GlassesAction): void
  onDevice(status: DeviceStatus): void
}

export interface LinkStats {
  fps: number
  frameMs: number
  /** How far ahead the last picture was drawn for, in ms. */
  leadMs: number
  failures: number
}

/** How often to check for a changed picture when nothing is being sent. */
const IDLE_POLL_MS = 25
/** Estimated trip of a sensor reading from glasses to phone. Not measurable through the SDK. */
const SENSOR_TRIP_MS = 30
/** Look-ahead is only as good as the motion is regular; never reach too far. */
const MAX_LEAD_MS = 650
const CALL_TIMEOUT_MS = 4000
const CHROME_MS = 5000

/** Label and hint line up with the left edge of the centred cue. */
const TEXT_X = 144

const LABEL = { id: 2, name: 'label' }
const HINT = { id: 3, name: 'hint' }
const CUE = { id: 4, name: 'cue' }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class GlassesLink {
  stats: LinkStats = { fps: 0, frameMs: 0, leadMs: 0, failures: 0 }

  private readonly bridge: EvenAppBridge
  private readonly host: GlassesHost
  private queue: Promise<unknown> = Promise.resolve()
  private loopId = 0
  private lastKey = ''
  private lastFrameAt = 0
  /** Running averages: one send's round trip, and time between sends. */
  private sendMs = 150
  private periodMs = 160
  private chromeTimer: ReturnType<typeof setTimeout> | undefined
  private shown = { label: ' ', hint: ' ' }
  private unsubscribers: Array<() => void> = []
  private locating = false
  private readonly canvas = document.createElement('canvas')

  constructor(bridge: EvenAppBridge, host: GlassesHost) {
    this.bridge = bridge
    this.host = host
    this.canvas.width = TILE_W
    this.canvas.height = TILE_H
  }

  async start(): Promise<boolean> {
    const result = await this.call(() =>
      this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(this.page())),
    )
    if (result !== StartUpPageCreateResult.success) {
      // The startup call only works once per launch. If the WebView reloaded,
      // the page already exists and has to be rebuilt instead.
      const rebuilt = await this.call(() =>
        this.bridge.rebuildPageContainer(new RebuildPageContainer(this.page())),
      )
      if (!rebuilt) {
        console.error('[levelhead] startup page rejected:', result)
        return false
      }
    }
    this.unsubscribers.push(
      this.bridge.onEvenHubEvent((e) => this.onEvent(e)),
      this.bridge.onDeviceStatusChanged((s) => this.host.onDevice(s)),
      this.bridge.onAppLocationChanged((loc) => {
        if (loc.speed == null) return
        this.host.onGps({ speed: loc.speed, heading: loc.heading ?? NaN }, performance.now())
      }),
    )
    window.addEventListener('beforeunload', () => this.dispose())
    await this.resume()
    return true
  }

  /**
   * Turn the phone's GPS feed on or off. It is read on the phone itself and
   * needs no network, only the location permission.
   */
  async setLocation(on: boolean): Promise<void> {
    if (on === this.locating) return
    this.locating = on
    await this.applyLocation()
  }

  private async applyLocation(): Promise<void> {
    if (this.locating) {
      await this.bridge
        .startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 1000, distanceFilter: 0 })
        .catch((e) => console.warn('[levelhead] location unavailable', e))
    } else {
      await this.bridge.stopAppLocationUpdates().catch(() => {})
    }
  }

  /** Force the next frame to be sent even if the picture looks unchanged. */
  invalidate(): void {
    this.lastKey = ''
  }

  /**
   * Show a label (top) and hint (bottom). Unless `sticky`, both clear after a
   * few seconds so nothing but the cue stays in view.
   */
  showChrome(label: string, hint = ' ', sticky = false): void {
    clearTimeout(this.chromeTimer)
    void this.setText(LABEL, 'label', label)
    void this.setText(HINT, 'hint', hint)
    if (!sticky) {
      this.chromeTimer = setTimeout(() => {
        void this.setText(LABEL, 'label', ' ')
        void this.setText(HINT, 'hint', ' ')
      }, CHROME_MS)
    }
  }

  // ---------------------------------------------------------------- internals

  private page() {
    const text = (
      c: { id: number; name: string },
      y: number,
      height: number,
      z: number,
      brightness: number,
    ) =>
      new TextContainerProperty({
        xPosition: TEXT_X,
        yPosition: y,
        width: SCREEN_W - TEXT_X,
        height,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 4,
        containerID: c.id,
        containerName: c.name,
        content: ' ',
        isEventCapture: 0,
        zOrderIndex: z,
        textColor: brightness,
      })
    return {
      containerTotalNum: 4,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: SCREEN_W,
          height: SCREEN_H,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 1,
          containerName: 'capture',
          content: ' ',
          isEventCapture: 1,
          zOrderIndex: 1,
        }),
        text(LABEL, 16, 40, 2, 3),
        text(HINT, 232, 40, 3, 2),
      ],
      imageObject: [
        new ImageContainerProperty({
          xPosition: CUE_X,
          yPosition: CUE_Y,
          width: TILE_W,
          height: TILE_H,
          containerID: CUE.id,
          containerName: CUE.name,
          zOrderIndex: 4,
        }),
      ],
    }
  }

  /** Bridge calls share one BLE link and must not overlap. Each is queued, with a timeout. */
  private call<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('bridge call timed out')), CALL_TIMEOUT_MS)
          }),
        ])
      } catch (e) {
        this.stats.failures++
        console.warn('[levelhead]', e)
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }
    const next = this.queue.then(run, run)
    this.queue = next
    return next
  }

  private async setText(c: { id: number; name: string }, slot: 'label' | 'hint', content: string) {
    if (this.shown[slot] === content) return
    this.shown[slot] = content
    await this.call(() =>
      this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: c.id,
          containerName: c.name,
          contentOffset: 0,
          contentLength: 0,
          content,
        }),
      ),
    )
  }

  /**
   * Time the glasses' update paths, one after another, and report each. Used
   * to find out what this hardware can actually do before choosing how to
   * draw. Stops the normal display while it runs.
   */
  async speedTest(report: (line: string) => void): Promise<void> {
    this.loopId++
    clearTimeout(this.chromeTimer)
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const capture = new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H, borderWidth: 0, borderColor: 0,
      paddingLength: 0, containerID: 1, containerName: 'capture', content: ' ', isEventCapture: 1,
    })
    try {
      const cases: Array<[number, number, boolean]> = [
        [288, 144, false], [288, 144, true], [288, 72, true], [200, 64, true],
        [144, 48, true], [96, 32, true], [64, 32, true], [40, 20, true],
      ]
      for (const [w, h, plain] of cases) {
        const image = new ImageContainerProperty({
          xPosition: (SCREEN_W - w) / 2, yPosition: (SCREEN_H - h) / 2, width: w, height: h,
          containerID: 2, containerName: 'test',
        })
        await this.call(() =>
          this.bridge.rebuildPageContainer(
            new RebuildPageContainer({ containerTotalNum: 2, textObject: [capture], imageObject: [image] }),
          ),
        )
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        const times: number[] = []
        const encode: number[] = []
        let failed = 0
        for (let i = 0; i < 9; i++) {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, w, h)
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.moveTo(0, (h * (i + 1)) / 10)
          ctx.lineTo(w, h - (h * (i + 1)) / 10)
          ctx.stroke()
          if (plain) flatten(ctx, w, h)
          const e0 = performance.now()
          const png = await encodePng(canvas)
          encode.push(performance.now() - e0)
          const t0 = performance.now()
          const r = await this.call(() =>
            this.bridge.updateImageRawData(
              new ImageRawDataUpdate({ containerID: 2, containerName: 'test', imageData: png }),
            ),
          )
          if (r !== ImageRawDataUpdateResult.success) failed++
          if (i > 0) times.push(performance.now() - t0)
        }
        const ms = median(times)
        report(
          `${plain ? 'Plain' : 'Soft'} image ${w}x${h}: ${ms.toFixed(0)} ms send, ${median(encode).toFixed(0)} ms to prepare${failed ? `, ${failed} failed` : ''}`,
        )
      }

      for (const [label, length] of [['short', 12], ['one line', 45], ['full screen', 400]] as const) {
        const text = new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H, borderWidth: 0, borderColor: 0,
          paddingLength: 4, containerID: 1, containerName: 'capture', content: ' ', isEventCapture: 1,
        })
        await this.call(() =>
          this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [text] })),
        )
        const times: number[] = []
        for (let i = 0; i < 9; i++) {
          const content = Array.from({ length }, (_, k) => ((k + i) % 7 === 0 ? ' ' : '▁─▔'[(k + i) % 3])).join('')
          const t0 = performance.now()
          await this.call(() =>
            this.bridge.textContainerUpgrade(
              new TextContainerUpgrade({ containerID: 1, containerName: 'capture', contentOffset: 0, contentLength: 0, content }),
            ),
          )
          if (i > 0) times.push(performance.now() - t0)
        }
        const ms = median(times)
        report(`Text, ${label}: ${ms.toFixed(0)} ms, ${(1000 / ms).toFixed(1)} per second`)
      }

      const t0 = performance.now()
      await this.call(() => this.bridge.rebuildPageContainer(new RebuildPageContainer(this.page())))
      report(`Page rebuild: ${(performance.now() - t0).toFixed(0)} ms`)
    } finally {
      this.shown = { label: ' ', hint: ' ' }
      await this.call(() => this.bridge.rebuildPageContainer(new RebuildPageContainer(this.page())))
      await this.resume()
    }
  }

  private async resume(): Promise<void> {
    await this.call(() => this.bridge.imuControl(true, ImuReportPace.P100))
    // The host stops location updates while the WebView is suspended.
    if (this.locating) await this.applyLocation()
    this.invalidate()
    const id = ++this.loopId
    void this.loop(id)
  }

  private async pause(): Promise<void> {
    this.loopId++
    await this.call(() => this.bridge.imuControl(false))
  }

  private async loop(id: number): Promise<void> {
    while (id === this.loopId) {
      const sent = await this.frame()
      // After a send, go again at once (no timer: timers are slow in the
      // host's WebView); otherwise check back shortly.
      if (!sent) await sleep(IDLE_POLL_MS)
    }
  }

  /**
   * Send the picture, drawn for when it will be seen: one send from now, plus
   * half the time it then stays on screen. Returns false if nothing changed.
   */
  private async frame(): Promise<boolean> {
    const leadMs = Math.min(SENSOR_TRIP_MS + this.sendMs + this.periodMs / 2, MAX_LEAD_MS)
    const view = this.host.getView(leadMs / 1000)
    const key = viewKey(view)
    if (key === this.lastKey) {
      // Nothing moving: forget the cadence so it is re-measured afresh.
      this.lastFrameAt = 0
      return false
    }
    this.lastKey = key

    const started = performance.now()
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
    drawCue(ctx, view)
    flatten(ctx, TILE_W, TILE_H)
    const png = await encodePng(this.canvas)
    const result = await this.call(() =>
      this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: CUE.id, containerName: CUE.name, imageData: png }),
      ),
    )
    if (result !== ImageRawDataUpdateResult.success) {
      // Make sure a dropped frame is retried rather than left stale.
      this.lastKey = ''
      if (result !== undefined) console.warn('[levelhead] image update:', result)
    }

    const now = performance.now()
    // Slow averages: a steady look-ahead matters more than chasing each
    // send, since delay that wobbles is worse than delay that is constant.
    const ease = (avg: number, value: number) => avg + (Math.min(value, 1000) - avg) * 0.1
    this.sendMs = ease(this.sendMs, now - started)
    if (this.lastFrameAt) this.periodMs = ease(this.periodMs, now - this.lastFrameAt)
    this.lastFrameAt = now
    this.stats = {
      fps: 1000 / this.periodMs,
      frameMs: this.sendMs,
      leadMs,
      failures: this.stats.failures,
    }
    return true
  }

  private onEvent(e: EvenHubEvent): void {
    const sys = e.sysEvent
    if (sys?.imuData && (sys.eventType ?? 0) === OsEventTypeList.IMU_DATA_REPORT) {
      const { x = 0, y = 0, z = 0 } = sys.imuData
      this.host.onImu([x, y, z], performance.now())
      return
    }
    const source = e.textEvent ?? e.listEvent ?? sys
    if (!source) return
    // Protobuf drops zero values, so a single press arrives with no type.
    switch (source.eventType ?? OsEventTypeList.CLICK_EVENT) {
      case OsEventTypeList.CLICK_EVENT:
        this.host.onAction('toggleMode')
        break
      case OsEventTypeList.SCROLL_TOP_EVENT:
        this.host.onAction('intensityUp')
        break
      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        this.host.onAction('intensityDown')
        break
      case OsEventTypeList.LONG_PRESS_EVENT:
        this.host.onAction('recenter')
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        // System exit dialog. Cleanup waits for the exit event, because the
        // wearer can still cancel.
        void this.call(() => this.bridge.shutDownPageContainer(1))
        break
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        void this.resume()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        void this.pause()
        break
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        this.dispose()
        break
    }
  }

  private dispose(): void {
    this.loopId++
    clearTimeout(this.chromeTimer)
    void this.bridge.imuControl(false).catch(() => {})
    void this.bridge.stopAppLocationUpdates().catch(() => {})
    for (const off of this.unsubscribers.splice(0)) off()
  }
}

/**
 * Snap every pixel to one of four brightness levels. Soft edges turn into
 * long runs of identical pixels, which compress far better on the way to the
 * glasses; a smaller packet can mean a shorter send.
 */
function flatten(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const image = ctx.getImageData(0, 0, w, h)
  const px = image.data
  for (let i = 0; i < px.length; i += 4) {
    const level = Math.round(px[i] / 85) * 85
    px[i] = px[i + 1] = px[i + 2] = level
  }
  ctx.putImageData(image, 0, 0)
}

/** The host accepts encoded images and does its own 4-bit conversion. */
function encodePng(canvas: HTMLCanvasElement): Promise<number[]> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('could not encode frame'))
      resolve(Array.from(new Uint8Array(await blob.arrayBuffer())))
    }, 'image/png')
  })
}
