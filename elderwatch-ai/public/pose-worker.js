/* MediaPipe 0.10.14: classic worker keeps WASM inference off the UI thread. */
self.exports = {};
importScripts('/mediapipe/vision_bundle.js');
let detector;
let lastTimestamp = -1;
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
      const result = detector.detectForVideo(data.bitmap, lastTimestamp);
      self.postMessage({ type: 'pose', time: data.time, landmarks: result.landmarks[0] ?? null });
    } catch { self.postMessage({ type: 'error', message: 'Body tracking stopped. Pause and play to retry.' }); }
    finally { data.bitmap.close(); }
  }
};
