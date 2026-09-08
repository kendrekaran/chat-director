(() => {
  const playerA = document.getElementById("player-a");
  const playerB = document.getElementById("player-b");
  const hold = document.getElementById("hold");
  let front = playerA;
  let back = playerB;
  let currentId = null;
  let nextId = null;
  let muted = false;
  let connecting = false;

  function applyMute() {
    playerA.muted = muted;
    playerB.muted = muted;
  }

  function showHold(visible) {
    hold.classList.toggle("hidden", !visible);
    hold.setAttribute("aria-hidden", visible ? "false" : "true");
    hold.hidden = !visible;
  }

  function attach(video, url) {
    if (video.dataset.src === url && video.readyState >= 2) return Promise.resolve();
    video.dataset.src = url;
    video.preload = "auto";
    video.src = url;
    video.load();
    return new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("canplay", done);
        video.removeEventListener("error", done);
        resolve();
      };
      video.addEventListener("canplay", done, { once: true });
      video.addEventListener("error", done, { once: true });
    });
  }

  function swap() {
    back.classList.add("active");
    front.classList.remove("active");
    const previous = front;
    front = back;
    back = previous;
    back.pause();
  }

  async function playFront() {
    showHold(false);
    front.classList.add("active");
    back.classList.remove("active");
    const restoreSound = !muted;
    front.muted = true;
    try {
      await front.play();
    } catch {
      await front.play().catch(() => undefined);
    }
    if (restoreSound) {
      front.muted = false;
      muted = false;
    }
    applyMute();
  }

  function latest(playlist) {
    return playlist[playlist.length - 1] ?? null;
  }

  async function applyState(state) {
    muted = Boolean(state.muted);
    applyMute();
    const playlist = state.playlist ?? [];
    const newest = latest(playlist);

    if (state.hold) {
      front.pause();
      back.pause();
      showHold(true);
      return;
    }

    if (!newest) {
      if (!currentId) showHold(true);
      return;
    }

    if (!currentId || currentId !== newest.jobId && !nextId && front.ended) {
      await attach(front, newest.playbackUrl);
      currentId = newest.jobId;
      nextId = null;
      await playFront();
      return;
    }

    if (newest.jobId !== currentId && newest.jobId !== nextId) {
      await attach(back, newest.playbackUrl);
      nextId = newest.jobId;
    }

    if (currentId === newest.jobId && front.paused && !front.ended) {
      await playFront();
    }
  }

  async function onEnded() {
    if (nextId && back.readyState >= 2) {
      back.currentTime = 0;
      const restoreSound = !muted;
      back.muted = true;
      await back.play().catch(() => undefined);
      if (restoreSound) back.muted = false;
      applyMute();
      swap();
      currentId = nextId;
      nextId = null;
      back.removeAttribute("src");
      delete back.dataset.src;
      return;
    }
    front.currentTime = 0;
    await front.play().catch(() => undefined);
  }

  playerA.addEventListener("ended", () => {
    if (front === playerA) void onEnded();
  });
  playerB.addEventListener("ended", () => {
    if (front === playerB) void onEnded();
  });

  async function hydrate() {
    const response = await fetch("/api/overlay/state");
    if (!response.ok) return;
    await applyState(await response.json());
  }

  function connect() {
    if (connecting) return;
    connecting = true;
    const source = new EventSource("/api/overlay/events");
    source.onmessage = (event) => {
      try {
        void applyState(JSON.parse(event.data));
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => {
      connecting = false;
      source.close();
      setTimeout(() => {
        void hydrate().finally(connect);
      }, 1200);
    };
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void hydrate();
  });

  void hydrate().finally(connect);
})();
