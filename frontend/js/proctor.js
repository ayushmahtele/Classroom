/**
 * proctor.js
 * ------------------------------------------------------------------
 * Runs entirely in the student's browser. The camera frame never
 * leaves the device except as a small evidence JPEG attached to an
 * actual flagged event (not continuous streaming/recording).
 *
 * Every violation is re-reported every 5 seconds for as long as it
 * continues (independent timer per event type, so a different event fires at once).
 * Looking-away sensitivity comes from the quiz (low / medium / high).
 *
 * Detections:
 *  - NO_FACE            no face visible for several consecutive checks
 *  - MULTIPLE_FACES      more than one face in frame
 *  - EYES_CLOSED         both eyes closed/hidden for a sustained period
 *  - LOOKING_AWAY        head turned away from the screen for a while
 *  - PHONE_DETECTED       a cell phone recognised in frame (COCO-SSD)
 *  - OBJECT_DETECTED      another suspicious object (book, remote, laptop#2...)
 *  - TAB_SWITCH            browser tab/window lost focus or was hidden
 *  - FULLSCREEN_EXIT       student left fullscreen mode
 *  - COPY_PASTE            copy or paste attempted during the quiz
 *  - RIGHT_CLICK           right-click / context menu attempted
 *  - CAMERA_DISCONNECTED   webcam feed stopped unexpectedly
 * ------------------------------------------------------------------
 */
