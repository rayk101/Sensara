// A MediaRecorder needs one mixed audio track; it does not reliably mix multiple tracks.
export async function recordingAudio(stream: MediaStream, microphone: MediaStream | null) {
  const tracks = [...new Set([...stream.getAudioTracks(), ...(microphone?.getAudioTracks() ?? [])])]
    .filter(track => track.readyState === "live");
  if (tracks.length < 2) return { tracks, close: () => {} };
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const sources = tracks.map(track => context.createMediaStreamSource(new MediaStream([track])));
  for (const source of sources) source.connect(destination);
  try { await context.resume(); }
  catch (error) { await context.close(); throw error; }
  return { tracks: destination.stream.getAudioTracks(), close: () => {
    sources.forEach(source => source.disconnect());
    destination.stream.getTracks().forEach(track => track.stop());
    void context.close();
  } };
}
