# Notes

How Levelhead works and what the design rests on.

## How it works

| File | Role |
| --- | --- |
| `src/motion.ts` | Accelerometer to roll/pitch (ship) and turn/surge (car); calibration maths |
| `src/render.ts` | Draws the horizon and the dot field; shared by glasses and phone preview |
| `src/glasses.ts` | Page layout, frame loop, touch input, IMU stream, lifecycle |
| `src/ui.ts` | Phone screen |
| `src/settings.ts` | Persistence through the Even app's storage |

The SDK exposes the IMU as bare `x / y / z` values at up to 10 Hz with no
documented axes or units. The three-pose calibration measures the axes
directly and all outputs are ratios, so nothing depends on that convention.

The cue is two 288 x 144 image containers (the SDK maximum per image) side by
side, spanning the full width of the display. Each Bluetooth send carries one
tile drawn from the newest motion sample; tiles are only sent when the picture
changes. "Centre" layout uses a single tile and refreshes faster.

## How well each part is supported

| Part | Support | Notes |
| --- | --- | --- |
| Ship: earth-fixed horizon line | Good. Tal 2012, TNO (Bos), Hemmerich 2020, Krueger 2011 | Reduces sickness, does not cure it. Roll is drawn 1:1. |
| Full-width picture | Reasonable. Peripheral cues work better than central ones | Hemmerich credits the horizon's effect to peripheral vision but did not test widths. |
| Look-ahead | Reasonable. Buker 2012; ship-motion forecasting is standard | Our numbers are from simulation, not hardware. |
| Blank when data is stale | Follows from the above | A frozen line is a head-fixed line. |
| Car: motion dots | Weak. No efficacy data for this design; de Winkel 2021 found no benefit when passengers could see out | Kept as the only local option for cars. |
| Car: phone location, head-direction estimate | Engineering, not research | Removes false cues from head movement, which is the likeliest way to make someone feel worse. |
| Ship: pitch at one-third scale | Engineering compromise | An accelerometer cannot tell pitching from surging; full scale would amplify that error. |

Removed: "Follow the waves" (moving the line with the boat's rise and fall).
No study isolates a benefit from showing heave, a real horizon does not move
that way, and the estimate was the least reliable signal in the app.

## Choices that come from the research

- **Only earth-fixed elements are drawn.** In Hemmerich, Keshavarz & Hecht
  (2020) an earth-fixed horizon line reduced sickness; a head-fixed line and a
  fixation cross did not.
- **The horizon runs to the edges of the display**, since its benefit is
  thought to come through peripheral vision, and cues are generally more
  effective there.
- **Lag is treated as a hazard.** Each picture is drawn for the moment it
  will be on screen, not for when it was computed: sensor delay, one Bluetooth
  send and half the picture's time on screen are measured and looked ahead
  over. Predictive compensation of this kind reduced sickness in Buker,
  Vincenzi & Deaton (2012). Ship motion is regular enough to forecast well, so
  roll and pitch use an autoregressive model re-fitted on every sample
  (`src/predict.ts`); a head jerk switches the forecast off for a second. In an
  end-to-end simulation of a 7-10 s swell the full-width picture trails the
  motion by about 0.1 s and is off by 0.8 degrees on average, against 0.47 s
  and 1.5 degrees with no look-ahead.
- **Steady timing.** Delay that varies has been found worse than delay that
  is constant, so sends run back to back at an even cadence, the look-ahead
  follows slow averages, and there is no slow-refresh mode.
- **No data, no cue.** If the sensor stream stops, calibration is missing, or
  the glasses come off, the display goes blank rather than showing a stale
  reference.
- **Car dots stay out of central vision**, where visual cues have been reported
  to distract or backfire.

Car mode rests on weaker evidence than ship mode: de Winkel et al. (2021) found
no benefit from showing a vehicle's current motion to passengers who already
had a view. The interventions with the best results warn of motion before it
happens. That needs road data for the route ahead, which is not available
offline, so this app does not do it.