const Proctor = (() => {
  const FACE_MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model/';

  // Loop delays (ms) between one detection finishing and the next starting.
  // Detection itself takes ~50-200ms, so a full cycle is well under half a second.
  const FACE_LOOP_DELAY_MS = 20;
  const OBJECT_LOOP_DELAY_MS = 350; // object model is heavy; keep it from starving the face loop
  const STATE_CHECK_MS = 1000; // tab / fullscreen state poll

  // While a violation is STILL happening, the same event type is re-fired at most
  // once per this interval (5s). Different event types have independent timers.
  const REPEAT_MS = 5000;

  // How long a condition must persist before it's flagged (fast on purpose)
  const NO_FACE_HOLD_MS = 500;  // faceless for this long AND no person visible -> NO_FACE
  const MULTI_FACE_HOLD_MS = 0;   // a few consecutive frames, filters flicker
  const FACE_MIN_SCORE = 0.3;        // low bar for "is anyone there" (avoids false NO_FACE)
  const EXTRA_FACE_MIN_SCORE = 0.45;  // higher bar before a 2nd face counts (avoids false MULTIPLE)
  const EYES_CLOSED_HOLD_MS = 2000;
  const OBJECT_SCORE_THRESHOLD = 0.45;
  const EAR_THRESHOLD = 0.20;

  // Looking-away strictness - chosen by the teacher when creating the quiz.
  //   maxOffset : how far the nose may drift from the eye-midpoint (fraction of
  //               face width) before the head counts as "turned"
  //   holdMs    : how long the head must stay turned before it is flagged
  // pitch (up/down) is deliberately looser than yaw: glancing down at the
  // keyboard / desk while typing is normal and should not be flagged.
  const LOOK_AWAY_LEVELS = {
    low:    { yaw: 0.26, pitch: 0.42, holdMs: 3000 },
    medium: { yaw: 0.18, pitch: 0.32, holdMs: 1500 },
    high:   { yaw: 0.12, pitch: 0.24, holdMs: 700 }
  };
  // Head pose is measured relative to how the student sits normally: the first
  // few seconds after the quiz starts are used as the "looking straight" baseline.
  const CALIBRATION_SAMPLES = 15;
  const CALIBRATION_MAX_SPREAD = 0.06; // samples must agree, i.e. student was sitting still & straight
  const baseline = { ready: false, samples: [], yawJaw: 0, yawEye: 0, pitch: 0.5 };
  const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

  function headPose(lm) {
    const jaw = lm.getJawOutline();
    const jawW = Math.abs(jaw[16].x - jaw[0].x) || 1;
    const nose = lm.getNose()[3];
    const leftEye = lm.getLeftEye();
    const rightEye = lm.getRightEye();
    const eyeMidX = (leftEye[0].x + rightEye[3].x) / 2;
    const eyeMidY = (leftEye[0].y + rightEye[3].y) / 2;
    return {
      yawJaw: (nose.x - (jaw[0].x + jaw[16].x) / 2) / jawW,           // nose vs middle of jaw
      yawEye: (nose.x - eyeMidX) / jawW,                               // nose vs middle of eyes
      pitch: (nose.y - eyeMidY) / ((jaw[8].y - eyeMidY) || 1)          // nose height between eyes and chin
    };
  }
  const SUSPICIOUS_OBJECTS = { 'cell phone': 'PHONE_DETECTED', book: 'OBJECT_DETECTED', remote: 'OBJECT_DETECTED' };

  let cfg = null; // { video, attemptId, quizId, lookAwayStrictness, onEvent, flagAttempt }
  let modelsReady = false;
  let cocoModel = null;
  let ssdReady = false;      // heavier, more accurate face detector used as a fallback
  let lastPersonAt = 0;      // last time the object model saw a 'person' in the frame
  let startedAt = 0;
  const PERSON_RECENT_MS = 500; // 'person' sighting counts as still-present for this long
  const START_GRACE_MS = 8000;       // no camera-based flags at all during the first seconds
  const CALIBRATION_START_MS = 2000; // head-pose baseline sampling begins here (inside the grace period)
  const CAMERA_EVENTS = ['NO_FACE', 'MULTIPLE_FACES', 'LOOKING_AWAY', 'EYES_CLOSED', 'PHONE_DETECTED', 'OBJECT_DETECTED']; // no NO_FACE flags while the camera/detector warms up
  let stream = null;
  let running = false;
  let lookAwayLevel = LOOK_AWAY_LEVELS.medium;
  // "since" timestamps: when the current uninterrupted condition began (null = not happening)
  const since = { fs: null, faceHidden: null, noFace: null, multi: null, eyes: null, look: null };
  let tabAway = false;
  let fullscreenWasOn = false;
  let fsOut = false; // currently outside fullscreen?

  // True for API fullscreen AND browser F11 fullscreen (F11 does not set
  // document.fullscreenElement, which used to make returning via F11 look like
  // a permanent "exit").
  function isFullscreen() {
    if (document.fullscreenElement) return true;
    // Chrome/Edge report F11 fullscreen through this media query
    try {
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (e) { /* unsupported */ }
    // Fallback: window covers the whole screen (tolerant of scaling/zoom rounding)
    const tol = 16;
    const outerFull = window.outerWidth >= screen.width - tol && window.outerHeight >= screen.height - tol;
    const innerFull = window.innerWidth >= screen.width - tol && window.innerHeight >= screen.height - tol;
    return outerFull || innerFull;
  }

  // Reports FULLSCREEN_EXIT (repeating every 5s) ONLY while the student is out of
  // fullscreen; the moment they are back in, it stops and resets.
  function handleFullscreenState() {
    const now = Date.now();
    if (isFullscreen()) {
      if (!fullscreenWasOn || fsOut) console.info('[proctor] fullscreen OK');
      fullscreenWasOn = true;
      fsOut = false;
      since.fs = null;
      return;
    }
    if (!fullscreenWasOn) return;
    // must stay out for ~1s: ignores the brief flicker while F11 / fullscreen toggles
    if (!heldFor('fs', true, 1000, now)) return;
    const onset = !fsOut;
    if (onset) {
      console.info('[proctor] not fullscreen', { outer: [window.outerWidth, window.outerHeight],
        inner: [window.innerWidth, window.innerHeight], screen: [screen.width, screen.height] });
    }
    fsOut = true;
    fireEvent('FULLSCREEN_EXIT', null, {}, onset);
    if (onset) cfg.onFullscreenExit?.();
  }

  // Any click while out of fullscreen puts the student straight back in.
  function onClickReenter() {
    if (fullscreenWasOn && !isFullscreen()) document.documentElement.requestFullscreen?.().catch(() => {});
  }
  let stateTimer = null;
  let faceLoopErrorLogged = false;
  const lastFired = {};

  async function loadModels(onProgress) {
    await tf.ready();
    onProgress?.('Loading face detection model…');
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
    onProgress?.('Loading eye/landmark model…');
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODEL_URL);
    try {
      onProgress?.('Loading backup face model…');
      await faceapi.nets.ssdMobilenetv1.loadFromUri(FACE_MODEL_URL);
      ssdReady = true;
    } catch (e) {
      console.warn('Backup face model unavailable, using fast detector only:', e);
    }
    onProgress?.('Loading object detection model…');
    cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    modelsReady = true;
  }

  async function requestCamera(videoEl) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 }, audio: false });
    videoEl.srcObject = stream;
    await new Promise((resolve) => (videoEl.onloadedmetadata = resolve));
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      fireEvent('CAMERA_DISCONNECTED', null, {});
      cfg?.onCameraLost?.();
    });
    return stream;
  }

  function eyeAspectRatio(eyePoints) {
    // eyePoints: 6 (x,y) landmark points around one eye
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const vertical1 = dist(eyePoints[1], eyePoints[5]);
    const vertical2 = dist(eyePoints[2], eyePoints[4]);
    const horizontal = dist(eyePoints[0], eyePoints[3]);
    if (horizontal === 0) return 1;
    return (vertical1 + vertical2) / (2 * horizontal);
  }

  function captureEvidenceBlob() {
    return new Promise((resolve) => {
      const canvas = document.getElementById('captureCanvas');
      const video = cfg.video;
      canvas.width = video.videoWidth || 480;
      canvas.height = video.videoHeight || 360;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
    });
  }

  // onset=true marks the first report of a new violation episode (used so the
  // attempt's tabSwitches/fullscreenExits counters count episodes, not seconds).
  async function fireEvent(type, confidence, meta, onset = false) {
    if (!running || !cfg) return;
    const now = Date.now();
    if (CAMERA_EVENTS.includes(type) && now - startedAt < START_GRACE_MS) return; // start-up grace
    if (lastFired[type] && now - lastFired[type] < REPEAT_MS) return;
    lastFired[type] = now;

    cfg.onEvent?.({ type, confidence, meta, timestamp: new Date().toISOString() });

    if (onset && type === 'TAB_SWITCH') cfg.flagAttempt?.('tabSwitches');
    if (onset && type === 'FULLSCREEN_EXIT') cfg.flagAttempt?.('fullscreenExits');

    try {
      const blob = await captureEvidenceBlob();
      const form = new FormData();
      form.append('attemptId', cfg.attemptId);
      form.append('quizId', cfg.quizId);
      form.append('type', type);
      if (confidence != null) form.append('confidence', String(confidence));
      form.append('meta', JSON.stringify(meta || {}));
      if (blob) form.append('evidence', blob, 'evidence.jpg');
      await api('/proctor/events', { method: 'POST', body: form, isForm: true });
    } catch (e) {
      console.warn('Could not report proctoring event:', e.message);
    }
  }

  // true once `key` has been continuously active for holdMs
  function heldFor(key, active, holdMs, now) {
    if (!active) { since[key] = null; return false; }
    if (since[key] == null) since[key] = now;
    return now - since[key] >= holdMs;
  }

  // Sliding-window verdict: LOOKING_AWAY only when ~75% of the frames over the
  // last `holdMs` say "looking away". A single noisy frame can neither start nor
  // keep the alarm going, and a single missed frame doesn't cancel a real turn.
  const multiHist = [];
  const lookSamples = [];
  function lookedAwayForWindow(active, holdMs, now) {
    const win = Math.max(holdMs, 500);
    lookSamples.push({ t: now, a: active });
    while (lookSamples.length && now - lookSamples[0].t > win) lookSamples.shift();
    if (lookSamples.length < 2) return false;
    const covered = now - lookSamples[0].t >= win * 0.7;   // window mostly filled
    const ratio = lookSamples.filter(x => x.a).length / lookSamples.length;
    return covered && ratio >= 0.75;
  }

  async function faceLoop() {
    if (!running) return;
    if (!cfg.video.videoWidth || !cfg.video.videoHeight) {
      // Camera hasn't reported real pixel dimensions yet - skip this cycle
      // rather than feeding a 0x0 frame into face-api.
      setTimeout(faceLoop, FACE_LOOP_DELAY_MS);
      return;
    }
    try {
      let detections = await faceapi
        .detectAllFaces(cfg.video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: FACE_MIN_SCORE }))
        .withFaceLandmarks(true);
      // The fast detector struggles with dim lighting / glasses glare / small faces.
      // Before ever calling it "no face", double-check with the accurate detector.
      if (detections.length === 0 && ssdReady) {
        detections = await faceapi
          .detectAllFaces(cfg.video, new faceapi.SsdMobilenetv1Options({ minConfidence: FACE_MIN_SCORE }))
          .withFaceLandmarks(true);
      }
      const now = Date.now();
      const count = detections.length;
      // A 2nd face only counts if it is confident AND reasonably large compared to
      // the main face (ignores posters / tiny background blobs / ghost detections)
      const biggest = detections.reduce((m, d) => Math.max(m, d.detection.box.area), 0);
      const realFaces = detections.filter(d =>
        d.detection.score >= EXTRA_FACE_MIN_SCORE && d.detection.box.area >= biggest * 0.2).length;

            // A 'person' still visible to the object model means the student is in
      // frame but the face isn't readable (turned / glare) -> not "no face".
      const personVisible = now - lastPersonAt < PERSON_RECENT_MS;
      const warmedUp = now - startedAt > START_GRACE_MS;

      // ---- NO FACE: faceless and nobody visible at all
      if (heldFor('noFace', count === 0 && warmedUp, NO_FACE_HOLD_MS, now) && !personVisible) {
        fireEvent('NO_FACE', null, {});
      }

      // ---- MULTIPLE FACES
      // Fires on the FIRST frame when the 2nd face is confident, otherwise as soon as
      // 2 of the last 3 frames show 2+ faces (~0.5s) - fast, but ignores 1-frame ghosts.
      multiHist.push(realFaces >= 2);
      if (multiHist.length > 3) multiHist.shift();
      const strongSecond = detections.filter(d => d.detection.score >= 0.75).length >= 2;
      if (realFaces >= 2 && (strongSecond || multiHist.filter(Boolean).length >= 2)) {
        fireEvent('MULTIPLE_FACES', null, { count: realFaces });
      }

      // ---- LOOKING AWAY: one clock for "head turned/tilted" AND "face unreadable
      //      while a person is still there", so both keep accumulating together.
      let lookActive = false;
      let lookMeta = { strictness: cfg.lookAwayStrictness || 'medium' };
      let lookConf = null;

      if (count === 1) {
        const lm = detections[0].landmarks;
        const leftEye = lm.getLeftEye();
        const rightEye = lm.getRightEye();
        const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;
        if (heldFor('eyes', ear < EAR_THRESHOLD, EYES_CLOSED_HOLD_MS, now)) {
          fireEvent('EYES_CLOSED', Math.min(1, 1 - ear), { ear });
        }

        // head pose (left/right AND up/down), relative to the student's own baseline
        const pose = headPose(lm);
        if (!baseline.ready && now - startedAt > CALIBRATION_START_MS) {
          baseline.samples.push(pose);
          if (baseline.samples.length >= CALIBRATION_SAMPLES) {
            const my = median(baseline.samples.map(x => x.yawJaw));
            const me = median(baseline.samples.map(x => x.yawEye));
            const mp = median(baseline.samples.map(x => x.pitch));
            const steady = baseline.samples.filter(x =>
              Math.abs(x.yawJaw - my) < CALIBRATION_MAX_SPREAD &&
              Math.abs(x.yawEye - me) < CALIBRATION_MAX_SPREAD &&
              Math.abs(x.pitch - mp) < CALIBRATION_MAX_SPREAD * 1.5).length;
            // a straight-facing baseline sits near yaw 0; reject anything else
            if (steady >= CALIBRATION_SAMPLES * 0.7 && Math.abs(my) < 0.12 && Math.abs(me) < 0.12) {
              baseline.yawJaw = my; baseline.yawEye = me; baseline.pitch = mp;
              baseline.ready = true;
              console.info('[proctor] head-pose baseline set', { yawJaw: my, yawEye: me, pitch: mp });
            } else {
              console.info('[proctor] baseline rejected (not steady/straight) - retrying');
              baseline.samples = [];
            }
          }
        }
        const dYaw = Math.max(Math.abs(pose.yawJaw - baseline.yawJaw), Math.abs(pose.yawEye - baseline.yawEye));
        const dPitch = baseline.ready ? Math.abs(pose.pitch - baseline.pitch) : 0;
        lookActive = baseline.ready && (dYaw > lookAwayLevel.yaw || dPitch > lookAwayLevel.pitch);
        if (lookActive) {
          const yawDir = (pose.yawJaw - baseline.yawJaw) > 0 ? 'right' : 'left';
          const pitchDir = (pose.pitch - baseline.pitch) > 0 ? 'down' : 'up';
          lookMeta.direction = dYaw / lookAwayLevel.yaw >= dPitch / lookAwayLevel.pitch ? yawDir : pitchDir;
          lookConf = Math.min(1, Math.max(dYaw / 0.3, dPitch / 0.3));
        }
      } else {
        since.eyes = null;
        if (count === 0 && personVisible && warmedUp && since.noFace != null && now - since.noFace >= 2500) {
          lookActive = true;
          lookMeta.reason = 'face not visible (head turned away)';
        }
      }
      if (count < 2 && lookedAwayForWindow(lookActive, lookAwayLevel.holdMs, now)) {
        fireEvent('LOOKING_AWAY', lookConf, lookMeta);
      }
    } catch (e) {
      if (!faceLoopErrorLogged) {
        console.error('Face detection cycle failed (will keep retrying silently):', e);
        faceLoopErrorLogged = true;
      }
    }
    setTimeout(faceLoop, FACE_LOOP_DELAY_MS);
  }

  async function objectLoop() {
    if (!running) return;
    if (!cfg.video.videoWidth || !cfg.video.videoHeight) {
      setTimeout(objectLoop, OBJECT_LOOP_DELAY_MS);
      return;
    }
    try {
      const predictions = await cocoModel.detect(cfg.video);
      // one event per type per frame, even if several objects are visible
      const seen = new Map();
      for (const p of predictions) {
        if (p.class === 'person' && p.score > 0.3) lastPersonAt = Date.now();
        const mapped = SUSPICIOUS_OBJECTS[p.class];
        if (mapped && p.score > OBJECT_SCORE_THRESHOLD) {
          if (!seen.has(mapped) || seen.get(mapped).score < p.score) seen.set(mapped, p);
        }
      }
      // fires immediately, and again every second while the object stays in view
      for (const [type, p] of seen) fireEvent(type, p.score, { object: p.class });
    } catch (e) {
      console.warn('Object detection cycle failed:', e);
    }
    setTimeout(objectLoop, OBJECT_LOOP_DELAY_MS);
  }

  // ---- Tab switch / fullscreen: polled every second so the event keeps
  // repeating for as long as the student stays away.
  function checkState() {
    if (!running) return;
    const away = document.hidden || !document.hasFocus();
    if (away) {
      fireEvent('TAB_SWITCH', null, { via: document.hidden ? 'hidden-tab' : 'window-unfocused' }, !tabAway);
    }
    tabAway = away;

    handleFullscreenState();
  }

  // Instant reaction on the moment of switching; checkState() then repeats it every second.
  function onVisibilityChange() {
    if (document.hidden) {
      fireEvent('TAB_SWITCH', null, { via: 'visibilitychange' }, !tabAway);
      tabAway = true;
    }
  }
  function onBlur() {
    fireEvent('TAB_SWITCH', null, { via: 'window-blur' }, !tabAway);
    tabAway = true;
  }
  function onFocus() {
    if (!document.hidden) tabAway = false;
  }
  function onFullscreenChange() {
    handleFullscreenState();
  }
  function onCopyOrPaste(e) {
    fireEvent('COPY_PASTE', null, { action: e.type });
  }
  function onContextMenu(e) {
    e.preventDefault();
    fireEvent('RIGHT_CLICK', null, {});
  }

  return {
    async init(config) {
      cfg = config;
      lookAwayLevel = LOOK_AWAY_LEVELS[cfg.lookAwayStrictness] || LOOK_AWAY_LEVELS.medium;
    },
    async loadModels(onProgress) {
      if (!modelsReady) await loadModels(onProgress);
    },
    async requestCamera(videoEl) {
      return requestCamera(videoEl);
    },
    getStream() {
      return stream;
    },
    start() {
      if (running) return;
      running = true;
      startedAt = Date.now();
      fullscreenWasOn = isFullscreen();
      fsOut = false;
      faceLoop();
      objectLoop();
      stateTimer = setInterval(checkState, STATE_CHECK_MS);
      window.addEventListener('focus', onFocus);
      window.addEventListener('resize', handleFullscreenState);
      document.addEventListener('click', onClickReenter);
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('blur', onBlur);
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('copy', onCopyOrPaste);
      document.addEventListener('paste', onCopyOrPaste);
      document.addEventListener('contextmenu', onContextMenu);
    },
    stop() {
      running = false;
      clearInterval(stateTimer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('resize', handleFullscreenState);
      document.removeEventListener('click', onClickReenter);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('copy', onCopyOrPaste);
      document.removeEventListener('paste', onCopyOrPaste);
      document.removeEventListener('contextmenu', onContextMenu);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
  };
})();
