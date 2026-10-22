/* MediaPipe 0.10.14: classic worker keeps WASM inference off the UI thread. */
self.exports = {};
importScripts('/mediapipe/vision_bundle.js');
let detector;
let lastTimestamp = -1;
let reacquire = false;
let lastMediaTime = -1;

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const vision = await exports.FilesetResolver.forVisionTasks('/mediapipe/wasm');
      detector = await exports.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_full.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5,
      });
      self.postMessage({ type: 'ready' });
    } catch { self.postMessage({ type: 'error', message: 'Body tracking could not load. Retry this feed.' }); }
    return;
  }
  if (data.type === 'frame') {
    try {
      if (!detector) throw new Error('Not ready');
      lastTimestamp = Math.max(lastTimestamp + 1, data.timestamp);
      if (lastMediaTime >= 0 && (data.time < lastMediaTime || data.time - lastMediaTime > .8)) reacquire = true;
      lastMediaTime = data.time;
      let result;
      if (reacquire) {
        await detector.setOptions({ runningMode: 'IMAGE' });
        result = detector.detect(data.bitmap);
        await detector.setOptions({ runningMode: 'VIDEO' });
      } else result = detector.detectForVideo(data.bitmap, lastTimestamp);
      const p = result.landmarks[0];
      // Reject an upside-down torso track on furniture and request a fresh
      // detection next time. Continuous valid tracks retain VIDEO smoothing.
      const dx = p ? Math.abs((p[11].x+p[12].x-p[23].x-p[24].x)/2)*(data.aspect || 16/9) : 0;
      const dy = p ? (p[11].y+p[12].y-p[23].y-p[24].y)/2 : 0;
      reacquire = !!p && dy > 0 && Math.atan2(dx,Math.abs(dy))*180/Math.PI < 65;
      self.postMessage({ type: 'pose', time: data.time, landmarks: result.landmarks[0] ?? null });
    } catch { self.postMessage({ type: 'error', message: 'Body tracking stopped. Pause and play to retry.' }); }
    finally { data.bitmap.close(); }
  }
};
