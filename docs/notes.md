# Research notes

What was read, what it found, and what Levelhead does because of it.
These are from abstracts and summaries, not full papers.

## Ship mode

Tal et al. 2012, "Artificial horizon effects on motion sickness and
performance", Otology & Neurotology. Thirty people prone to motion sickness
rode a ship simulator. With a display that matched the ship's motion, peak
sickness scores fell from 9.83 to 7.23. Symptoms did not go away.
So: a horizon helps, and the app says it will not cure anything.

Hemmerich, Keshavarz & Hecht 2020, "Visually induced motion sickness on the
horizon", Frontiers in Virtual Reality. A horizon line fixed to the earth
reduced sickness. The same line fixed to the head did not, and neither did a
fixation cross. So: the line always matches the real horizon, roll is drawn
1:1, and nothing on the display moves with the head.

Bos et al. 2012 (TNO), "Optimising human performance by reducing motion
sickness and enhancing situation awareness with an artificial 3D Earth-fixed
visual reference". An earth-fixed reference reduced sickness in ship and
aircraft motion. Adding a view of the path ahead reduced it by more than a
factor of four. So: warning of motion before it happens works best. That
needs route data, which is not available offline, so the app does not do it.

## Car mode

de Winkel et al. 2021, "Efficacy of augmented visual environments for
reducing sickness in autonomous vehicles". Passengers shown extra cues about
the vehicle's motion were no less sick than passengers with a normal view.
So: the car dots are unproven, and the app tells people to look at the road
first.

"Will visual cues help alleviating motion sickness in automated cars?",
review, Ergonomics, 2023. Visual cues worked better at the edge of vision
than in the centre. So: the dots sit at the sides of the picture, away from
the centre.

## Delay

Buker, Vincenzi & Deaton 2012, "The effect of apparent latency on simulator
sickness while using a see-through helmet-mounted display", Human Factors.
Predicting ahead to cancel display delay reduced sickness. So: each picture
is drawn for the moment it will be seen, not the moment it was computed.

"The effects of 0.2 Hz varying latency with 20-100 ms varying amplitude on
simulator sickness in a helmet mounted display", Displays. Delay that varied
caused more sickness than delay that stayed constant. So: pictures are sent
at a steady pace.
