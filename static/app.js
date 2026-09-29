/**
 * Sonetel Power Dialer & Pipeline — Frontend Controller (v5.0.0)
 * ==============================================================
 * - Practical 3-Column Power Dialer:
 *     1. Left Column: Fixed-order Calling List (#1, #2, #3...) with filter & search
 *     2. Center Column: Complete On-Screen Contact Dossier (100% of uploaded fields) + Auto-Saving Call Notes
 *     3. Right Column: Realistic Phone Handset + Single Slider Toggle (Call Back vs Internet VoIP) + Outcome Logger
 * - Single gentle crystal "Ting" chime (NO repeating "beee bee" ringback loop)
 * - Hard-locked contact snapshot during active calls so on-screen info never glitches or switches mid-call
 */

class SonetelAudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.micStream = null;
    this.micSource = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.isMuted = false;
    this.soundEnabled = true;
    this.spectrumFrameId = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Plays a single, soft crystal "ting" chime — NO repeating ringback tone ever.
   */
  playTingSound(type = "dial") {
    if (!this.soundEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "triangle";

      if (type === "dial") {
        osc1.frequency.setValueAtTime(1046.5, now); // C6
        osc2.frequency.setValueAtTime(1567.98, now); // G6
      } else if (type === "connect") {
        osc1.frequency.setValueAtTime(1318.51, now); // E6
        osc2.frequency.setValueAtTime(1975.53, now); // B6
      } else {
        osc1.frequency.setValueAtTime(783.99, now); // G5
        osc2.frequency.setValueAtTime(1174.66, now); // D6
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.58);
      osc2.stop(now + 0.58);
    } catch (_) {
      // Ignore if browser audio policy blocks before user gesture
    }
  }

  playDtmf(digit) {
    if (!this.soundEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const dtmfFreqs = {
      "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
      "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
      "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
      "*": [941, 1209], "0": [941, 1336], "#": [941, 1477]
    };
    const pair = dtmfFreqs[String(digit)];
    if (!pair) return;

    try {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "sine";
      osc1.frequency.setValueAtTime(pair[0], now);
      osc2.frequency.setValueAtTime(pair[1], now);

      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.13);
      osc2.stop(now + 0.13);
    } catch (_) {}
  }

  async acquireMicrophone() {
    if (this.micStream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      const ctx = this.ensureContext();
      if (ctx) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 64;
        this.micSource = ctx.createMediaStreamSource(this.micStream);
        this.micSource.connect(this.analyser);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  toggleMicMute() {
    this.isMuted = !this.isMuted;
    if (this.micStream) {
      this.micStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
    return this.isMuted;
  }

  startRecording(onStopCallback) {
    if (this.isRecording) return false;
    this.recordedChunks = [];
    try {
      let streamToRecord = this.micStream;
      if (!streamToRecord && this.ctx) {
        const dest = this.ctx.createMediaStreamDestination();
        streamToRecord = dest.stream;
      }
      if (!streamToRecord || typeof MediaRecorder === "undefined") {
        return false;
      }
      this.mediaRecorder = new MediaRecorder(streamToRecord);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        if (onStopCallback) onStopCallback(url);
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return;
    try {
      this.mediaRecorder.stop();
    } catch (_) {}
    this.isRecording = false;
  }

  startSpectrumVisualizer(canvasEl, getCallStateFn) {
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext("2d");
    const width = canvasEl.width;
    const height = canvasEl.height;
    const bufferLength = 14;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      this.spectrumFrameId = requestAnimationFrame(draw);
      ctx2d.clearRect(0, 0, width, height);

      const state = getCallStateFn ? getCallStateFn() : "idle";
      let hasRealMicData = false;

      if (this.analyser && !this.isMuted && state !== "idle") {
        this.analyser.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        if (sum > 10) hasRealMicData = true;
      }

      const barWidth = 4;
      const gap = 2;
      const totalBars = 12;
      const t = performance.now() / 1000;

      for (let i = 0; i < totalBars; i++) {
        let ratio = 0.14;
        if (hasRealMicData) {
          ratio = Math.max(0.14, (dataArray[i] || 20) / 255);
        } else if (state === "dialing") {
          ratio = 0.22 + 0.25 * Math.abs(Math.sin(t * 4 + i * 0.45));
        } else if (state === "connected") {
          ratio = 0.2 + 0.55 * Math.abs(Math.sin(t * 7 + i * 0.6) * Math.cos(t * 3 - i * 0.3));
        }

        const barHeight = Math.max(3, Math.round(ratio * (height - 4)));
        const x = i * (barWidth + gap) + 4;
        const y = Math.round((height - barHeight) / 2);

        if (state === "connected") {
          ctx2d.fillStyle = "#10b981";
        } else if (state === "dialing") {
          ctx2d.fillStyle = "#6366f1";
        } else {
          ctx2d.fillStyle = "rgba(161, 161, 170, 0.3)";
        }

        ctx2d.beginPath();
        if (ctx2d.roundRect) {
          ctx2d.roundRect(x, y, barWidth, barHeight, 2);
        } else {
          ctx2d.rect(x, y, barWidth, barHeight);
        }
        ctx2d.fill();
      }
    };

    if (this.spectrumFrameId) cancelAnimationFrame(this.spectrumFrameId);
    draw();
  }
}

class SonetelPowerDialerApp {
  constructor() {
    this.stages = [
      "Queued",
      "In Progress",
      "Connected / Answered",
      "No Answer / Voicemail",
      "Follow Up / Closed"
    ];
    this.leads = [];
    this.settings = {};
    this.callLogs = [];
    this.stats = {};

    // Default to the Active Dialer view so the user can immediately upload & dial
    this.currentView = "dialer";
    this.queueFilter = "all"; // 'all' | 'queued' | 'done'
    this.queuePage = 0;
    this.queuePageSize = 75; // pagination for large lists
    this.kanbanLimit = 80;

    // Active Contact & Hard-Locked Call Snapshot
    this.activeLeadId = null;
    this.dialLockedLeadId = null;
    this.dialLockedLeadSnapshot = null;

    // Call State ('idle' | 'dialing' | 'connected')
    this.callState = "idle";
    this.callSeconds = 0;
    this.callTimerInterval = null;
    this.connectTransitionTimeout = null;
    this.selectedDisposition = "Answered";
    this.dtmfDigits = "";
    this.lastDialData = null;

    // Notes debounce & queue search
    this.notesSaveTimeout = null;
    this.queueSearchTimeout = null;

    // Import state
    this.pendingImportFile = null;
    this.pendingImportPasteText = null;
    this.importColumns = [];

    // SIP/WebRTC
    this.sipClient = null;
    this.sipStatus = "disconnected";

    // Audio Engine
    this.audio = new SonetelAudioEngine();
  }

  async init() {
    this.bindKeyboardShortcuts();
    await this.loadBootstrapData();
    this.switchView("dialer");
    this.selectDisposition("Answered");

    const canvas = document.getElementById("audio-spectrum-canvas");
    this.audio.startSpectrumVisualizer(canvas, () => this.callState);
  }

  // ---------------------------------------------------------------------------
  // Deterministic Calling List Sequence (Prevents any list-jumping mid-call!)
  // ---------------------------------------------------------------------------
  getOrderedLeads() {
    // Fixed order by ID ascending so the calling list #1, #2, #3 never jumps around
    return [...this.leads].sort((a, b) => a.id - b.id);
  }

  getLeadById(id) {
    if (id == null) return null;
    return this.leads.find((l) => Number(l.id) === Number(id)) || null;
  }

  getDisplayedLead() {
    // Hard-lock guarantee: while a call is dialing or connected, always return the locked person
    if (this.callState !== "idle" && this.dialLockedLeadId != null) {
      const liveMatch = this.getLeadById(this.dialLockedLeadId);
      if (liveMatch) {
        this.dialLockedLeadSnapshot = JSON.parse(JSON.stringify(liveMatch));
        return liveMatch;
      }
      if (this.dialLockedLeadSnapshot) {
        return this.dialLockedLeadSnapshot;
      }
    }

    const active = this.getLeadById(this.activeLeadId);
    if (active) return active;

    const ordered = this.getOrderedLeads();
    if (ordered.length > 0) {
      const firstQueued = ordered.find((l) => l.stage === "Queued" || l.stage === "In Progress") || ordered[0];
      this.activeLeadId = firstQueued.id;
      return firstQueued;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap & State Synchronization
  // ---------------------------------------------------------------------------
  async loadBootstrapData() {
    const container = document.getElementById("dialer-up-next-list");
    if (container) {
      container.innerHTML = `<div class="p-4 space-y-3 animate-pulse"><div class="h-12 rounded-[12px] bg-[var(--surface-2)]"></div><div class="h-12 rounded-[12px] bg-[var(--surface-2)]"></div><div class="h-12 rounded-[12px] bg-[var(--surface-2)]"></div></div>`;
    }
    try {
      const res = await fetch("/api/bootstrap?limit=500", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== "object") throw new Error("Invalid bootstrap payload");
      this.settings = data.settings || {};
      this.leads = Array.isArray(data.leads) ? data.leads : [];
      this.callLogs = data.calls || data.call_logs || [];
      this.stats = data.stats || {};
      if (data.stages) this.stages = data.stages;

      const ordered = this.getOrderedLeads();
      if (!this.activeLeadId || !this.getLeadById(this.activeLeadId)) {
        const firstQueued = ordered.find((l) => l.stage === "Queued") || ordered[0];
        this.activeLeadId = firstQueued ? firstQueued.id : null;
      }

      this.applyTheme(this.settings.theme || "dark");
      this.syncModeControlsUI();
      this.populateCallerIdSelects();
      this.populateSettingsForms();
      this.renderAll();

      const healthDot = document.getElementById("header-health-dot");
      const healthText = document.getElementById("header-health-text");
      if (healthDot) { healthDot.className = "w-2 h-2 rounded-full bg-emerald-500"; }
      if (healthText) { healthText.textContent = `${this.leads.length} contacts · Live`; }
    } catch (err) {
      console.error("Failed to bootstrap:", err);
      this.showToast(`Failed to load: ${err.message}. Retrying in 3s`, "error");
      const healthDot = document.getElementById("header-health-dot");
      const healthText = document.getElementById("header-health-text");
      if (healthDot) healthDot.className = "w-2 h-2 rounded-full bg-red-500 animate-pulse";
      if (healthText) healthText.textContent = "Offline — retrying";
      setTimeout(() => this.loadBootstrapData(), 3000);
    }
  }

  renderAll() {
    this.updateTopBadges();
    this.renderKanban();
    this.renderActiveDialer();
    this.renderUpNextQueue();
    this.renderCallHistory();
  }

  updateTopBadges() {
    const total = this.leads.length;
    const queuedCount = this.leads.filter((l) => l.stage === "Queued" || l.stage === "In Progress").length;

    const navPipe = document.getElementById("nav-badge-pipeline");
    const navQueued = document.getElementById("nav-badge-queued");
    const navHist = document.getElementById("nav-badge-history");
    const pipePill = document.getElementById("pipeline-total-pill");

    if (navPipe) navPipe.textContent = total;
    if (navQueued) navQueued.textContent = queuedCount;
    if (navHist) navHist.textContent = this.callLogs.length;
    if (pipePill) pipePill.textContent = `${total} Contacts`;
  }

  // ---------------------------------------------------------------------------
  // View Navigation
  // ---------------------------------------------------------------------------
  switchView(viewName) {
    this.currentView = viewName;
    const views = ["dialer", "pipeline", "history", "settings"];
    views.forEach((v) => {
      const section = document.getElementById(`view-${v}`);
      const btn = document.getElementById(`nav-btn-${v}`);
      if (section) {
        section.classList.toggle("hidden", v !== viewName);
      }
      if (btn) {
        btn.classList.toggle("active", v === viewName);
      }
    });

    if (viewName === "dialer") {
      this.renderActiveDialer();
      this.renderUpNextQueue();
    } else if (viewName === "pipeline") {
      this.renderKanban();
    } else if (viewName === "history") {
      this.renderCallHistory();
    } else if (viewName === "settings") {
      this.populateSettingsForms();
    }
  }

  // ---------------------------------------------------------------------------
  // Theme Management (Dark / Light)
  // ---------------------------------------------------------------------------
  applyTheme(theme) {
    const html = document.documentElement;
    const darkIcon = document.getElementById("theme-icon-dark");
    const lightIcon = document.getElementById("theme-icon-light");

    if (theme === "light") {
      html.classList.remove("dark");
      html.classList.add("light");
      if (darkIcon) darkIcon.classList.add("hidden");
      if (lightIcon) lightIcon.classList.remove("hidden");
    } else {
      html.classList.remove("light");
      html.classList.add("dark");
      if (darkIcon) darkIcon.classList.remove("hidden");
      if (lightIcon) lightIcon.classList.add("hidden");
    }
  }

  async toggleTheme() {
    const nextTheme = (this.settings.theme || "dark") === "dark" ? "light" : "dark";
    this.settings.theme = nextTheme;
    this.applyTheme(nextTheme);
    await this.persistSettings({ theme: nextTheme }, false);
  }

  // ---------------------------------------------------------------------------
  // Sound Cue Toggle ("Ting" Chime On/Off)
  // ---------------------------------------------------------------------------
  toggleSoundCue() {
    this.audio.soundEnabled = !this.audio.soundEnabled;
    const label = document.getElementById("sound-toggle-label");
    const btn = document.getElementById("btn-sound-toggle");
    if (this.audio.soundEnabled) {
      if (label) label.textContent = "🔔 Ting Sound: ON";
      if (btn) btn.className = "px-2.5 py-1 rounded-lg app-elevated border text-[11px] font-medium text-emerald-400 flex items-center gap-1";
      this.audio.playTingSound("dial");
    } else {
      if (label) label.textContent = "🔕 Sound: Muted";
      if (btn) btn.className = "px-2.5 py-1 rounded-lg app-elevated border text-[11px] font-medium app-text-muted flex items-center gap-1";
    }
  }

  // ---------------------------------------------------------------------------
  // Single Slider Calling Method Toggle: "Call Back" vs "Internet (VoIP)"
  // ---------------------------------------------------------------------------
  async setCallingMode(mode) {
    if (mode !== "callback" && mode !== "voip") return;
    this.settings.calling_mode = mode;
    this.syncModeControlsUI();
    this.renderActiveDialer();
    this.audio.playTingSound("dial");

    await this.persistSettings({ calling_mode: mode }, false);
    const label = mode === "callback" ? "📞 Carrier Call Back Mode" : "📡 Internet (VoIP) Mode";
    this.showToast(`Switched to ${label}`, "info");
  }

  async setVoipSubMethod(subMethod) {
    this.settings.voip_method = subMethod;
    this.syncModeControlsUI();
    this.renderActiveDialer();
    await this.persistSettings({ voip_method: subMethod }, false);
  }

  syncModeControlsUI() {
    const mode = this.settings.calling_mode || "callback";
    const voipMethod = this.settings.voip_method || "webrtc";

    document.body.setAttribute("data-active-mode", mode);

    const slider = document.getElementById("calling-mode-slider");
    if (slider) {
      slider.setAttribute("data-mode", mode);
      slider.setAttribute("aria-checked", mode === "voip" ? "true" : "false");
    }

    const badge = document.getElementById("active-mode-badge");
    const badgeDot = document.getElementById("active-mode-badge-dot");
    const badgeText = document.getElementById("active-mode-badge-text");
    const voipSubContainer = document.getElementById("voip-submethod-container");
    const phoneModeTag = document.getElementById("phone-screen-mode-tag");

    if (mode === "callback") {
      if (badge) {
        badge.className = "hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[var(--accent-soft)] text-[var(--accent)] border";
      }
      if (badgeDot) badgeDot.className = "w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse";
      if (badgeText) badgeText.textContent = "Callback";
      if (voipSubContainer) {
        voipSubContainer.classList.add("hidden");
        voipSubContainer.classList.remove("flex");
      }
      if (phoneModeTag) {
        phoneModeTag.textContent = "Callback";
        phoneModeTag.className = "text-[var(--accent)] font-medium";
      }
    } else {
      if (badge) {
        badge.className = "hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[var(--accent-2-soft)] text-[var(--accent-2)] border";
      }
      if (badgeDot) badgeDot.className = "w-1.5 h-1.5 rounded-full bg-[var(--accent-2)] animate-pulse";
      if (badgeText) {
        badgeText.textContent = voipMethod === "webrtc" ? "VoIP • WebRTC" : "VoIP • SIP";
      }
      if (voipSubContainer) {
        voipSubContainer.classList.remove("hidden");
        voipSubContainer.classList.add("flex");
      }
      if (phoneModeTag) {
        phoneModeTag.textContent = voipMethod === "webrtc" ? "VoIP Headset" : "VoIP SIP";
        phoneModeTag.className = "text-[var(--accent-2)] font-medium";
      }
    }

    const btnWebrtc = document.getElementById("voip-opt-webrtc");
    const btnSip = document.getElementById("voip-opt-sip");
    if (btnWebrtc && btnSip) {
      if (voipMethod === "webrtc") {
        btnWebrtc.className = "text-[11px] px-2 py-1 rounded-full font-semibold bg-[var(--accent)] text-white";
        btnSip.className = "text-[11px] px-2 py-1 rounded-full font-medium opacity-60 hover:opacity-100";
      } else {
        btnSip.className = "text-[11px] px-2 py-1 rounded-full font-semibold bg-[var(--accent)] text-white";
        btnWebrtc.className = "text-[11px] px-2 py-1 rounded-full font-medium opacity-60 hover:opacity-100";
      }
    }

    const dCb = document.getElementById("drawer-mode-callback");
    const dVoip = document.getElementById("drawer-mode-voip");
    if (dCb && dVoip) {
      if (mode === "callback") {
        dCb.className = "py-2 rounded-full border font-semibold bg-[var(--text-primary)] text-[var(--bg)]";
        dVoip.className = "py-2 rounded-full border font-medium opacity-60";
      } else {
        dVoip.className = "py-2 rounded-full border font-semibold bg-[var(--text-primary)] text-[var(--bg)]";
        dCb.className = "py-2 rounded-full border font-medium opacity-60";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // COLUMN 1 (LEFT): Calling List Queue with Filter & Search — Logic Hard
  // ---------------------------------------------------------------------------
  setQueueFilter(filter) {
    this.queueFilter = filter;
    this.queuePage = 0;
    ["all", "queued", "done"].forEach((f) => {
      const btn = document.getElementById(`qfilter-${f}`);
      if (btn) {
        if (f === filter) {
          btn.className = "flex-1 py-1.5 rounded-full bg-[var(--surface-1)] shadow-sm font-semibold border";
        } else {
          btn.className = "flex-1 py-1.5 rounded-full opacity-60 hover:opacity-100 font-medium";
        }
      }
    });
    this.renderUpNextQueue();
  }

  debouncedQueueSearch() {
    if (this.queueSearchTimeout) clearTimeout(this.queueSearchTimeout);
    this.queueSearchTimeout = setTimeout(() => {
      this.queuePage = 0;
      this.renderUpNextQueue();
    }, 250);
  }

  changeQueuePage(dir) {
    this.queuePage = Math.max(0, this.queuePage + dir);
    this.renderUpNextQueue();
  }

  renderUpNextQueue() {
    const container = document.getElementById("dialer-up-next-list");
    const badge = document.getElementById("dialer-queue-count-badge");
    if (!container) return;

    const ordered = this.getOrderedLeads();
    const remainingCount = ordered.filter((l) => l.stage === "Queued" || l.stage === "In Progress").length;
    if (badge) {
      badge.textContent = `${remainingCount} to call / ${ordered.length} total`;
    }

    const searchInput = document.getElementById("queue-search-input");
    const query = ((searchInput && searchInput.value) || "").trim().toLowerCase();

    const displayedLead = this.getDisplayedLead();
    const currentId = displayedLead ? displayedLead.id : null;

    const filtered = ordered.filter((lead, idx) => {
      lead._listNumber = idx + 1;
      if (this.queueFilter === "queued") {
        if (lead.stage !== "Queued" && lead.stage !== "In Progress") return false;
      } else if (this.queueFilter === "done") {
        if (lead.stage === "Queued" || lead.stage === "In Progress") return false;
      }
      if (query) {
        const hay = `${lead.name} ${lead.company} ${lead.phone} ${lead.role} ${lead.location}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      container.innerHTML = `
        <div class="text-center py-10 px-4 space-y-3">
          <div class="w-12 h-12 rounded-full bg-[var(--surface-2)] border flex items-center justify-center mx-auto text-[20px]">📭</div>
          <div class="font-semibold text-[13px]">No contacts match</div>
          <div class="text-[11px] opacity-60">Try a different filter or upload a list</div>
          <button onclick="window.app.openImportModal()" class="mt-2 px-4 py-2 rounded-full bg-[var(--accent)] text-white text-[11px] font-semibold">Upload List</button>
        </div>
      `;
      return;
    }

    const totalPages = Math.ceil(filtered.length / this.queuePageSize);
    if (this.queuePage >= totalPages) this.queuePage = Math.max(0, totalPages - 1);
    const start = this.queuePage * this.queuePageSize;
    const end = start + this.queuePageSize;
    const pageSlice = filtered.slice(start, end);

    const paginationHtml = filtered.length > this.queuePageSize ? `
      <div class="flex items-center justify-between gap-2 py-3 px-2 text-[11px] font-medium border-t mt-2">
        <button onclick="window.app.changeQueuePage(-1)" ${this.queuePage === 0 ? "disabled" : ""} class="px-3 py-1.5 rounded-full bg-[var(--surface-2)] border disabled:opacity-30">← Prev</button>
        <span class="font-mono-code text-[11px]">Page ${this.queuePage + 1}/${totalPages} · ${filtered.length}</span>
        <button onclick="window.app.changeQueuePage(1)" ${this.queuePage >= totalPages - 1 ? "disabled" : ""} class="px-3 py-1.5 rounded-full bg-[var(--surface-2)] border disabled:opacity-30">Next →</button>
      </div>
    ` : "";

    container.innerHTML = pageSlice.map((lead) => {
      const isSelected = Number(lead.id) === Number(currentId);
      const isLockedInCall = this.callState !== "idle" && Number(lead.id) === Number(this.dialLockedLeadId);

      let statusPill = `<span class="text-[10px] px-2 py-0.5 rounded-full bg-[var(--surface-3)] border">Queued</span>`;
      if (isLockedInCall) {
        statusPill = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--accent)] text-white animate-pulse">📞 On Call</span>`;
      } else if (lead.stage === "Connected / Answered") {
        statusPill = `<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 border">✓ Answered</span>`;
      } else if (lead.stage === "No Answer / Voicemail") {
        statusPill = `<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-700 border">No Answer</span>`;
      } else if (lead.stage === "Follow Up / Closed") {
        statusPill = `<span class="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-600 border">${this.escapeHtml(lead.last_disposition || "Closed")}</span>`;
      } else if (lead.stage === "In Progress") {
        statusPill = `<span class="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-2-soft)] text-[var(--accent-2)] border">In Progress</span>`;
      }

      return `
        <div onclick="window.app.selectLeadFromQueue(${lead.id})" class="queue-item ${isSelected ? "selected" : ""}">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="queue-num">#${lead._listNumber}</span>
              <span class="text-[13px] font-semibold truncate">${this.escapeHtml(lead.name)}</span>
            </div>
            ${statusPill}
          </div>
          <div class="flex items-center justify-between gap-2 mt-1.5 text-[11px]">
            <span class="opacity-60 truncate">${this.escapeHtml(lead.company || lead.role || "Direct")}</span>
            <span class="font-mono-code font-medium text-[var(--accent)] shrink-0">${this.escapeHtml(lead.phone)}</span>
          </div>
        </div>
      `;
    }).join("") + paginationHtml;
  }

  selectLeadFromQueue(leadId) {
    if (this.callState !== "idle" && Number(leadId) !== Number(this.dialLockedLeadId)) {
      this.showToast("Finish or end the current call first so on-screen contact info stays locked.", "warning");
      return;
    }
    this.activeLeadId = Number(leadId);
    this.renderActiveDialer();
    this.renderUpNextQueue();
  }

  stepLead(direction) {
    if (this.callState !== "idle") {
      this.showToast("Active call in progress — end or log outcome before switching person.", "warning");
      return;
    }
    const ordered = this.getOrderedLeads();
    if (!ordered.length) return;

    const currentIdx = ordered.findIndex((l) => Number(l.id) === Number(this.activeLeadId));
    let nextIdx = currentIdx + direction;
    if (nextIdx < 0) nextIdx = ordered.length - 1;
    if (nextIdx >= ordered.length) nextIdx = 0;

    this.activeLeadId = ordered[nextIdx].id;
    this.renderActiveDialer();
    this.renderUpNextQueue();
  }

  // ---------------------------------------------------------------------------
  // COLUMN 2 & 3: Complete Contact Dossier + Real Phone Handset
  // ---------------------------------------------------------------------------
  renderActiveDialer() {
    const lead = this.getDisplayedLead();
    const ordered = this.getOrderedLeads();

    const posEl = document.getElementById("dialer-position-indicator");
    const lockBadge = document.getElementById("dialer-lock-badge");
    const nameEl = document.getElementById("dialer-lead-name");
    const phoneScreenNameEl = document.getElementById("phone-screen-person-name");
    const notesLabelEl = document.getElementById("notes-contact-name-label");
    const companyEl = document.getElementById("dialer-lead-company");
    const roleEl = document.getElementById("dialer-lead-role");
    const stageEl = document.getElementById("dialer-lead-stage-badge");
    const prioEl = document.getElementById("dialer-lead-priority-badge");
    const attemptsEl = document.getElementById("dialer-lead-attempts");
    const lastDispEl = document.getElementById("dialer-lead-last-disp");
    const phoneEl = document.getElementById("dialer-lead-phone");
    const rawPhoneEl = document.getElementById("dialer-lead-rawphone");
    const localTimeEl = document.getElementById("dialer-lead-localtime");
    const emailEl = document.getElementById("dialer-lead-email");
    const notesEl = document.getElementById("dialer-notes-textarea");
    const telLink = document.getElementById("dialer-native-tel-link");
    const fieldsGrid = document.getElementById("dialer-all-fields-grid");
    const fieldsBadge = document.getElementById("dialer-fields-count-badge");
    const contactHistoryStrip = document.getElementById("dialer-contact-history-strip");

    if (!lead) {
      if (posEl) posEl.textContent = "0 of 0";
      if (nameEl) nameEl.textContent = "No Calling List Loaded";
      if (phoneScreenNameEl) phoneScreenNameEl.textContent = "No Contact Selected";
      if (companyEl) companyEl.textContent = "Click 'Upload Calling List' above";
      if (roleEl) roleEl.textContent = "";
      if (phoneEl) phoneEl.textContent = "—";
      if (rawPhoneEl) rawPhoneEl.textContent = "";
      if (notesEl) notesEl.value = "";
      if (fieldsGrid) {
        fieldsGrid.innerHTML = `<div class="col-span-2 text-xs app-text-muted py-4 text-center">Upload a CSV or Excel list to see all contact fields here.</div>`;
      }
      return;
    }

    const idx = ordered.findIndex((l) => Number(l.id) === Number(lead.id));
    if (posEl) {
      posEl.textContent = `Person ${idx >= 0 ? idx + 1 : 1} of ${ordered.length}`;
    }

    if (lockBadge) {
      if (this.callState !== "idle") {
        lockBadge.textContent = `🔒 Locked On Call: ${lead.name}`;
        lockBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/25 text-emerald-300 border border-emerald-400/50 animate-pulse";
      } else {
        lockBadge.textContent = "🔒 Info Locked on Screen";
        lockBadge.className = "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30";
      }
    }

    if (nameEl) nameEl.textContent = lead.name;
    if (phoneScreenNameEl) phoneScreenNameEl.textContent = lead.name;
    if (notesLabelEl) notesLabelEl.textContent = lead.name;
    if (companyEl) companyEl.textContent = lead.company || "Independent Contact";
    if (roleEl) roleEl.textContent = lead.role || "Prospect";
    if (stageEl) stageEl.textContent = lead.stage;
    if (prioEl) prioEl.textContent = `${lead.priority || "Medium"} Priority`;
    if (attemptsEl) attemptsEl.textContent = `Calls: ${lead.attempts || 0}`;

    if (lastDispEl) {
      if (lead.last_disposition) {
        lastDispEl.classList.remove("hidden");
        lastDispEl.textContent = `Last: ${lead.last_disposition}`;
      } else {
        lastDispEl.classList.add("hidden");
      }
    }

    if (phoneEl) phoneEl.textContent = lead.phone;
    if (rawPhoneEl) rawPhoneEl.textContent = `Uploaded Raw: ${lead.raw_phone || lead.phone}`;
    if (telLink) telLink.href = `tel:${lead.phone}`;

    const localClock = this.computeLocalTimeForPhone(lead.phone, lead.location);
    if (localTimeEl) localTimeEl.textContent = `🕒 ${localClock}`;
    if (emailEl) emailEl.textContent = lead.email || "";

    if (notesEl && document.activeElement !== notesEl) {
      notesEl.value = lead.notes || "";
    }

    // Render 100% of Contact Information + Uploaded Spreadsheet Columns
    if (fieldsGrid) {
      const standardEntries = [
        ["Full Name", lead.name],
        ["Phone (E.164)", lead.phone],
        ["Raw Phone", lead.raw_phone || lead.phone],
        ["Company", lead.company],
        ["Role / Title", lead.role],
        ["Email", lead.email],
        ["Location", lead.location],
        ["Priority", lead.priority]
      ];

      let customObj = {};
      if (lead.custom_fields_parsed && typeof lead.custom_fields_parsed === "object") {
        customObj = lead.custom_fields_parsed;
      } else if (lead.custom_fields) {
        try {
          customObj = JSON.parse(lead.custom_fields);
        } catch (_) {}
      }

      const seenKeys = new Set();
      const allCards = [];

      const addFieldCard = (key, val, isCustom = false) => {
        if (val === undefined || val === null || String(val).trim() === "") return;
        const normKey = String(key).trim().toLowerCase();
        if (seenKeys.has(normKey) || normKey === "notes") return;
        seenKeys.add(normKey);

        const strVal = String(val).trim();
        const isUrl = /^https?:\/\//i.test(strVal) || /^www\./i.test(strVal);

        let valueMarkup = `<span class="field-value break-words select-all">${this.escapeHtml(strVal)}</span>`;
        if (isUrl) {
          const href = strVal.startsWith("http") ? strVal : `https://${strVal}`;
          valueMarkup = `<a href="${this.escapeHtml(href)}" target="_blank" rel="noopener" class="field-value text-[var(--accent)] hover:underline break-all">${this.escapeHtml(strVal)} ↗</a>`;
        } else if (normKey.includes("phone")) {
          valueMarkup = `<span class="field-value mono font-medium text-[var(--accent)] select-all">${this.escapeHtml(strVal)}</span>`;
        } else if (normKey.includes("deal") || normKey.includes("value") || normKey.includes("budget") || normKey.includes("price")) {
          valueMarkup = `<span class="field-value mono font-semibold bg-amber-400 text-black px-1.5 py-0.5 rounded-full text-[12px]">${this.escapeHtml(strVal)}</span>`;
        }

        allCards.push(`
          <div class="field-card flex flex-col justify-between ${isCustom ? "custom" : ""}">
            <div class="field-label flex items-center justify-between">
              <span>${this.escapeHtml(key)}</span>
              ${isCustom ? `<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent-2-soft)] text-[var(--accent-2)] border">sheet</span>` : ""}
            </div>
            <div class="mt-1">${valueMarkup}</div>
          </div>
        `);
      };

      standardEntries.forEach(([k, v]) => addFieldCard(k, v, false));
      Object.entries(customObj).forEach(([k, v]) => addFieldCard(k, v, true));

      if (fieldsBadge) {
        fieldsBadge.textContent = `${allCards.length} fields`;
      }
      fieldsGrid.innerHTML = allCards.join("") || `<div class="col-span-2 text-[12px] opacity-60 py-4 text-center">No extra fields — add one below</div>`;
    }

    // Render Previous Call History for This Specific Contact
    if (contactHistoryStrip) {
      const personLogs = this.callLogs.filter((c) => Number(c.lead_id) === Number(lead.id)).slice(0, 3);
      if (!personLogs.length) {
        contactHistoryStrip.innerHTML = `<span class="app-text-muted">No previous calls logged for ${this.escapeHtml(lead.name)} yet.</span>`;
      } else {
        contactHistoryStrip.innerHTML = personLogs.map((c) => {
          const timeStr = c.created_at ? new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
          const cMode = c.call_mode || c.calling_mode;
          return `
            <div class="flex items-center justify-between text-[11px]">
              <span>📞 <b>${this.escapeHtml(c.disposition)}</b> (${this.formatSeconds(c.duration_seconds || 0)}) via ${cMode === "voip" ? "Internet VoIP" : "Call Back"}</span>
              <span class="font-mono-code app-text-muted">${timeStr}</span>
            </div>
          `;
        }).join("");
      }
    }

    // Update Routing Preview & API Inspector
    const mode = this.settings.calling_mode || "callback";
    const voipMethod = this.settings.voip_method || "webrtc";
    const agentPhone = this.settings.agent_phone || "+14155550199";
    const sipUri = this.settings.sip_uri || "sip:agent@sonetel.com";

    const rCall1 = document.getElementById("dialer-route-call1");
    const rBridge = document.getElementById("dialer-route-bridge");
    const rCall2 = document.getElementById("dialer-route-call2");

    if (mode === "callback") {
      if (rCall1) rCall1.textContent = agentPhone;
      if (rBridge) rBridge.textContent = "sonetel.com (Callback)";
      if (rCall2) rCall2.textContent = lead.phone;
    } else {
      if (rCall1) rCall1.textContent = voipMethod === "webrtc" ? "Headset (WebRTC)" : sipUri;
      if (rBridge) rBridge.textContent = "sonetel.com (VoIP)";
      if (rCall2) rCall2.textContent = lead.phone;
    }

    const autoCheck = document.getElementById("auto-dial-next-checkbox");
    if (autoCheck) {
      autoCheck.checked = String(this.settings.auto_advance) === "true";
    }

    this.updateDialButtonUI();
    this.updateApiInspectorPreview(lead);
  }

  // ---------------------------------------------------------------------------
  // Add Custom Field Inline on the Dialer Screen
  // ---------------------------------------------------------------------------
  async addQuickCustomField() {
    const lead = this.getDisplayedLead();
    if (!lead) return;

    const nameInput = document.getElementById("quick-field-name");
    const valInput = document.getElementById("quick-field-value");
    const fieldName = ((nameInput && nameInput.value) || "").trim();
    const fieldValue = ((valInput && valInput.value) || "").trim();

    if (!fieldName || !fieldValue) {
      this.showToast("Enter both a field name and value", "warning");
      return;
    }

    try {
      const res = await fetch(`/api/leads/${lead.id}/fields`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_name: fieldName, field_value: fieldValue })
      });
      if (res.ok) {
        const data = await res.json();
        const idx = this.leads.findIndex((l) => Number(l.id) === Number(lead.id));
        if (idx !== -1 && data.lead) {
          this.leads[idx] = data.lead;
          if (this.dialLockedLeadId === lead.id) {
            this.dialLockedLeadSnapshot = JSON.parse(JSON.stringify(data.lead));
          }
        }
        if (nameInput) nameInput.value = "";
        if (valInput) valInput.value = "";
        this.renderActiveDialer();
        this.showToast(`Added "${fieldName}: ${fieldValue}" to ${lead.name}`, "success");
      }
    } catch (_) {
      this.showToast("Could not save custom field", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Real Phone Call Execution: Dial / Hang Up / Single "Ting" Sound
  // ---------------------------------------------------------------------------
  handlePrimaryDialClick() {
    if (this.callState === "idle") {
      this.startDialSession();
    } else {
      this.endActiveCallOnly();
    }
  }

  async startDialSession() {
    const lead = this.getDisplayedLead();
    if (!lead) {
      this.showToast("No contact selected to call", "warning");
      return;
    }

    // HARD-LOCK this contact onto the screen for the entire duration of the call
    this.activeLeadId = lead.id;
    this.dialLockedLeadId = lead.id;
    this.dialLockedLeadSnapshot = JSON.parse(JSON.stringify(lead));

    // Play a single gentle crystal "Ting" chime (NO repeating ringback tone!)
    this.audio.playTingSound("dial");

    if ((this.settings.calling_mode || "callback") === "voip") {
      await this.audio.acquireMicrophone();
    }

    this.callState = "dialing";
    this.callSeconds = 0;
    this.dtmfDigits = "";
    const dtmfDisplay = document.getElementById("dtmf-digits-display");
    if (dtmfDisplay) dtmfDisplay.textContent = "";

    this.updateDialButtonUI();
    this.renderActiveDialer();
    this.renderUpNextQueue();

    try {
      const res = await fetch("/api/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: lead.id,
          calling_mode: this.settings.calling_mode || "callback",
          voip_method: this.settings.voip_method || "webrtc",
          caller_id: this.settings.caller_id || ""
        })
      });
      const data = await res.json();

      const idx = this.leads.findIndex((l) => Number(l.id) === Number(lead.id));
      if (idx !== -1) {
        this.leads[idx].stage = "In Progress";
        this.leads[idx].attempts = (this.leads[idx].attempts || 0) + 1;
      }

      // WebRTC SIP attempt if in voip/webrtc mode
      let sipAttempted = false;
      if ((this.settings.calling_mode || "callback") === "voip" && (this.settings.voip_method || "webrtc") === "webrtc") {
        try {
          const sipReady = await this.ensureSipReady();
          if (sipReady) {
            sipAttempted = await this.makeWebRtcSipCall(lead.phone);
            if (sipAttempted) {
              this.showToast(`📡 WebRTC SIP calling ${lead.name} — connecting via ${this.settings.sip_wss_server}...`, "info");
            }
          }
        } catch (e) {
          console.warn("SIP attempt failed, falling back to simulation", e);
        }
      }

      const inspector = document.getElementById("sonetel-api-inspector");
      if (inspector) {
        inspector.textContent = JSON.stringify(
          {
            locked_contact: lead.name,
            target_phone_e164: lead.phone,
            sonetel_endpoint: data.endpoint,
            calling_mode: data.calling_mode,
            voip_method: data.voip_method,
            is_simulated: data.is_simulated,
            has_live_token: data.has_live_token,
            sip_attempted: sipAttempted,
            sip_status: this.sipStatus,
            live_error: data.live_error || data.response_payload?.live_error || null,
            request_payload: data.request_payload,
            response: data.response_payload || data.sonetel_response
          },
          null,
          2
        );
      }

      // Improved error handling: show if live token present but fallback to simulated
      if (data.is_simulated && data.has_live_token && data.live_error) {
        this.showToast(`⚠️ Live Sonetel call failed: ${data.live_error}. Using local simulation — check credentials & account balance.`, "warning");
      } else if (data.is_simulated && data.has_live_token) {
        this.showToast(`Calling ${lead.name} in simulation (live token present but ${data.calling_mode} uses WebRTC path)`, "info");
      } else if (data.is_simulated) {
        this.showToast(`📞 Calling ${lead.name} (${lead.phone}) in local bridge mode — ready to talk!`, "success");
      } else {
        this.showToast(`✅ Live call connected to ${lead.name} via Sonetel!`, "success");
      }

      // Store last dial payload for complete call logging
      this.lastDialData = data;

      if (this.connectTransitionTimeout) clearTimeout(this.connectTransitionTimeout);
      this.connectTransitionTimeout = setTimeout(() => {
        if (this.callState === "dialing") {
          this.callState = "connected";
          this.audio.playTingSound("connect");
          this.startCallTimer();
          this.updateDialButtonUI();
          this.renderActiveDialer();
          this.renderUpNextQueue();
          // Update call pop live badge
          const liveBadge = document.getElementById("call-pop-live-badge");
          const dialBadge = document.getElementById("call-pop-dialing-badge");
          if (liveBadge) liveBadge.classList.remove("hidden");
          if (dialBadge) dialBadge.classList.add("hidden");
        }
      }, 1400);
    } catch (err) {
      console.error("Dial error:", err);
      this.callState = "idle";
      this.dialLockedLeadId = null;
      this.dialLockedLeadSnapshot = null;
      this.updateDialButtonUI();
      this.showToast("Failed to initiate call", "error");
    }
  }

  startCallTimer() {
    if (this.callTimerInterval) clearInterval(this.callTimerInterval);
    this.callSeconds = 0;
    const timerEl = document.getElementById("call-timer-display");
    const popTimer = document.getElementById("call-pop-timer");
    if (timerEl) timerEl.textContent = "00:00";
    if (popTimer) popTimer.textContent = "00:00";

    this.callTimerInterval = setInterval(() => {
      this.callSeconds += 1;
      const fmt = this.formatSeconds(this.callSeconds);
      if (timerEl) timerEl.textContent = fmt;
      const pt = document.getElementById("call-pop-timer");
      if (pt) pt.textContent = fmt;
      const btnText = document.getElementById("btn-primary-dial-text");
      if (btnText && this.callState === "connected") {
        const lead = this.getDisplayedLead();
        btnText.textContent = `End Call — ${fmt}${lead ? ` · ${lead.name.split(" ")[0]}` : ""}`;
      }
    }, 1000);
  }

  stopCallTimer() {
    if (this.connectTransitionTimeout) {
      clearTimeout(this.connectTransitionTimeout);
      this.connectTransitionTimeout = null;
    }
    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
  }

  endActiveCallOnly() {
    this.stopCallTimer();
    this.audio.playTingSound("end");
    if (this.audio.isRecording) {
      this.toggleCallRecording();
    }
    this.hangupSipCall();
    const finishedLead = this.getDisplayedLead();
    this.callState = "idle";
    this.dialLockedLeadId = null;
    this.dialLockedLeadSnapshot = null;
    this.updateDialButtonUI();
    this.renderActiveDialer();
    this.renderUpNextQueue();
    if (finishedLead) {
      this.showToast(`Call with ${finishedLead.name} ended (${this.formatSeconds(this.callSeconds)}). Click 'Save Outcome & Load Next Person' below.`, "info");
    }
  }

  updateDialButtonUI() {
    const btn = document.getElementById("btn-primary-dial");
    const btnText = document.getElementById("btn-primary-dial-text");
    const stateLabel = document.getElementById("call-state-label");
    const lead = this.getDisplayedLead();
    const personName = lead ? lead.name.split(" ")[0] : "Contact";

    if (!btn || !btnText) return;

    const base = "w-full py-4 rounded-[14px] font-semibold text-[14px] flex items-center justify-center gap-2 transition-all";

    if (this.callState === "idle") {
      btn.className = `${base} bg-[var(--accent)] text-white hover:opacity-90 shadow-sm`;
      btnText.textContent = `Call ${personName}`;
      if (stateLabel) {
        stateLabel.textContent = "Ready";
        stateLabel.className = "text-[10px] font-medium opacity-60 uppercase tracking-widest";
      }
    } else if (this.callState === "dialing") {
      btn.className = `${base} bg-amber-500 text-black hover:bg-amber-400 animate-pulse`;
      btnText.textContent = `Dialing ${personName}… Tap to End`;
      if (stateLabel) {
        stateLabel.textContent = "Dialing…";
        stateLabel.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-400 text-black animate-pulse";
      }
    } else if (this.callState === "connected") {
      btn.className = `${base} bg-[#0F0F10] text-white border border-white/20 hover:bg-zinc-900`;
      btnText.textContent = `End Call — ${this.formatSeconds(this.callSeconds)}`;
      if (stateLabel) {
        stateLabel.textContent = "● Connected";
        stateLabel.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-white";
      }
    }
    // Show professional call pop like Kixie / PhoneBurner
    this.showCallPop();
  }

  // ---------------------------------------------------------------------------
  // PROFESSIONAL CALL POP — Screen Pop on Dial (Kixie / PhoneBurner / Ringover style)
  // Instant context from Excel/CSV upload when call connects
  // ---------------------------------------------------------------------------
  showCallPop() {
    const lead = this.getDisplayedLead();
    if (!lead) return;
    const overlay = document.getElementById("call-pop-overlay");
    if (!overlay) return;

    // Populate header
    const initials = (lead.name || "?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
    const avatar = document.getElementById("call-pop-avatar");
    if (avatar) avatar.textContent = initials;

    const nameEl = document.getElementById("call-pop-name");
    if (nameEl) nameEl.textContent = lead.name || "Unknown";
    const compEl = document.getElementById("call-pop-company");
    if (compEl) compEl.textContent = lead.company || "Independent";
    const roleEl = document.getElementById("call-pop-role");
    if (roleEl) roleEl.textContent = lead.role || "Prospect";
    const phoneEl = document.getElementById("call-pop-phone");
    if (phoneEl) phoneEl.textContent = lead.phone || "";
    const rawEl = document.getElementById("call-pop-rawphone");
    if (rawEl) rawEl.textContent = `Raw: ${lead.raw_phone || lead.phone || ""}`;
    const timerEl = document.getElementById("call-pop-timer");
    if (timerEl) timerEl.textContent = this.formatSeconds(this.callSeconds);
    const modeEl = document.getElementById("call-pop-mode");
    if (modeEl) {
      const m = (this.settings.calling_mode || "callback") === "voip" ? "VoIP" : "Callback";
      const cid = this.settings.caller_id || "+1 415…";
      modeEl.textContent = `${m} via ${cid}`;
    }
    const locBadge = document.getElementById("call-pop-location-badge");
    if (locBadge) {
      const lt = this.computeLocalTimeForPhone(lead.phone, lead.location);
      locBadge.textContent = lt || lead.location || "";
    }

    // Badges
    const liveBadge = document.getElementById("call-pop-live-badge");
    const dialBadge = document.getElementById("call-pop-dialing-badge");
    if (liveBadge && dialBadge) {
      if (this.callState === "connected") {
        liveBadge.classList.remove("hidden");
        dialBadge.classList.add("hidden");
      } else {
        liveBadge.classList.add("hidden");
        dialBadge.classList.remove("hidden");
      }
    }

    // Parse custom fields (Excel columns)
    let customObj = {};
    try {
      if (lead.custom_fields_parsed && typeof lead.custom_fields_parsed === "object") customObj = lead.custom_fields_parsed;
      else if (lead.custom_fields) customObj = JSON.parse(lead.custom_fields);
    } catch(_) {}

    // Overview fields (standard + some custom)
    const overviewGrid = document.getElementById("call-pop-fields-grid");
    if (overviewGrid) {
      const entries = [
        ["Phone", lead.phone, true],
        ["Company", lead.company],
        ["Role", lead.role],
        ["Email", lead.email],
        ["Location", lead.location],
        ["Priority", lead.priority],
        ["Attempts", String(lead.attempts || 0)],
        ["Stage", lead.stage],
      ];
      // Add first 4 custom fields to overview
      Object.entries(customObj).slice(0,4).forEach(([k,v])=> entries.push([k, v, false, true]));
      overviewGrid.innerHTML = entries.filter(([,v])=> v && String(v).trim()).map(([k,v,isMono,isCustom])=> {
        const mono = isMono ? "font-mono-code font-medium text-[var(--accent)]" : "font-medium";
        const badge = isCustom ? `<span class="ml-1 text-[9px] px-1 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border">Excel</span>` : "";
        return `<div class="field-card"><div class="field-label flex items-center">${this.escapeHtml(k)}${badge}</div><div class="mt-1 text-[13px] ${mono} break-all">${this.escapeHtml(String(v))}</div></div>`;
      }).join("") || `<div class="col-span-2 text-[12px] opacity-60">No extra details</div>`;
    }

    // Excel grid — 100% of uploaded columns
    const excelGrid = document.getElementById("call-pop-excel-grid");
    const excelCount = document.getElementById("call-pop-excel-count");
    if (excelGrid) {
      const allCustom = Object.entries(customObj);
      if (excelCount) excelCount.textContent = String(allCustom.length);
      if (!allCustom.length) {
        excelGrid.innerHTML = `<div class="col-span-2 text-center py-6 space-y-2"><div class="text-[13px] font-medium">No Excel columns — this contact is from sample data</div><div class="text-[11px] opacity-60">Upload your own CSV/Excel to see all columns here instantly on every call</div></div>`;
      } else {
        excelGrid.innerHTML = allCustom.map(([k,v])=> {
          const str = String(v||"").trim();
          const isUrl = /^https?:\/\//.test(str);
          let valHtml = this.escapeHtml(str);
          if (isUrl) valHtml = `<a href="${this.escapeHtml(str)}" target="_blank" class="text-[var(--accent)] underline">${this.escapeHtml(str)} ↗</a>`;
          return `<div class="field-card custom"><div class="field-label">${this.escapeHtml(k)}</div><div class="mt-1 text-[12px] font-medium break-all">${valHtml}</div></div>`;
        }).join("");
      }
    }

    // History
    const histList = document.getElementById("call-pop-history-list");
    if (histList) {
      const logs = this.callLogs.filter(c=> Number(c.lead_id)===Number(lead.id)).slice(0,5);
      if (!logs.length) {
        histList.innerHTML = `<div class="text-[12px] opacity-60 py-4 text-center">No previous calls for ${this.escapeHtml(lead.name)} — first touch!</div>`;
      } else {
        histList.innerHTML = logs.map(l=> `<div class="flex justify-between items-center p-2.5 rounded-[10px] border bg-[var(--surface-2)] text-[11px]"><span><b>${this.escapeHtml(l.disposition)}</b> · ${this.formatSeconds(l.duration_seconds||0)} · ${(l.call_mode||l.calling_mode)==='voip'?'VoIP':'Callback'}</span><span class="font-mono-code opacity-60">${l.created_at ? new Date(l.created_at).toLocaleTimeString() : ""}</span></div>`).join("");
      }
    }

    // Notes sync
    const notesEl = document.getElementById("call-pop-notes");
    const mainNotes = document.getElementById("dialer-notes-textarea");
    if (notesEl) {
      notesEl.value = (mainNotes && mainNotes.value) || lead.notes || "";
    }

    // Show
    overlay.classList.remove("hidden");
    this.switchCallPopTab('overview');
  }

  hideCallPop() {
    const overlay = document.getElementById("call-pop-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  switchCallPopTab(tab) {
    const panes = ["overview","excel","history"];
    panes.forEach(p=> {
      const pane = document.getElementById(`call-pop-pane-${p}`);
      const btn = document.getElementById(`call-pop-tab-${p}`);
      if (pane) pane.classList.toggle("hidden", p!==tab);
      if (btn) {
        if (p===tab) btn.className = "px-3 py-1.5 rounded-full bg-[var(--surface-1)] shadow-sm font-semibold border";
        else btn.className = "px-3 py-1.5 rounded-full opacity-60 hover:opacity-100";
      }
    });
  }

  handleCallPopNotes(val) {
    const main = document.getElementById("dialer-notes-textarea");
    if (main) {
      main.value = val;
      this.handleNotesInput(val);
    }
  }

  copyCallPopPhone() {
    this.copyActivePhone();
  }

  handleCallPopPrimary() {
    this.hideCallPop();
    this.hangUpAndMoveToNext();
  }

  // ---------------------------------------------------------------------------
  // Handset Utilities: Copy Number, Mute, DTMF Keypad, Audio Memo Recording
  // ---------------------------------------------------------------------------
  copyActivePhone() {
    const lead = this.getDisplayedLead();
    if (!lead || !lead.phone) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(lead.phone).catch(() => {});
    }
    this.showToast(`Copied ${lead.phone}`, "info");
  }

  toggleMute() {
    const muted = this.audio.toggleMicMute();
    const ind = document.getElementById("mute-mic-indicator");
    const btn = document.getElementById("btn-mute-mic");
    if (ind) ind.textContent = muted ? "🔇 Muted" : "🎙️ Mic";
    if (btn) {
      btn.className = muted
        ? "py-2 px-2 rounded-xl border border-amber-500/40 bg-amber-500/15 text-amber-300 font-semibold text-center transition-colors"
        : "py-2 px-2 rounded-xl app-elevated border hover:border-zinc-400/40 app-text-secondary font-medium text-center transition-colors";
    }
  }

  toggleKeypad() {
    const pop = document.getElementById("dtmf-popover");
    if (pop) pop.classList.toggle("hidden");
  }

  sendDtmf(digit) {
    this.audio.playDtmf(digit);
    this.dtmfDigits += String(digit);
    const disp = document.getElementById("dtmf-digits-display");
    if (disp) disp.textContent = this.dtmfDigits;
  }

  async toggleCallRecording() {
    const label = document.getElementById("record-call-label");
    const dot = document.getElementById("record-call-dot");
    const strip = document.getElementById("recorded-audio-strip");
    const player = document.getElementById("recorded-audio-player");

    if (!this.audio.isRecording) {
      await this.audio.acquireMicrophone();
      const started = this.audio.startRecording((audioUrl) => {
        if (strip && player) {
          player.src = audioUrl;
          strip.classList.remove("hidden");
          strip.classList.add("flex");
        }
      });
      if (started) {
        if (label) label.textContent = "Stop";
        if (dot) dot.className = "w-2 h-2 rounded-full bg-rose-500 animate-ping";
        this.showToast("Recording call audio memo...", "info");
      } else {
        this.showToast("Microphone recording unavailable in this browser context", "warning");
      }
    } else {
      this.audio.stopRecording();
      if (label) label.textContent = "Rec";
      if (dot) dot.className = "w-2 h-2 rounded-full bg-rose-500";
      this.showToast("Audio memo ready for playback", "success");
    }
  }

  // ---------------------------------------------------------------------------
  // SIP.js / JsSIP WebRTC Integration (Option A)
  // ---------------------------------------------------------------------------
  async ensureSipReady() {
    if (this.sipStatus === "connected" && this.sipClient) return true;
    if (typeof JsSIP === "undefined" && typeof SIP === "undefined") {
      console.warn("SIP libraries not loaded");
      return false;
    }

    const sipUri = this.settings.sip_uri || "";
    const wssServer = this.settings.sip_wss_server || "wss://sip.sonetel.com:443";
    const sipPass = this.settings.sip_password || this.settings.sonetel_password || "";

    if (!sipUri) {
      this.showToast("Set SIP URI in Settings for WebRTC calling", "warning");
      return false;
    }

    try {
      // Try JsSIP first (more compatible)
      if (typeof JsSIP !== "undefined") {
        const socket = new JsSIP.WebSocketInterface(wssServer);
        const uri = sipUri.startsWith("sip:") ? sipUri : `sip:${sipUri}`;
        const config = {
          uri: uri,
          password: sipPass,
          display_name: "Sonetel Dialer",
          sockets: [socket],
          register: false // don't auto-register, just make calls
        };
        // If no password, try anonymous
        if (!sipPass) {
          config.password = undefined;
          config.register = false;
        }
        this.sipClient = new JsSIP.UA(config);
        this.sipClient.on("connected", () => {
          this.sipStatus = "connected";
          console.log("JsSIP connected");
        });
        this.sipClient.on("disconnected", () => {
          this.sipStatus = "disconnected";
        });
        this.sipClient.on("registered", () => {
          this.sipStatus = "registered";
          this.showToast("SIP registered — WebRTC ready", "success");
        });
        this.sipClient.on("registrationFailed", (e) => {
          console.warn("SIP registration failed", e);
          // Still allow calls without registration for some providers
          this.sipStatus = "connected";
        });
        this.sipClient.start();
        // Wait briefly for connection
        await new Promise((r) => setTimeout(r, 800));
        return true;
      } else if (typeof SIP !== "undefined") {
        // Fallback to SIP.js
        const uri = SIP.UserAgent.makeURI(sipUri.startsWith("sip:") ? sipUri : `sip:${sipUri}`);
        if (!uri) return false;
        const userAgent = new SIP.UserAgent({
          uri: uri,
          transportOptions: {
            server: wssServer
          },
          authorizationUsername: sipUri.split("@")[0].replace("sip:", ""),
          authorizationPassword: sipPass,
          displayName: "Sonetel Dialer"
        });
        await userAgent.start();
        this.sipClient = userAgent;
        this.sipStatus = "connected";
        return true;
      }
    } catch (e) {
      console.error("SIP init failed", e);
      this.sipStatus = "failed";
      return false;
    }
    return false;
  }

  async makeWebRtcSipCall(targetPhone) {
    // Attempt to make a real SIP call via WebRTC if possible
    try {
      if (typeof JsSIP !== "undefined" && this.sipClient) {
        const target = `sip:${targetPhone.replace(/[^+0-9]/g, "")}@sip.sonetel.com`;
        const eventHandlers = {
          progress: (e) => console.log("SIP call progress", e),
          failed: (e) => console.log("SIP call failed", e),
          ended: (e) => {
            console.log("SIP call ended", e);
            if (this.callState !== "idle") {
              this.callState = "idle";
              this.updateDialButtonUI();
            }
          },
          confirmed: (e) => {
            console.log("SIP call confirmed", e);
            this.callState = "connected";
            this.startCallTimer();
            this.updateDialButtonUI();
            this.audio.playTingSound("connect");
          }
        };
        const options = {
          eventHandlers: eventHandlers,
          mediaConstraints: { audio: true, video: false },
          pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }
        };
        // Attach remote audio
        const session = this.sipClient.call(target, options);
        this.sipSession = session;

        // Create audio element for remote stream
        session.on("peerconnection", (e) => {
          const peerconnection = e.peerconnection;
          peerconnection.ontrack = (trackEvent) => {
            const remoteAudio = document.getElementById("remote-audio");
            if (remoteAudio) {
              remoteAudio.srcObject = trackEvent.streams[0];
              remoteAudio.play().catch(() => {});
            }
          };
        });

        return true;
      }
    } catch (e) {
      console.error("WebRTC SIP call error", e);
      return false;
    }
    return false;
  }

  hangupSipCall() {
    try {
      if (this.sipSession) {
        this.sipSession.terminate();
        this.sipSession = null;
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Dispositions & "Save Outcome & Load Next Person" Workflow
  // ---------------------------------------------------------------------------
  selectDisposition(disp) {
    this.selectedDisposition = disp;
    const pill = document.getElementById("selected-disposition-pill");
    if (pill) pill.textContent = `Outcome: ${disp}`;

    document.querySelectorAll(".disp-btn").forEach((btn) => {
      const bDisp = btn.getAttribute("data-disp");
      if (bDisp === disp) {
        btn.className = "disp-btn selected px-3 py-3 text-[12px] flex items-center justify-between";
      } else {
        btn.className = "disp-btn px-3 py-3 text-[12px] flex items-center justify-between";
      }
    });
  }

  async toggleAutoDialSetting(checked) {
    const val = checked ? "true" : "false";
    this.settings.auto_advance = val;
    this.settings.auto_dial_next = val;
    await this.persistSettings({ auto_advance: val, auto_dial_next: val }, false);
    this.showToast(checked ? "Auto-dial next ON — will call next person after Save" : "Auto-dial next OFF", "info");
  }

  async hangUpAndMoveToNext() {
    const lead = this.getDisplayedLead();
    if (!lead) return;

    const currentLeadId = lead.id;
    const duration = this.callSeconds;
    const notesEl = document.getElementById("dialer-notes-textarea");
    const currentNotes = notesEl ? notesEl.value : lead.notes || "";

    // Find the next person in the fixed-order Calling List BEFORE changing anything
    const ordered = this.getOrderedLeads();
    const currentIdx = ordered.findIndex((l) => Number(l.id) === Number(currentLeadId));
    let nextLead = null;
    for (let offset = 1; offset < ordered.length; offset++) {
      const candidate = ordered[(currentIdx + offset) % ordered.length];
      if (candidate.stage === "Queued" || candidate.stage === "In Progress") {
        nextLead = candidate;
        break;
      }
    }
    if (!nextLead && ordered.length > 1) {
      nextLead = ordered[(currentIdx + 1) % ordered.length];
    }

    this.stopCallTimer();
    this.audio.playTingSound("end");
    this.callState = "idle";
    this.dialLockedLeadId = null;
    this.dialLockedLeadSnapshot = null;

    try {
      const lastDial = this.lastDialData || {};
      const res = await fetch("/api/calls/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: currentLeadId,
          call_mode: this.settings.calling_mode || "callback",
          calling_mode: this.settings.calling_mode || "callback",
          voip_method: this.settings.voip_method || "webrtc",
          caller_id: this.settings.caller_id || "",
          duration_seconds: duration,
          disposition: this.selectedDisposition || "Answered",
          notes: currentNotes,
          sonetel_call_id: lastDial.sonetel_call_id || "",
          api_payload: lastDial.request_payload || {},
          api_response: lastDial.response_payload || {},
          is_simulated: lastDial.is_simulated !== undefined ? lastDial.is_simulated : true
        })
      });
      const data = await res.json();

      const updatedLeadObj = data.updated_lead || data.lead;
      if (updatedLeadObj) {
        const idx = this.leads.findIndex((l) => Number(l.id) === Number(currentLeadId));
        if (idx !== -1) this.leads[idx] = updatedLeadObj;
      }

      if (data.calls) {
        this.callLogs = data.calls;
      } else {
        const histRes = await fetch("/api/calls", { cache: "no-store" });
        const histData = await histRes.json();
        this.callLogs = histData.calls || histData.call_logs || [];
      }

      if (nextLead) {
        this.activeLeadId = nextLead.id;
      }

      this.callSeconds = 0;
      const timerEl = document.getElementById("call-timer-display");
      if (timerEl) timerEl.textContent = "00:00";

      this.renderAll();
      this.hideCallPop();
      this.showToast(
        `Saved "${this.selectedDisposition}" for ${lead.name}. ${nextLead ? `Now showing ${nextLead.name}.` : ""}`,
        "success"
      );

      if (String(this.settings.auto_advance) === "true" && nextLead && nextLead.id !== currentLeadId) {
        setTimeout(() => {
          this.startDialSession();
        }, 700);
      }
    } catch (err) {
      console.error("Failed completing call:", err);
      this.showToast("Error saving call disposition", "error");
    }
  }

  skipToNextLead() {
    if (this.callState !== "idle") {
      this.endActiveCallOnly();
    }
    this.stepLead(1);
  }

  // ---------------------------------------------------------------------------
  // Auto-Saving Call Notes
  // ---------------------------------------------------------------------------
  handleNotesInput(val) {
    const lead = this.getDisplayedLead();
    if (!lead) return;
    const targetLeadId = lead.id;

    lead.notes = val;
    const liveLead = this.getLeadById(targetLeadId);
    if (liveLead) liveLead.notes = val;

    const statusEl = document.getElementById("notes-autosave-status");
    if (statusEl) {
      statusEl.textContent = "Saving...";
      statusEl.className = "text-[11px] font-mono-code text-amber-400";
    }

    if (this.notesSaveTimeout) clearTimeout(this.notesSaveTimeout);
    this.notesSaveTimeout = setTimeout(async () => {
      try {
        await fetch(`/api/leads/${targetLeadId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: val })
        });
        if (statusEl) {
          statusEl.textContent = "✓ Auto-saved";
          statusEl.className = "text-[11px] font-mono-code text-emerald-400";
        }
      } catch (_) {
        if (statusEl) {
          statusEl.textContent = "Save error";
          statusEl.className = "text-[11px] font-mono-code text-rose-400";
        }
      }
    }, 350);
  }

  insertNoteSnippet(snippet) {
    const textarea = document.getElementById("dialer-notes-textarea");
    if (!textarea) return;
    const prefix = textarea.value.trim() ? textarea.value.trim() + "\n" : "";
    textarea.value = prefix + snippet;
    this.handleNotesInput(textarea.value);
    textarea.focus();
  }

  insertNoteTimestamp() {
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    this.insertNoteSnippet(`[${now}] `);
  }

  updateApiInspectorPreview(lead) {
    const inspector = document.getElementById("sonetel-api-inspector");
    if (!inspector || !lead || this.callState !== "idle") return;

    const mode = this.settings.calling_mode || "callback";
    const voipMethod = this.settings.voip_method || "webrtc";
    const agentPhone = this.settings.agent_phone || "+14155550199";
    const sipUri = this.settings.sip_uri || "sip:agent@sonetel.com";
    const callerId = this.settings.caller_id || "+14158904410";

    const payload = {
      endpoint: "POST https://public-api.sonetel.com/make-calls/call/call-back",
      headers: {
        Authorization: "Bearer <sonetel_access_token>",
        "Content-Type": "application/json;charset=UTF-8"
      },
      body: {
        app_id: "sonetel_mac_power_dialer_v5",
        call1: mode === "callback" ? agentPhone : (voipMethod === "sip_api" ? sipUri : `webrtc:${sipUri}`),
        call2: lead.phone,
        show_1: callerId,
        show_2: callerId
      }
    };
    inspector.textContent = JSON.stringify(payload, null, 2);
  }

  // ---------------------------------------------------------------------------
  // Kanban Pipeline Board View
  // ---------------------------------------------------------------------------
  renderKanban() {
    const board = document.getElementById("kanban-board");
    if (!board) return;

    const searchInput = document.getElementById("pipeline-search-input");
    const prioSelect = document.getElementById("pipeline-priority-filter");
    const query = ((searchInput && searchInput.value) || "").trim().toLowerCase();
    const prioFilter = (prioSelect && prioSelect.value) || "";

    const stageColors = {
      "Queued": "bg-zinc-500/20 text-zinc-300",
      "In Progress": "bg-indigo-500/20 text-indigo-400",
      "Connected / Answered": "bg-emerald-500/20 text-emerald-400",
      "No Answer / Voicemail": "bg-amber-500/20 text-amber-400",
      "Follow Up / Closed": "bg-purple-500/20 text-purple-400"
    };

    board.innerHTML = this.stages.map((stage) => {
      const stageLeads = this.leads.filter((l) => {
        if (l.stage !== stage) return false;
        if (prioFilter && l.priority !== prioFilter) return false;
        if (query) {
          const hay = `${l.name} ${l.company} ${l.phone} ${l.role} ${l.notes}`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });

      const totalInStage = stageLeads.length;
      const limitedLeads = stageLeads.slice(0, this.kanbanLimit);
      const remaining = totalInStage - limitedLeads.length;

      let cardsHtml = "";
      if (!limitedLeads.length) {
        cardsHtml = `<div class="h-28 border border-dashed app-border rounded-xl flex items-center justify-center text-[11px] app-text-muted">Drop contact here</div>`;
      } else {
        cardsHtml = limitedLeads.map((lead) => this.renderKanbanCard(lead)).join("");
        if (remaining > 0) {
          cardsHtml += `<div class="text-[11px] app-text-muted text-center py-2 px-2 rounded-xl app-elevated border">+ ${remaining} more in ${this.escapeHtml(stage)} — use search to filter</div>`;
        }
      }

      return `
        <div data-stage="${this.escapeHtml(stage)}" class="kanban-lane bg-[var(--surface-1)] border flex flex-col h-full overflow-hidden"
          ondragover="event.preventDefault(); this.classList.add('ring-2');"
          ondragleave="this.classList.remove('ring-2');"
          ondrop="window.app.handleKanbanDrop(event, '${stage}'); this.classList.remove('ring-2');"
        >
          <div class="p-3.5 border-b flex items-center justify-between shrink-0 bg-[var(--surface-2)]">
            <span class="font-semibold text-[13px] truncate">${this.escapeHtml(stage)}</span>
            <span class="font-mono-code text-[11px] px-2.5 py-1 rounded-full bg-[var(--surface-1)] border">${totalInStage}</span>
          </div>
          <div class="flex-1 overflow-y-auto p-2.5 space-y-2.5 bg-[var(--ink-2)]">
            ${cardsHtml}
          </div>
        </div>
      `;
    }).join("");
  }

  renderKanbanCard(lead) {
    const isActive = Number(lead.id) === Number(this.activeLeadId);
    const prioStyle = lead.priority === "High" ? "bg-amber-400 text-black" : lead.priority === "Low" ? "bg-[var(--surface-3)]" : "bg-[var(--surface-2)] border";
    return `
      <div draggable="true" ondragstart="window.app.handleKanbanDragStart(event, ${lead.id})" class="rounded-[12px] border bg-[var(--surface-1)] p-3 space-y-2 cursor-grab hover:border-[var(--border-strong)] transition-all ${isActive ? "border-[var(--accent)] ring-2 ring-[var(--accent-soft)]" : ""}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold text-[13px] truncate">${this.escapeHtml(lead.name)}</div>
            <div class="text-[11px] opacity-60 truncate">${this.escapeHtml(lead.company || "Independent")}</div>
          </div>
          <span class="text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${prioStyle}">${this.escapeHtml(lead.priority || "Medium")}</span>
        </div>
        <div class="flex items-center justify-between text-[11px] font-mono-code">
          <span class="text-[var(--accent)] font-medium">${this.escapeHtml(lead.phone)}</span>
          <span class="opacity-50">Calls ${lead.attempts || 0}</span>
        </div>
        <div class="pt-2 border-t flex items-center justify-between gap-1.5">
          <button onclick="window.app.jumpToDialLead(${lead.id}, false)" class="flex-1 py-2 px-2 rounded-full bg-[var(--text-primary)] text-[var(--bg)] font-medium text-[11px]">Open in Dialer</button>
          <button onclick="window.app.openLeadModal(${lead.id})" class="py-2 px-3 rounded-full bg-[var(--surface-2)] border text-[11px]">Edit</button>
        </div>
      </div>
    `;
  }

  handleKanbanDragStart(event, leadId) {
    event.dataTransfer.setData("text/plain", String(leadId));
  }

  async handleKanbanDrop(event, targetStage) {
    event.preventDefault();
    const leadId = Number(event.dataTransfer.getData("text/plain"));
    if (!leadId) return;
    const lead = this.getLeadById(leadId);
    if (!lead || lead.stage === targetStage) return;

    lead.stage = targetStage;
    this.renderAll();

    try {
      await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: targetStage })
      });
      this.showToast(`Moved ${lead.name} to ${targetStage}`, "info");
    } catch (_) {
      this.showToast("Failed to update stage", "error");
    }
  }

  jumpToDialLead(leadId, autoDial = false) {
    this.activeLeadId = Number(leadId);
    this.switchView("dialer");
    if (autoDial) {
      this.startDialSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Call History & Analytics View
  // ---------------------------------------------------------------------------
  renderCallHistory() {
    const tbody = document.getElementById("call-history-tbody");
    if (!tbody) return;

    const total = this.callLogs.length;
    const answered = this.callLogs.filter((c) => c.disposition === "Answered").length;
    const callbackCalls = this.callLogs.filter((c) => (c.call_mode || c.calling_mode) === "callback").length;
    const voipCalls = this.callLogs.filter((c) => (c.call_mode || c.calling_mode) === "voip").length;
    const rate = total > 0 ? Math.round((answered / total) * 100) : 0;

    const elTotal = document.getElementById("kpi-total-calls");
    const elRate = document.getElementById("kpi-connect-rate");
    const elCb = document.getElementById("kpi-callback-calls");
    const elVoip = document.getElementById("kpi-voip-calls");

    if (elTotal) elTotal.textContent = total;
    if (elRate) elRate.textContent = `${rate}%`;
    if (elCb) elCb.textContent = callbackCalls;
    if (elVoip) elVoip.textContent = voipCalls;

    if (!this.callLogs.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="py-10 text-center app-text-muted">
            No call sessions logged yet. Start calling from the <b>Active Dialer</b> tab!
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.callLogs.map((log) => {
      const isVoip = (log.call_mode || log.calling_mode) === "voip";
      const modeBadge = isVoip
        ? `<span class="px-2.5 py-1 rounded-full bg-[var(--accent-2-soft)] text-[var(--accent-2)] border text-[11px] font-medium">VoIP</span>`
        : `<span class="px-2.5 py-1 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border text-[11px] font-medium">Callback</span>`;

      const dispClass = log.disposition === "Answered" ? "bg-emerald-500/15 text-emerald-600 border" : log.disposition === "No Answer" ? "bg-amber-400/15 text-amber-700 border" : "bg-[var(--surface-2)] border";
      const timeFormatted = log.created_at ? new Date(log.created_at).toLocaleString() : "—";
      const company = log.lead_company || log.company || "";
      const call1 = log.call1_source || log.call1 || "";
      const call2 = log.call2_destination || log.call2 || log.lead_phone || log.phone || "";

      return `
        <tr class="hover:bg-[var(--surface-2)] border-b">
          <td class="py-3 px-4 font-mono-code text-[11px] opacity-60 whitespace-nowrap">${this.escapeHtml(timeFormatted)}</td>
          <td class="py-3 px-4"><div class="font-medium">${this.escapeHtml(log.lead_name)}</div><div class="text-[11px] opacity-60">${this.escapeHtml(company)}</div></td>
          <td class="py-3 px-4 whitespace-nowrap">${modeBadge}</td>
          <td class="py-3 px-4 font-mono-code text-[11px] opacity-70"><span>${this.escapeHtml(call1)}</span> → <span class="text-emerald-500">${this.escapeHtml(call2)}</span></td>
          <td class="py-3 px-4 font-mono-code text-[11px] opacity-60">${this.escapeHtml(log.caller_id || "")}</td>
          <td class="py-3 px-4 font-mono-code text-[11px]">${this.formatSeconds(log.duration_seconds || 0)}</td>
          <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-full text-[11px] border ${dispClass}">${this.escapeHtml(log.disposition)}</span></td>
          <td class="py-3 px-4 max-w-xs truncate opacity-70 text-[11px]">${this.escapeHtml(log.notes_snapshot || "")}</td>
        </tr>
      `;
    }).join("");
  }

  // ---------------------------------------------------------------------------
  // Settings Drawer & Page
  // ---------------------------------------------------------------------------
  toggleSettingsDrawer(open) {
    const drawer = document.getElementById("settings-drawer");
    const backdrop = document.getElementById("settings-drawer-backdrop");
    if (!drawer || !backdrop) return;
    if (open) {
      this.populateSettingsForms();
      backdrop.classList.remove("hidden");
      drawer.classList.remove("translate-x-full");
    } else {
      backdrop.classList.add("hidden");
      drawer.classList.add("translate-x-full");
    }
  }

  populateCallerIdSelects() {
    let callerIds = [];
    if (Array.isArray(this.settings.caller_id_pool_parsed) && this.settings.caller_id_pool_parsed.length) {
      callerIds = this.settings.caller_id_pool_parsed;
    } else {
      try {
        callerIds = JSON.parse(this.settings.caller_id_pool || this.settings.caller_id_options || "[]");
      } catch (_) {
        callerIds = [];
      }
    }
    if (!callerIds.length) {
      callerIds = [{ number: "+14158904410", label: "US Line (+1 415-890-4410)" }];
    }

    const activeCid = this.settings.caller_id || callerIds[0].number;
    const selectIds = ["header-caller-id-select", "drawer-caller-id", "page-caller-id"];

    selectIds.forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = callerIds.map((item) => {
        const selected = item.number === activeCid ? "selected" : "";
        const text = id === "header-caller-id-select" ? item.number : `${item.label} (${item.number})`;
        return `<option value="${this.escapeHtml(item.number)}" ${selected}>${this.escapeHtml(text)}</option>`;
      }).join("");
    });
  }

  populateSettingsForms() {
    const s = this.settings;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = val;
    };

    setVal("drawer-sonetel-email", s.sonetel_email || "");
    setVal("drawer-agent-phone", s.agent_phone || "");
    setVal("drawer-sip-uri", s.sip_uri || "");
    setVal("drawer-voip-method", s.voip_method || "webrtc");
    setVal("drawer-caller-id", s.caller_id || "");
    setVal("drawer-default-cc", s.default_country_code || "+1");

    setVal("page-sonetel-email", s.sonetel_email || "");
    setVal("page-agent-phone", s.agent_phone || "");
    setVal("page-sip-uri", s.sip_uri || "");
    setVal("page-caller-id", s.caller_id || "");
    setVal("page-default-cc", s.default_country_code || "+1");

    const tokenPreview = document.getElementById("page-token-preview");
    if (tokenPreview) {
      const realToken = s.sonetel_access_token || s.access_token || "";
      const preview = s.sonetel_access_token_preview || (realToken ? realToken.slice(0, 18) + "..." : "");
      const mode = s.is_live_token ? "🟢 LIVE" : "🟡 Local Bridge / Simulated";
      const updatedAt = s.sonetel_token_updated_at ? ` (Updated: ${s.sonetel_token_updated_at})` : "";
      tokenPreview.textContent = realToken
        ? `${mode} Bearer Token: ${preview}${updatedAt} | Account: ${s.sonetel_account_id || "n/a"} | Auth Mode: ${s.sonetel_auth_mode || "sandbox"}`
        : "No OAuth token cached yet (Local Smart Fallback Active — dialer works in simulation mode)";
    }

    // Sync auto_advance checkbox anywhere
    const autoCheck = document.getElementById("auto-dial-next-checkbox");
    if (autoCheck) {
      const isAuto = String(s.auto_advance || s.auto_dial_next || "false") === "true";
      autoCheck.checked = isAuto;
    }

    const healthEl = document.getElementById("settings-health-indicator");
    if (healthEl) {
      this.refreshHealthIndicator();
    }
  }

  async refreshHealthIndicator() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = await res.json();
      const el = document.getElementById("settings-health-indicator");
      const el2 = document.getElementById("header-health-dot");
      const el3 = document.getElementById("header-health-text");
      if (el) {
        el.textContent = `✅ API OK | ${data.leads_count} leads | v${data.version} | ${data.calling_mode}`;
        el.className = "text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25";
      }
      if (el2) {
        el2.className = "w-2 h-2 rounded-full bg-emerald-400 animate-pulse";
        el2.title = `API Healthy — ${data.leads_count} leads | ${data.calling_mode}`;
      }
      if (el3) {
        el3.textContent = `Live v${data.version} · ${data.leads_count} leads · ${data.is_live_token ? "🟢 LIVE" : "🟡 Sim"}`;
        el3.className = "font-mono-code text-emerald-400";
      }
    } catch (_) {
      const el = document.getElementById("settings-health-indicator");
      const el2 = document.getElementById("header-health-dot");
      const el3 = document.getElementById("header-health-text");
      if (el) {
        el.textContent = "⚠️ API unreachable";
        el.className = "text-[11px] font-mono-code px-2.5 py-1 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/25";
      }
      if (el2) el2.className = "w-2 h-2 rounded-full bg-rose-500";
      if (el3) {
        el3.textContent = "Offline";
        el3.className = "font-mono-code text-rose-400";
      }
    }
  }

  async quickChangeCallerId(newCallerId) {
    this.settings.caller_id = newCallerId;
    this.populateCallerIdSelects();
    this.renderActiveDialer();
    await this.persistSettings({ caller_id: newCallerId }, false);
    this.showToast(`Outbound Caller ID set to ${newCallerId}`, "info");
  }

  async addCustomCallerId() {
    const numEl = document.getElementById("drawer-new-cid-number");
    const lblEl = document.getElementById("drawer-new-cid-label");
    const rawNum = ((numEl && numEl.value) || "").trim();
    const label = ((lblEl && lblEl.value) || "Custom Line").trim();
    if (!rawNum) return;

    let callerIds = [];
    if (Array.isArray(this.settings.caller_id_pool_parsed)) {
      callerIds = [...this.settings.caller_id_pool_parsed];
    } else {
      try {
        callerIds = JSON.parse(this.settings.caller_id_pool || "[]");
      } catch (_) {}
    }

    callerIds.push({ number: rawNum, label });
    this.settings.caller_id_pool = JSON.stringify(callerIds);
    this.settings.caller_id_pool_parsed = callerIds;
    this.settings.caller_id = rawNum;

    if (numEl) numEl.value = "";
    if (lblEl) lblEl.value = "";

    this.populateCallerIdSelects();
    await this.persistSettings({
      caller_id_pool: this.settings.caller_id_pool,
      caller_id: rawNum
    }, true);
  }

  async saveSettingsFromDrawer() {
    const payload = {
      sonetel_email: document.getElementById("drawer-sonetel-email")?.value || "",
      sonetel_password: document.getElementById("drawer-sonetel-password")?.value || undefined,
      agent_phone: document.getElementById("drawer-agent-phone")?.value || "",
      sip_uri: document.getElementById("drawer-sip-uri")?.value || "",
      voip_method: document.getElementById("drawer-voip-method")?.value || "webrtc",
      caller_id: document.getElementById("drawer-caller-id")?.value || "",
      default_country_code: document.getElementById("drawer-default-cc")?.value || "+1"
    };
    await this.persistSettings(payload, true);
    this.toggleSettingsDrawer(false);
  }

  async saveSettingsFromPage() {
    const payload = {
      sonetel_email: document.getElementById("page-sonetel-email")?.value || "",
      sonetel_password: document.getElementById("page-sonetel-password")?.value || undefined,
      agent_phone: document.getElementById("page-agent-phone")?.value || "",
      sip_uri: document.getElementById("page-sip-uri")?.value || "",
      caller_id: document.getElementById("page-caller-id")?.value || "",
      default_country_code: document.getElementById("page-default-cc")?.value || "+1"
    };
    await this.persistSettings(payload, true);
  }

  async persistSettings(partialSettings, showNotification = true) {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: partialSettings })
      });
      const data = await res.json();
      if (data.settings) {
        this.settings = data.settings;
        this.syncModeControlsUI();
        this.populateCallerIdSelects();
        this.renderActiveDialer();
      }
      if (showNotification) {
        this.showToast("Settings saved to pipeline.db", "success");
      }
    } catch (_) {
      this.showToast("Failed to save settings", "error");
    }
  }

  async authenticateSonetel(source = "page") {
    const email = document.getElementById(`${source}-sonetel-email`)?.value || "";
    const password = document.getElementById(`${source}-sonetel-password`)?.value || "";
    try {
      const res = await fetch("/api/sonetel/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      await this.loadBootstrapData();
      this.showToast(data.message || "Sonetel OAuth2 verified", data.live ? "success" : "info");
    } catch (_) {
      this.showToast("Failed to reach Sonetel OAuth endpoint", "error");
    }
  }

  async syncSonetelNumbers() {
    try {
      const res = await fetch("/api/sonetel/sync-numbers", { method: "POST" });
      const data = await res.json();
      if (data.settings) {
        this.settings = data.settings;
        this.populateCallerIdSelects();
      }
      this.showToast(data.message || "Caller IDs synced", "success");
    } catch (_) {
      this.showToast("Could not sync numbers", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Upload Calling List Modal (CSV / Excel OR Paste Rows)
  // ---------------------------------------------------------------------------
  openImportModal() {
    const modal = document.getElementById("import-modal");
    if (modal) modal.classList.remove("hidden");
  }

  closeImportModal() {
    const modal = document.getElementById("import-modal");
    if (modal) modal.classList.add("hidden");
  }

  handleFileDrop(event) {
    event.preventDefault();
    const dropzone = document.getElementById("import-dropzone");
    if (dropzone) dropzone.classList.remove("border-emerald-500", "bg-emerald-500/5");
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      this.handleFileSelect(event.dataTransfer.files[0]);
    }
  }

  async handleFileSelect(file) {
    if (!file) return;
    this.pendingImportFile = file;
    this.pendingImportPasteText = null;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("default_country_code", this.settings.default_country_code || "+1");

    try {
      const res = await fetch("/api/import/preview", {
        method: "POST",
        body: formData
      });
      if (!res.ok) throw new Error("Failed to parse file");
      const data = await res.json();
      this.setupImportMappingUI(data);
    } catch (_) {
      this.showToast("Could not parse file. Ensure it is a valid CSV or Excel spreadsheet.", "error");
    }
  }

  async handlePastePreview() {
    const pasteEl = document.getElementById("import-paste-textarea");
    const rawText = ((pasteEl && pasteEl.value) || "").trim();
    if (!rawText) {
      this.showToast("Paste at least a header row and one contact row first", "warning");
      return;
    }

    this.pendingImportPasteText = rawText;
    this.pendingImportFile = null;

    try {
      const res = await fetch("/api/import/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: rawText,
          default_country_code: this.settings.default_country_code || "+1"
        })
      });
      if (!res.ok) throw new Error("Failed to parse pasted rows");
      const data = await res.json();
      this.setupImportMappingUI(data);
    } catch (_) {
      this.showToast("Could not parse pasted text. Make sure it has column headers on line 1.", "error");
    }
  }

  async loadBuiltInSampleCsv() {
    try {
      const res = await fetch("/api/sample-csv", { cache: "no-store" });
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv" });
      const file = new File([blob], "sample_leads.csv", { type: "text/csv" });
      await this.handleFileSelect(file);
    } catch (_) {
      this.showToast("Could not load sample_leads.csv", "error");
    }
  }

  setupImportMappingUI(data) {
    this.importColumns = data.columns || [];
    this.pendingImportRows = data.rows || [];
    const mapping = data.auto_mapping || data.suggested_mapping || {};

    document.getElementById("import-mapping-section")?.classList.remove("hidden");
    const fnLabel = document.getElementById("import-filename-label");
    const rcLabel = document.getElementById("import-rowcount-label");
    if (fnLabel) fnLabel.textContent = data.filename || "calling_list.csv";
    if (rcLabel) rcLabel.textContent = data.total_rows || 0;

    const selects = [
      { id: "map-col-name", key: "name", required: true },
      { id: "map-col-phone", key: "phone", required: true },
      { id: "map-col-company", key: "company", required: false },
      { id: "map-col-notes", key: "notes", required: false },
      { id: "map-col-role", key: "role", required: false },
      { id: "map-col-email", key: "email", required: false },
      { id: "map-col-location", key: "location", required: false },
      { id: "map-col-priority", key: "priority", required: false },
      { id: "map-col-tags", key: "tags", required: false }
    ];

    selects.forEach(({ id, key, required }) => {
      const el = document.getElementById(id);
      if (!el) return;
      const options = [];
      if (!required) options.push(`<option value="">— None —</option>`);
      this.importColumns.forEach((col) => {
        const sel = mapping[key] === col ? "selected" : "";
        options.push(`<option value="${this.escapeHtml(col)}" ${sel}>${this.escapeHtml(col)}</option>`);
      });
      el.innerHTML = options.join("");
    });

    const commitBtn = document.getElementById("btn-commit-import");
    if (commitBtn) commitBtn.disabled = false;

    this.renderImportPreviewRows(data.preview_samples || data.preview_rows || []);
  }

  async refreshImportPreview() {
    if (this.pendingImportFile) {
      await this.handleFileSelect(this.pendingImportFile);
    } else if (this.pendingImportPasteText) {
      await this.handlePastePreview();
    }
  }

  renderImportPreviewRows(rows) {
    const tbody = document.getElementById("import-preview-tbody");
    if (!tbody) return;
    const colCount = this.importColumns ? this.importColumns.length : 4;
    tbody.innerHTML = rows.slice(0, 8).map((r) => {
      return `
        <tr>
          <td class="py-2 px-3 font-medium app-text-primary">${this.escapeHtml(r.name)}</td>
          <td class="py-2 px-3 font-mono-code app-text-muted">${this.escapeHtml(r.raw_phone)}</td>
          <td class="py-2 px-3 font-mono-code text-emerald-400 font-semibold">${this.escapeHtml(r.sanitized_phone)}</td>
          <td class="py-2 px-3 app-text-secondary">${this.escapeHtml(r.company)}</td>
          <td class="py-2 px-3 font-mono-code text-indigo-400">${colCount} columns saved</td>
        </tr>
      `;
    }).join("");
  }

  async commitImport() {
    if (!this.pendingImportRows || !this.pendingImportRows.length) return;

    const mapping = {
      name: document.getElementById("map-col-name")?.value || "",
      phone: document.getElementById("map-col-phone")?.value || "",
      company: document.getElementById("map-col-company")?.value || "",
      notes: document.getElementById("map-col-notes")?.value || "",
      role: document.getElementById("map-col-role")?.value || "",
      email: document.getElementById("map-col-email")?.value || "",
      location: document.getElementById("map-col-location")?.value || "",
      priority: document.getElementById("map-col-priority")?.value || "",
      tags: document.getElementById("map-col-tags")?.value || ""
    };

    const replaceCheckbox = document.getElementById("import-replace-checkbox");
    const replaceExisting = Boolean(replaceCheckbox && replaceCheckbox.checked);
    const defaultCc = document.getElementById("import-default-cc")?.value || "+1";

    try {
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: this.pendingImportRows,
          mapping,
          default_country_code: defaultCc,
          replace_existing: replaceExisting
        })
      });
      const data = await res.json();
      this.closeImportModal();

      // Reset call state and load Person #1 immediately onto the dialer screen
      this.stopCallTimer();
      this.callState = "idle";
      this.dialLockedLeadId = null;
      this.dialLockedLeadSnapshot = null;
      const firstId = data.first_imported_lead_id || data.first_lead_id || null;
      this.activeLeadId = firstId;
      this.queueFilter = "all";

      await this.loadBootstrapData();
      if (firstId) {
        this.activeLeadId = firstId;
      }
      this.switchView("dialer");
      const count = data.imported_count || data.imported || 0;
      this.showToast(`Loaded ${count} people into your Calling List — Ready to dial Person #1!`, "success");
    } catch (_) {
      this.showToast("Import failed", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Add / Edit Single Contact Modal
  // ---------------------------------------------------------------------------
  openLeadModal(leadId = null) {
    const modal = document.getElementById("lead-modal");
    const title = document.getElementById("lead-modal-title");
    const delBtn = document.getElementById("btn-delete-lead");

    if (leadId) {
      const lead = this.getLeadById(leadId);
      if (!lead) return;
      if (title) title.textContent = `Edit ${lead.name}`;
      if (delBtn) delBtn.classList.remove("hidden");
      document.getElementById("lead-form-id").value = lead.id;
      document.getElementById("lead-form-name").value = lead.name || "";
      document.getElementById("lead-form-phone").value = lead.phone || "";
      document.getElementById("lead-form-company").value = lead.company || "";
      document.getElementById("lead-form-role").value = lead.role || "";
      document.getElementById("lead-form-stage").value = lead.stage || "Queued";
      document.getElementById("lead-form-priority").value = lead.priority || "Medium";
      document.getElementById("lead-form-location").value = lead.location || "";
      document.getElementById("lead-form-notes").value = lead.notes || "";
    } else {
      if (title) title.textContent = "Add New Person to Calling List";
      if (delBtn) delBtn.classList.add("hidden");
      document.getElementById("lead-form-id").value = "";
      document.getElementById("lead-form-name").value = "";
      document.getElementById("lead-form-phone").value = "";
      document.getElementById("lead-form-company").value = "";
      document.getElementById("lead-form-role").value = "";
      document.getElementById("lead-form-stage").value = "Queued";
      document.getElementById("lead-form-priority").value = "Medium";
      document.getElementById("lead-form-location").value = "";
      document.getElementById("lead-form-notes").value = "";
    }

    if (modal) modal.classList.remove("hidden");
  }

  closeLeadModal() {
    document.getElementById("lead-modal")?.classList.add("hidden");
  }

  async saveLeadModal() {
    const id = document.getElementById("lead-form-id").value;
    const payload = {
      name: document.getElementById("lead-form-name").value.trim(),
      phone: document.getElementById("lead-form-phone").value.trim(),
      company: document.getElementById("lead-form-company").value.trim(),
      role: document.getElementById("lead-form-role").value.trim(),
      stage: document.getElementById("lead-form-stage").value,
      priority: document.getElementById("lead-form-priority").value,
      location: document.getElementById("lead-form-location").value.trim(),
      notes: document.getElementById("lead-form-notes").value
    };

    if (!payload.name || !payload.phone) {
      this.showToast("Name and Phone Number are required", "warning");
      return;
    }

    try {
      if (id) {
        const res = await fetch(`/api/leads/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.lead && Number(this.dialLockedLeadId) === Number(id)) {
          this.dialLockedLeadSnapshot = JSON.parse(JSON.stringify(data.lead));
        }
      } else {
        const res = await fetch("/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.lead) this.activeLeadId = data.lead.id;
      }
      this.closeLeadModal();
      await this.loadBootstrapData();
      this.showToast("Contact saved", "success");
    } catch (_) {
      this.showToast("Failed to save contact", "error");
    }
  }

  async deleteCurrentModalLead() {
    const id = document.getElementById("lead-form-id").value;
    if (!id) return;
    try {
      await fetch(`/api/leads/${id}`, { method: "DELETE" });
      if (Number(this.activeLeadId) === Number(id)) {
        this.activeLeadId = null;
      }
      this.closeLeadModal();
      await this.loadBootstrapData();
      this.showToast("Contact removed", "info");
    } catch (_) {
      this.showToast("Could not delete contact", "error");
    }
  }

  async resetDemoData() {
    try {
      await fetch("/api/demo/reset", { method: "POST" });
      this.activeLeadId = null;
      this.dialLockedLeadId = null;
      this.dialLockedLeadSnapshot = null;
      await this.loadBootstrapData();
      this.showToast("Sample calling list restored", "success");
    } catch (_) {
      this.showToast("Could not reset sample data", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts & Helpers
  // ---------------------------------------------------------------------------
  bindKeyboardShortcuts() {
    window.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      if (e.key === "1") this.selectDisposition("Answered");
      if (e.key === "2") this.selectDisposition("No Answer");
      if (e.key === "3") this.selectDisposition("Busy");
      if (e.key === "4") this.selectDisposition("Wrong Number");
    });
  }

  computeLocalTimeForPhone(phone, location) {
    const p = String(phone || "");
    let tz = "America/New_York";
    if (p.startsWith("+1415") || p.startsWith("+1650") || p.startsWith("+1206")) tz = "America/Los_Angeles";
    else if (p.startsWith("+1312") || p.startsWith("+1512")) tz = "America/Chicago";
    else if (p.startsWith("+44")) tz = "Europe/London";
    else if (p.startsWith("+46") || p.startsWith("+49") || p.startsWith("+33")) tz = "Europe/Stockholm";
    else if (p.startsWith("+91")) tz = "Asia/Kolkata";
    else if (p.startsWith("+61")) tz = "Australia/Sydney";
    else if (p.startsWith("+65")) tz = "Asia/Singapore";
    else if (p.startsWith("+81")) tz = "Asia/Tokyo";

    try {
      const timeStr = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: tz
      }).format(new Date());
      return `${timeStr} · ${location || tz.split("/")[1].replace("_", " ")}`;
    } catch (_) {
      return location || "Local Time";
    }
  }

  formatSeconds(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const mins = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }

  escapeHtml(str) {
    return String(str === undefined || str === null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const colors = {
      success: "border-emerald-500/40 bg-emerald-950/90 text-emerald-200",
      info: "border-indigo-500/40 bg-indigo-950/90 text-indigo-200",
      warning: "border-amber-500/40 bg-amber-950/90 text-amber-200",
      error: "border-rose-500/40 bg-rose-950/90 text-rose-200"
    };

    const toast = document.createElement("div");
    toast.className = `px-3.5 py-2.5 rounded-xl border text-xs font-medium shadow-xl backdrop-blur-md transition-all duration-300 pointer-events-auto ${colors[type] || colors.info}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(6px)";
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.app = new SonetelPowerDialerApp();
  window.app.init();
});
