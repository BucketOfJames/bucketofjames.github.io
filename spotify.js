const SPOTIFY_API_URL = "https://bucket-spotify-now-playing.bucketofjames.workers.dev/now-playing";

const card = document.getElementById("spotify-card");
const cover = document.getElementById("spotify-cover");
const titleEl = document.getElementById("spotify-title");
const artistEl = document.getElementById("spotify-artist");
const currentEl = document.getElementById("spotify-current");
const durationEl = document.getElementById("spotify-duration");
const progressBar = document.getElementById("spotify-progress-bar");
const linkEl = document.getElementById("spotify-link");

let playbackState = null;
let tickInterval = null;

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateProgressDisplay() {
  if (!playbackState) return;

  currentEl.textContent = formatTime(playbackState.progressMs);
  durationEl.textContent = formatTime(playbackState.durationMs);

  const pct =
    playbackState.durationMs > 0
      ? (playbackState.progressMs / playbackState.durationMs) * 100
      : 0;

  progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function renderPlayback(data) {
  playbackState = {
    isPlaying: Boolean(data.isPlaying),
    progressMs: data.progressMs || 0,
    durationMs: data.durationMs || 0,
  };

  cover.src = data.albumArtUrl || "";
  cover.alt = data.title ? `${data.title} album cover` : "Album cover";
  titleEl.textContent = data.title || "Nothing playing";
  artistEl.textContent = data.artist || "";
  linkEl.href = data.trackUrl || "#";

  card.hidden = false;
  updateProgressDisplay();
}

function startTicking() {
  clearInterval(tickInterval);

  tickInterval = setInterval(() => {
    if (!playbackState || !playbackState.isPlaying) return;

    playbackState.progressMs += 1000;

    if (playbackState.progressMs > playbackState.durationMs) {
      playbackState.progressMs = playbackState.durationMs;
    }

    updateProgressDisplay();
  }, 1000);
}

async function refreshSpotifyWidget() {
  try {
    const response = await fetch(SPOTIFY_API_URL, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data || !data.trackUrl) {
      card.hidden = true;
      clearInterval(tickInterval);
      return;
    }

    renderPlayback(data);
    startTicking();
  } catch (error) {
    console.error("Spotify widget error:", error);
    card.hidden = true;
    clearInterval(tickInterval);
  }
}

refreshSpotifyWidget();
setInterval(refreshSpotifyWidget, 10000);
