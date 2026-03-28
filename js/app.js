// ==========================================
// SecurePro â€” Main Application Logic
// Depends on: config.js (globals), api.js (code execution)
// ==========================================

// Screen capture for violation proof
const { desktopCapturer } = require('electron');

let violationLog = [];
let lastVioTime = {};
let questionTimers = {};
let activeQuestionIndex = null;
let autoSaveInterval = null;
let examCountdownInterval = null;
let examTimeRemainingSeconds = 0;
let navUpdateInterval = null;

// Phase 1: IPC + Network
let networkCheckInterval = null;
let baselineIP = null;
let multiDisplayBlocked = false;

// Phase 2: Face re-verification
let faceReverifyInterval = null;

// Phase 3: Behavioral intelligence
let lastKeystrokeTime = 0;
let rapidCharCount = 0;
let cursorOutCount = 0;
let lastActivityTime = Date.now();
let inactivityInterval = null;
let questionTimeLimits = {};
let isDisqualified = false;

// Audio recording for noise proof
let noiseRecorder = null;
let noiseChunks = [];
let audioTimeDataArray = null;
let audioFrameLastTs = 0;
let voiceActiveMs = 0;
let lastVoiceViolationTs = 0;
let roomAudioBaseline = { calibrated: false, rms: 0.012, speechRatio: 0.25, zcr: 0.08 };
let roomAudioCalibration = { active: false, endsAt: 0, rmsSamples: [], speechRatioSamples: [], zcrSamples: [] };
const AUDIO_CALIBRATION_MS = 5000;
const VOICE_MIN_ACTIVE_MS = 450;
const VOICE_MIN_GAP_MS = 5000;
const MIN_VOICE_RMS = 0.012;
const OBJECT_DETECTION_STREAK_REQUIRED = 2;
let objectDetectionStreak = { phone: 0, object: 0 };
let isGazeCalibrated = false;
let gazePosition = { x: 0, y: 0 };
let liveSnapshotInterval = null;
let lastGazeViolationTs = 0;
let gazeFrameCounter = 0;
const GAZE_FRAME_SKIP = 10; // Process 1 out of every 10 frames (approx. 3-6 fps)
const LIVE_SNAPSHOT_MS = 10000; // Send snapshot every 10s

function normalizeAwsLabel(label) {
    return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// â”€â”€ SCREEN SCREENSHOT (for TAB_SWITCH proof) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function captureScreenScreenshot() {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1280, height: 720 }
        });
        if (sources && sources.length > 0) {
            return sources[0].thumbnail.toDataURL(); // Returns PNG data URL
        }
    } catch (e) {
        console.warn('[PROOF] Screen capture failed:', e.message);
    }
    return null;
}

// â”€â”€ AUDIO RECORDING (for NOISE_DETECTED proof) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function recordNoiseAudio(durationMs = 5000) {
    return new Promise((resolve) => {
        if (!currentStream || noiseRecorder) { resolve(null); return; }
        try {
            const audioTracks = currentStream.getAudioTracks();
            if (!audioTracks.length) { resolve(null); return; }
            const audioStream = new MediaStream(audioTracks);
            noiseChunks = [];
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus' : 'audio/webm';
            noiseRecorder = new MediaRecorder(audioStream, { mimeType });
            noiseRecorder.ondataavailable = (e) => { if (e.data.size > 0) noiseChunks.push(e.data); };
            noiseRecorder.onstop = () => {
                noiseRecorder = null;
                const blob = new Blob(noiseChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result); // Base64 data URL
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            };
            noiseRecorder.start();
            setTimeout(() => {
                if (noiseRecorder && noiseRecorder.state === 'recording') noiseRecorder.stop();
            }, durationMs);
        } catch (e) {
            console.warn('[PROOF] Audio recording failed:', e.message);
            noiseRecorder = null;
            resolve(null);
        }
    });
}

// â”€â”€ WEBGAZER EYE TRACKING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function startCalibrationProcess() {
    const screen = document.getElementById('gaze-calibration-screen');
    screen.style.display = 'flex';

    // Inject 9 calibration dots
    const dots = [
        { t: '10%', l: '10%' }, { t: '10%', l: '50%' }, { t: '10%', l: '90%' },
        { t: '50%', l: '10%' }, { t: '50%', l: '50%' }, { t: '50%', l: '90%' },
        { t: '90%', l: '10%' }, { t: '90%', l: '50%' }, { t: '90%', l: '90%' }
    ];

    let clickedCount = 0;
    const totalDots = dots.length;
    const clicksPerDot = 5;
    const totalNeeded = totalDots * clicksPerDot;

    dots.forEach((pos, idx) => {
        const dot = document.createElement('div');
        dot.className = 'calib-dot';
        dot.style.cssText = `
            position:absolute; top:${pos.t}; left:${pos.l};
            width:20px; height:20px; background:#FF2D55; border-radius:50%;
            cursor:pointer; transform:translate(-50%, -50%);
            box-shadow:0 0 15px #FF2D55; transition:all 0.2s; z-index:401;
        `;
        let clicks = 0;
        dot.onclick = () => {
            clicks++;
            clickedCount++;
            const progress = (clickedCount / totalNeeded) * 100;
            document.getElementById('calib-progress-fill').style.width = progress + '%';

            if (clicks >= clicksPerDot) {
                dot.style.background = '#00D4FF';
                dot.style.boxShadow = '0 0 15px #00D4FF';
                dot.style.opacity = '0.5';
                dot.style.pointerEvents = 'none';
            } else {
                dot.style.transform = `translate(-50%, -50%) scale(${1 + clicks * 0.2})`;
            }

            if (clickedCount >= totalNeeded) {
                finishCalibration();
            }
        };
        screen.appendChild(dot);
    });
}

function finishCalibration() {
    isGazeCalibrated = true;
    const screen = document.getElementById('gaze-calibration-screen');
    screen.style.opacity = '0';
    setTimeout(() => {
        screen.style.display = 'none';
        toast('âœ… Gaze calibration complete');
        initLiveMonitoring();
    }, 500);
}

async function initGazeTracking() {
    try {
        console.log('[GAZE] Initializing WebGazer (with Electron bypass)...');
        
        // ELECTRON BYPASS: WebGazer throws an alert on non-https (file://) protocols.
        // We temporarily mute relevant alerts before initialization.
        const _trueAlert = window.alert;
        window.alert = (m) => {
            if (m && (m.includes('https') || m.includes('local server'))) {
                console.warn('[GAZE] Muted HTTPS warning:', m);
                return; 
            }
            _trueAlert(m);
        };

        webgazer.setRegression('ridge') 
            .setTracker('Tasmot')    // Lightweight tracker
            .setGazeListener((data, elapsed) => {
                if (!data) return;

                // Low-end optimization: Frame skipping
                gazeFrameCounter++;
                if (gazeFrameCounter % GAZE_FRAME_SKIP !== 0) return;

                gazePosition.x = data.x;
                gazePosition.y = data.y;

                // Check for looking away (streak based)
                checkGazeViolation(data.x, data.y);
            })
            .saveDataAcrossSessions(false)
            .showVideoPreview(false)
            .showPredictionPoints(false)
            .begin();

        // Reduce internal video resolution to 320x240 for low CPU usage
        const checkVideo = setInterval(() => {
            const wgVid = document.getElementById('webgazerVideoFeed');
            if (wgVid) {
                wgVid.width = 320;
                wgVid.height = 240;
                clearInterval(checkVideo);
                console.log('[GAZE] Optimized to 320x240');
            }
        }, 500);

    } catch (err) {
        console.warn('[GAZE] WebGazer init failed:', err.message);
    }
}

let gazeOutsideStartTs = 0;

function checkGazeViolation(x, y) {
    if (!isGazeCalibrated) return;

    const margin = 120; // Reduced margin for cleaner detection
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const isOutside = (x < -margin || x > screenWidth + margin || y < -margin || y > screenHeight + margin);

    if (isOutside) {
        if (gazeOutsideStartTs === 0) gazeOutsideStartTs = Date.now();
        
        const duration = Date.now() - gazeOutsideStartTs;
        if (duration >= 2000) { // 2 seconds of looking away
            const now = Date.now();
            if (now - lastGazeViolationTs > 10000) { // 10s cooldown for actual violation log
                lastGazeViolationTs = now;
                showVio('LOOKING_AWAY');
            } else if (now - lastGazeViolationTs > 2000) {
                // Show a smaller toast warning at top right if they continue looking away
                toast('LOOKING AWAY - RETURN TO SCREEN', true);
            }
        }
    } else {
        gazeOutsideStartTs = 0;
    }
}

// â”€â”€ LIVE SNAPSHOT MONITORING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function initLiveMonitoring() {
    if (liveSnapshotInterval) clearInterval(liveSnapshotInterval);
    liveSnapshotInterval = setInterval(sendLiveSnapshot, LIVE_SNAPSHOT_MS);
    sendLiveSnapshot(); // Send first one immediately

    // Switch to smooth-video (10 FPS) only when admin requests it via WebRTC
    initPeerJS(currentStudent);
}

async function sendLiveSnapshot() {
    if (!currentStudent || !activeExamID) return;

    try {
        const v = document.getElementById('exam-video');
        if (!v || v.videoWidth === 0 || v.paused || v.ended) return;

        // Ensure we don't capture a black screen by checking the canvas sum briefly
        if (v.readyState < 2) return; 

        const c = document.createElement('canvas');
        c.width = 300; c.height = 225; // Standardized small size
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 300, 225);

        // BLACK BOX FIX: Check the center of the image to ensure it's not and empty black frame
        const p = ctx.getImageData(150, 112, 1, 1).data;
        if (p[0] < 10 && p[1] < 10 && p[2] < 10) {
            // Attempt a deeper scan if center is dark (it might just be a dark room)
            const p2 = ctx.getImageData(50, 50, 1, 1).data;
            if (p2[0] < 10 && p2[1] < 10 && p2[2] < 10) {
                // If both center and corner are pure black, likely a rendering lag — skip and retry
                console.log('[LIVE] Video frame not ready (Black), retrying in 2s...');
                setTimeout(sendLiveSnapshot, 2000);
                return;
            }
        }
        
        const b64 = c.toDataURL('image/jpeg', 0.6); 
        const key = `live/${activeExamID}/${currentStudent}.jpg`;
        await s3UploadBase64(key, b64, 'image/jpeg');
    } catch (e) {
        console.warn('[LIVE] Snapshot failed:', e.message);
    }
}

// â”€â”€ PEERJS WEB RTC (FOR HYBRID VIDEO) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let myPeer = null;
let currentCall = null;

function initPeerJS(id) {
    if (myPeer) return;
    try {
        console.log('[PEER] Initializing with ID:', id);
        // Using PeerJS cloud with default STUN servers
        myPeer = new Peer(id, {
            debug: 1,
            config: {
                'iceServers': [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
        myPeer.on('open', (id) => console.log('[PEER] Registered as:', id));
        myPeer.on('call', (call) => {
            console.log('[PEER] Incoming focus request from admin');
            
            // Limit FPS to 10 for low-end safety
            if (currentStream) {
                const videoTracks = currentStream.getVideoTracks();
                if (videoTracks.length > 0) {
                    videoTracks[0].applyConstraints({ frameRate: 10 }).catch(e => console.warn(e));
                }
                call.answer(currentStream);
            }
        });
        myPeer.on('error', (err) => {
            console.warn('[PEER] Error:', err);
            if (err.type === 'unavailable-id') {
                // If ID is taken, try to just re-use the peer
                console.log('[PEER] ID already taken, continuing...');
            }
        });
    } catch (e) { console.warn('[PEER] Init failed:', e.message); }
}

// Fisher-Yates shuffle utility
function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Copy-paste / right-click blocking during exam
function blockExamShortcuts(e) {
    if (e.ctrlKey && ['c', 'v', 'x', 'a'].includes(e.key.toLowerCase())) {
        const isCodeEditor = document.activeElement.classList.contains('code-editor');
        if (!isCodeEditor) { e.preventDefault(); showVio('COPY_PASTE_ATTEMPT'); }
    }
}
function blockContextMenu(e) {
    const isCodeEditor = e.target.classList.contains('code-editor');
    if (!isCodeEditor) e.preventDefault();
}
function blockClipboardEvents(e) {
    const isCodeEditor = e.target.classList && e.target.classList.contains('code-editor');
    if (!isCodeEditor) {
        e.preventDefault();
        showVio('COPY_PASTE_ATTEMPT');
    }
}

// Block trackpad pinch-zoom and ctrl+scroll (prevents gesture-based navigation)
function blockGestureWheel(e) {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // Block pinch-zoom / ctrl+scroll
    }
}
// Block native macOS gesture events
function blockNativeGesture(e) {
    e.preventDefault();
}


function captureViolationSnapshot() {
    const v = document.getElementById('exam-video');
    if (!v || v.videoWidth === 0) return null;
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    c.getContext('2d').drawImage(v, 0, 0, 320, 240);
    return c.toDataURL('image/jpeg', 0.6);
}

function calculateCheatingScore(violations) {
    const weights = {
        NO_FACE: { pts: 8, max: 40 }, MULTIPLE_FACES: { pts: 15, max: 30 },
        PHONE_DETECTED: { pts: 20, max: 40 }, TAB_SWITCH: { pts: 12, max: 36 },
        LOOKING_AWAY: { pts: 4, max: 20 }, NOISE_DETECTED: { pts: 2, max: 10 },
        COPY_PASTE_ATTEMPT: { pts: 10, max: 30 }, AI_PASTE_DETECTED: { pts: 15, max: 45 },
        LIP_MOVEMENT: { pts: 6, max: 18 },
        BANNED_PROCESS_RUNNING: { pts: 25, max: 50 },
        MULTIPLE_DISPLAYS: { pts: 20, max: 40 },
        NETWORK_ANOMALY: { pts: 18, max: 36 },
        IDENTITY_MISMATCH: { pts: 30, max: 60 },
        OBJECT_DETECTED: { pts: 12, max: 36 },
        UNNATURAL_TYPING: { pts: 15, max: 30 },
        CURSOR_OUT_OF_BOUNDS: { pts: 5, max: 15 },
        INACTIVITY_DETECTED: { pts: 4, max: 12 }
    };
    const counts = {};
    (violations || []).forEach(v => counts[v.type] = (counts[v.type] || 0) + 1);
    let total = 0;
    for (const [type, count] of Object.entries(counts)) { if (weights[type]) total += Math.min(count * weights[type].pts, weights[type].max); }
    return Math.min(total, 100);
}

// === PHASE 1: IPC LISTENERS (Process Monitor + Multi-Display) ===
const { ipcRenderer } = require('electron');

ipcRenderer.on('banned-process-detected', (event, data) => {
    console.warn('[PROCTOR] Banned processes detected:', data.processes);
    showVio('BANNED_PROCESS_RUNNING');
    toast(`âš ï¸ Banned software detected: ${data.processes.join(', ')}`, true);
});

ipcRenderer.on('multiple-displays-detected', (event, data) => {
    multiDisplayBlocked = true;
    showVio('MULTIPLE_DISPLAYS');
    toast(`ðŸ–¥ï¸ Multiple monitors detected (${data.count}). Disconnect external displays!`, true);
});

ipcRenderer.on('displays-ok', () => {
    multiDisplayBlocked = false;
});

// === AUTO-UPDATE UI ===
function showUpdateBanner(state, data = {}) {
    let bar = document.getElementById('update-banner');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'update-banner';
        bar.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            border-bottom: 1px solid rgba(0,212,255,0.3);
            padding: 10px 20px;
            display: flex; align-items: center; justify-content: space-between;
            font-family: 'DM Sans', sans-serif; font-size: 13px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.4);
            transform: translateY(-100%); transition: transform 0.4s cubic-bezier(0.16,1,0.3,1);
        `;
        document.body.appendChild(bar);
        requestAnimationFrame(() => { bar.style.transform = 'translateY(0)'; });
    }

    if (state === 'available') {
        bar.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px;">
                <span style="font-size:18px;">ðŸš€</span>
                <div>
                    <div style="font-weight:700; color:#f1f5f9;">Update Available â€” v${data.version}</div>
                    <div style="color:#64748b; font-size:11px;">A new version of SecurePro is ready to download.</div>
                </div>
            </div>
            <div style="display:flex; gap:10px;">
                <button onclick="ipcRenderer.send('start-update-download')" style="background:linear-gradient(135deg,#00D4FF,#818cf8); color:#000; font-weight:700; border:none; padding:8px 18px; border-radius:8px; cursor:pointer; font-size:12px; width:auto;">
                    â¬‡ Download Update
                </button>
                <button onclick="document.getElementById('update-banner').remove()" style="background:rgba(255,255,255,0.07); color:#94a3b8; border:1px solid rgba(255,255,255,0.1); padding:8px 14px; border-radius:8px; cursor:pointer; font-size:12px; width:auto;">
                    Later
                </button>
            </div>`;
    } else if (state === 'downloading') {
        const pct = data.percent || 0;
        bar.innerHTML = `
            <div style="flex:1;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <span style="font-weight:700; color:#f1f5f9;">â¬‡ Downloading update... ${pct}%</span>
                    <span style="color:#64748b; font-size:11px;">${formatBytes(data.bytesPerSecond || 0)}/s</span>
                </div>
                <div style="background:rgba(255,255,255,0.07); border-radius:4px; height:6px; overflow:hidden;">
                    <div style="height:100%; width:${pct}%; background:linear-gradient(90deg,#00D4FF,#818cf8); border-radius:4px; transition:width 0.3s;"></div>
                </div>
            </div>`;
    } else if (state === 'ready') {
        bar.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px;">
                <span style="font-size:18px;">âœ…</span>
                <div>
                    <div style="font-weight:700; color:#00FF9D;">Update Ready â€” v${data.version}</div>
                    <div style="color:#64748b; font-size:11px;">Restart SecurePro to apply the update.</div>
                </div>
            </div>
            <div style="display:flex; gap:10px;">
                <button onclick="ipcRenderer.send('install-update-now')" style="background:linear-gradient(135deg,#00FF9D,#00D4FF); color:#000; font-weight:700; border:none; padding:8px 18px; border-radius:8px; cursor:pointer; font-size:12px; width:auto;">
                    ðŸ”„ Restart & Update
                </button>
            </div>`;
    } else if (state === 'error') {
        bar.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span>âš ï¸</span>
                <span style="color:#f87171;">Update check failed: ${data.message}</span>
            </div>
            <button onclick="document.getElementById('update-banner').remove()" style="background:rgba(255,255,255,0.07); color:#94a3b8; border:1px solid rgba(255,255,255,0.1); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:11px; width:auto;">âœ•</button>`;
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

ipcRenderer.on('update-available', (e, data) => showUpdateBanner('available', data));
ipcRenderer.on('update-download-progress', (e, data) => showUpdateBanner('downloading', data));
ipcRenderer.on('update-downloaded', (e, data) => showUpdateBanner('ready', data));
ipcRenderer.on('update-error', (e, data) => showUpdateBanner('error', data));

// === PHASE 1: NETWORK ANOMALY DETECTION ===
async function checkNetworkIP() {
    try {
        const https = require('https');
        const ip = await new Promise((resolve, reject) => {
            https.get('https://api.ipify.org?format=text', (res) => {
                let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d.trim()));
            }).on('error', reject);
        });
        if (!baselineIP) { baselineIP = ip; console.log('[NETWORK] Baseline IP:', ip); }
        else if (ip !== baselineIP) {
            console.warn('[NETWORK] IP changed from', baselineIP, 'to', ip);
            showVio('NETWORK_ANOMALY');
            toast('ðŸŒ Network change detected! IP address has changed mid-exam.', true);
        }
    } catch (e) { console.warn('IP check failed:', e.message); }
}

// === PHASE 2: PERIODIC FACE RE-VERIFICATION ===
async function periodicFaceReverify() {
    if (!currentStream || !currentStudent || isTestBypassUser()) return;
    try {
        const v = document.getElementById('exam-video');
        if (!v || v.videoWidth === 0) return;
        const c = document.createElement('canvas'); c.width = 320; c.height = 240;
        c.getContext('2d').drawImage(v, 0, 0, 320, 240);
        const liveB64 = c.toDataURL('image/jpeg', 0.8);
        const liveBuffer = Buffer.from(liveB64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const student = studentDB[currentStudent];
        if (!student || !student.photoKey) return;
        const params = {
            SourceImage: { S3Object: { Bucket: S3_BUCKET, Name: student.photoKey } },
            TargetImage: { Bytes: liveBuffer },
            SimilarityThreshold: 70
        };
        rekognition.compareFaces(params, (err, data) => {
            if (err) { console.warn('Face reverify error:', err.message); return; }
            if (!data.FaceMatches || data.FaceMatches.length === 0 || data.FaceMatches[0].Similarity < 85) {
                showVio('IDENTITY_MISMATCH');
                toast('âš ï¸ Face does not match registered photo!', true);
            } else {
                console.log('[REVERIFY] Identity confirmed, similarity:', data.FaceMatches[0].Similarity.toFixed(1) + '%');
            }
        });
    } catch (e) { console.warn('Reverify failed:', e.message); }
}

// === PHASE 3: TYPING SPEED TRACKER ===
function trackTypingSpeed(e) {
    if (!e.key || e.key.length !== 1) return; // Only printable chars
    const now = Date.now();
    if (lastKeystrokeTime > 0 && (now - lastKeystrokeTime) < 5) {
        rapidCharCount++;
        if (rapidCharCount >= 50) { showVio('UNNATURAL_TYPING'); rapidCharCount = 0; }
    } else {
        rapidCharCount = Math.max(0, rapidCharCount - 1);
    }
    lastKeystrokeTime = now;
    lastActivityTime = now;
}

// === PHASE 3: CURSOR OUT OF BOUNDS ===
function trackCursorLeave(e) {
    if (e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY <= 0 || e.clientY >= window.innerHeight) {
        cursorOutCount++;
        if (cursorOutCount >= 3) { showVio('CURSOR_OUT_OF_BOUNDS'); cursorOutCount = 0; }
    }
    lastActivityTime = Date.now();
}

// === PHASE 3: INACTIVITY DETECTION (3 min) ===
function checkInactivity() {
    if (Date.now() - lastActivityTime > 180000) { showVio('INACTIVITY_DETECTED'); lastActivityTime = Date.now(); }
}
function trackActivity() { lastActivityTime = Date.now(); }

// === PHASE 3: WATERMARK OVERLAY ===
function populateWatermark() {
    const el = document.getElementById('watermark-overlay');
    if (!el) return;
    const name = studentDB[currentStudent]?.name || currentStudent;
    const ts = new Date().toLocaleString();
    const text = `${currentStudent} Â· ${name} Â· ${ts}`;
    el.innerHTML = Array(60).fill(`<span style="padding:20px 40px; font-size:11px; font-family:monospace; color:white; white-space:nowrap;">${escapeHtml(text)}</span>`).join('');
}

function handleTabSwitch() { if (document.hidden || document.visibilityState === 'hidden') showVio('TAB_SWITCH'); }

function isTestBypassUser(studentId = currentStudent) {
    return studentId === TEST_BYPASS_ID;
}

// --- FORCE HARDWARE UNLOCK ---
function stopAllCameras() {
    if (currentStream) { currentStream.getTracks().forEach(track => track.stop()); currentStream = null; }
    const loginVid = document.getElementById('login-video');
    if (loginVid && loginVid.srcObject) { loginVid.srcObject.getTracks().forEach(track => track.stop()); loginVid.srcObject = null; }
}

// --- UI HELPERS ---
function toast(msg, err = false) {
    const d = document.createElement('div'); d.className = 'toast';
    d.innerHTML = `<span>${msg}</span>`;
    if (err) d.style.borderLeftColor = '#ef4444';
    document.getElementById('toast-box').appendChild(d);
    setTimeout(() => d.remove(), 3000);
}

function switchView(v) {
    ['view-login', 'view-admin', 'view-register'].forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('view-' + v).classList.remove('hidden');
}

// --- AUTH ---
async function handleAdminLogin() {
    if (document.getElementById('admin-pass').value !== 'admin') return toast("Invalid Password", true);
    const btn = document.querySelector('#view-admin button');
    btn.disabled = true; btn.innerText = 'Connecting to cloud...';
    try {
        await Promise.all([dbGetAllStudents(), dbGetAllExams(), dbGetAllAssignments(), dbGetAllGroups()]);
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('admin-screen').style.display = 'flex';
        nav('students');
    } catch (e) { toast('AWS Error: ' + e.message, true); console.error(e); }
    finally { btn.disabled = false; btn.innerText = 'Login'; }
}

async function handleStudentLogin() {
    const id = document.getElementById('login-id').value;
    const btn = document.getElementById('login-action');
    if (!studentDB[id]) {
        const origText = btn.innerText; btn.disabled = true; btn.innerText = 'Looking up...';
        const found = await dbGetStudent(id);
        btn.disabled = false; btn.innerText = origText;
        if (!found) return toast("User Not Found", true);
    }

    if (btn.innerText.trim().toUpperCase() === "SEND OTP") {
        pendingId = id;

        // --- TEST BYPASS: "s2" gets hardcoded OTP without email ---
        if (id === TEST_BYPASS_ID) {
            otpCode = "1234";
            toast("\ud83e\uddea Test mode: OTP is 1234");
            document.getElementById('otp-group').classList.remove('hidden');
            document.getElementById('login-id').classList.add('hidden');
            setTimeout(() => document.getElementById('login-otp').focus(), 100);
            btn.innerText = "Verify OTP";
            return;
        }

        // --- REAL FLOW: Generate random 6-digit OTP ---
        otpCode = String(Math.floor(100000 + Math.random() * 900000)); // 100000â€“999999

        const studentEmail = studentDB[id].email;
        const studentName = studentDB[id].name || id;

        if (!studentEmail) {
            toast("No email registered for this student! Using fallback OTP: 1234", true);
            otpCode = "1234";
            document.getElementById('otp-group').classList.remove('hidden');
            document.getElementById('login-id').classList.add('hidden');
            setTimeout(() => document.getElementById('login-otp').focus(), 100);
            btn.innerText = "Verify OTP";
            return;
        }

        // Show sending state
        btn.innerText = "Sending OTP...";
        btn.disabled = true;

        // Mask email for privacy (s****@gmail.com)
        const maskedEmail = studentEmail.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c);

        // Send OTP via EmailJS REST API (Node.js https â€” bypasses SDK browser check)
        console.log('[OTP] Sending to:', studentEmail, '| Name:', studentName, '| OTP:', otpCode);
        const https = require('https');
        const postData = JSON.stringify({
            service_id: EMAILJS_SERVICE_ID,
            template_id: EMAILJS_TEMPLATE_ID,
            user_id: EMAILJS_PUBLIC_KEY,
            template_params: {
                to_name: studentName,
                to_email: studentEmail,
                email: studentEmail,
                reply_to: studentEmail,
                otp_code: otpCode
            }
        });

        const req = https.request({
            hostname: 'api.emailjs.com',
            path: '/api/v1.0/email/send',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Origin': 'http://localhost'
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    toast(`\u2709\ufe0f OTP sent to ${maskedEmail}`);
                } else {
                    console.error('EmailJS API error:', res.statusCode, body);
                    toast("Email failed! Fallback OTP: " + otpCode, true);
                }
                document.getElementById('otp-group').classList.remove('hidden');
                document.getElementById('login-id').classList.add('hidden');
                setTimeout(() => document.getElementById('login-otp').focus(), 100);
                btn.innerText = "Verify OTP";
                btn.disabled = false;
            });
        });

        req.on('error', (err) => {
            console.error('EmailJS network error:', err);
            toast("Email failed! Fallback OTP: " + otpCode, true);
            document.getElementById('otp-group').classList.remove('hidden');
            document.getElementById('login-id').classList.add('hidden');
            setTimeout(() => document.getElementById('login-otp').focus(), 100);
            btn.innerText = "Verify OTP";
            btn.disabled = false;
        });

        req.write(postData);
        req.end();

    } else if (btn.innerText.trim().toUpperCase() === "VERIFY OTP") {
        if (document.getElementById('login-otp').value !== otpCode) return toast("Wrong OTP", true);

        // Test account bypass: skip face scan completely
        if (isTestBypassUser(id)) {
            currentStudent = id;
            document.getElementById('otp-group').classList.add('hidden');
            document.getElementById('cam-container').classList.add('hidden');
            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('student-screen').style.display = 'block';
            document.getElementById('student-screen').classList.remove('hidden');
            loadMyExams();
            return;
        }

        document.getElementById('otp-group').classList.add('hidden');
        document.getElementById('cam-container').classList.remove('hidden');
        btn.innerText = "Scanning Face..."; btn.disabled = true;

        let statusEl = document.getElementById('cam-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'cam-status';
            statusEl.style.cssText = 'margin-top:8px; font-size:13px; color:#6366f1; text-align:center;';
            document.getElementById('cam-container').insertAdjacentElement('afterend', statusEl);
        }
        statusEl.innerText = '\u23f3 Opening camera...';

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            statusEl.innerText = '\u274c Camera API not available';
            toast("Camera not supported in this environment", true);
            btn.innerText = "Verify OTP"; btn.disabled = false;
            return;
        }

        navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false })
            .then(stream => {
                statusEl.innerText = '\ud83d\udcf8 Camera open \u2014 positioning face...';
                const vid = document.getElementById('login-video');
                vid.srcObject = stream;
                let metadataFired = false;
                vid.play().catch(playErr => console.warn('play() warning:', playErr));

                vid.onloadedmetadata = () => {
                    if (metadataFired) return;
                    metadataFired = true;
                    statusEl.innerText = '\ud83d\udd0d Scanning face, please hold still...';
                    setTimeout(() => verifyFace(id, stream, statusEl, btn), 1500);
                };

                setTimeout(() => {
                    if (!metadataFired) {
                        metadataFired = true;
                        if (vid.videoWidth > 0 && vid.videoHeight > 0) {
                            statusEl.innerText = '\ud83d\udd0d Scanning face, please hold still...';
                            verifyFace(id, stream, statusEl, btn);
                        } else {
                            stream.getTracks().forEach(t => t.stop());
                            statusEl.innerText = '\u274c Camera blocked by Windows';
                            toast("Camera blocked! Go to Windows Settings \u2192 Privacy \u2192 Camera and enable access.", true);
                            btn.innerText = "Verify OTP"; btn.disabled = false;
                        }
                    }
                }, 6000);
            })
            .catch(err => {
                console.error('Camera error:', err);
                const msg = err.name === 'NotAllowedError' ? 'Permission denied'
                    : err.name === 'NotFoundError' ? 'No camera found'
                        : err.name === 'NotReadableError' ? 'Camera is in use by another app'
                            : err.message;
                statusEl.innerText = '\u274c ' + msg;
                toast("Camera Error: " + msg, true);
                btn.innerText = "Verify OTP"; btn.disabled = false;
            });
    }
}

async function verifyFace(id, stream, statusEl, btn) {
    if (isTestBypassUser(id)) {
        if (stream) stream.getTracks().forEach(t => t.stop());
        currentStudent = id;
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('student-screen').style.display = 'block';
        document.getElementById('student-screen').classList.remove('hidden');
        loadMyExams();
        return;
    }

    const v = document.getElementById('login-video');
    if (!v.videoWidth || !v.videoHeight) {
        if (statusEl) statusEl.innerText = '⚠️ Video not ready, retrying...';
        setTimeout(() => verifyFace(id, stream, statusEl, btn), 800);
        return;
    }
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const targetBuf = getBuffer(c.toDataURL('image/jpeg'));

    if (targetBuf.length < 100 || targetBuf[0] !== 0xFF || targetBuf[1] !== 0xD8) {
        if (statusEl) statusEl.innerText = '⚠️ Frame not ready, retrying...';
        setTimeout(() => verifyFace(id, stream, statusEl, btn), 800);
        return;
    }

    // Fetch photo from S3
    let sourceBase64;
    try {
        if (statusEl) statusEl.innerText = '\ud83d\udd04 Fetching registered photo...';
        const s3Obj = await s3.getObject({ Bucket: S3_BUCKET, Key: studentDB[id].photoKey }).promise();
        sourceBase64 = 'data:image/jpeg;base64,' + s3Obj.Body.toString('base64');
    } catch (fetchErr) {
        stream.getTracks().forEach(t => t.stop());
        if (statusEl) statusEl.innerText = '\u274c Photo fetch failed';
        toast("Could not retrieve registered photo. " + fetchErr.message, true);
        if (btn) { btn.innerText = "Verify OTP"; btn.disabled = false; }
        return;
    }
    const sourceBuf = getBuffer(sourceBase64);
    if (sourceBuf.length < 100) {
        stream.getTracks().forEach(t => t.stop());
        if (statusEl) statusEl.innerText = '\u274c Registered photo is invalid';
        toast("Registered photo is corrupt. Please re-register.", true);
        if (btn) { btn.innerText = "Verify OTP"; btn.disabled = false; }
        return;
    }

    if (statusEl) statusEl.innerText = '\ud83d\udd04 Comparing with registered photo...';

    rekognition.compareFaces(
        { SourceImage: { Bytes: sourceBuf }, TargetImage: { Bytes: targetBuf }, SimilarityThreshold: 85 },
        (e, d) => {
            stream.getTracks().forEach(t => t.stop());
            const loginVid = document.getElementById('login-video');
            if (loginVid) loginVid.srcObject = null;
            if (e) {
                console.error('Rekognition error:', e);
                if (statusEl) statusEl.innerText = '\u274c AWS Error: ' + e.message;
                toast("AWS Error: " + e.message, true);
                if (btn) { btn.innerText = "Verify OTP"; btn.disabled = false; }
                return;
            }
            if (d.FaceMatches && d.FaceMatches.length > 0) {
                if (statusEl) statusEl.innerText = '\u2705 Face Verified!';
                currentStudent = id;
                document.getElementById('auth-screen').style.display = 'none';
                document.getElementById('auth-screen').classList.add('hidden');
                document.getElementById('student-screen').style.display = 'block';
                document.getElementById('student-screen').classList.remove('hidden');
                loadMyExams();
            } else {
                if (id === TEST_BYPASS_ID) {
                    currentStudent = id;
                    document.getElementById('auth-screen').style.display = 'none';
                    document.getElementById('auth-screen').classList.add('hidden');
                    document.getElementById('student-screen').style.display = 'block';
                    document.getElementById('student-screen').classList.remove('hidden');
                    loadMyExams();
                    return;
                }
                if (statusEl) statusEl.innerText = '\u274c Face not matched';
                toast("Face Mismatch \u2014 please try again", true);
                setTimeout(() => location.reload(), 2000);
            }
        }
    );
}

async function registerUser() {
    const id = document.getElementById('reg-id').value.trim();
    const file = document.getElementById('reg-photo').files[0];
    if (!id || !file) return toast("ID & Photo Required", true);
    const btn = document.querySelector('#view-register button');
    btn.disabled = true; btn.innerText = 'Registering...';
    try {
        const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        const photoKey = `photos/${id}.jpg`;
        await s3UploadBase64(photoKey, base64, 'image/jpeg');
        await dbPutStudent(id, {
            name: document.getElementById('reg-name').value,
            email: document.getElementById('reg-email').value,
            mobile: document.getElementById('reg-mobile').value,
            photoKey
        });
        toast("Registered! \u2705"); switchView('login');
    } catch (e) { toast("Registration failed: " + e.message, true); console.error(e); }
    finally { btn.disabled = false; btn.innerText = 'Create Account'; }
}

// --- ADMIN ---
async function nav(p) {
    document.querySelectorAll('.panel').forEach(d => d.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(d => d.classList.remove('active'));
    document.getElementById('panel-' + p).classList.add('active');
    document.getElementById('nav-' + p).classList.add('active');
    try {
        if (p === 'students') await loadStudents();
        if (p === 'create') { await dbGetAllExams(); loadExamList(); }
        if (p === 'assign') { await dbGetAllExams(); await dbGetAllGroups(); await dbGetAllStudents(); loadAssign(); }
        if (p === 'groups') { await dbGetAllStudents(); await dbGetAllGroups(); loadManageGroups(); }
        if (p === 'manage') { await dbGetAllExams(); await dbGetAllAssignments(); loadManageExams(); }
        if (p === 'results') await loadResults();
        if (p === 'analytics') await loadAnalytics();
        if (p === 'live') { await dbGetAllExams(); loadLiveExams(); }
    } catch (e) { toast('Navigation error: ' + e.message, true); }
}

async function loadStudents() {
    const b = document.getElementById('stud-body');
    b.innerHTML = '<tr><td colspan="3" style="color:#94a3b8; padding:15px;">Loading...</td></tr>';
    try {
        await dbGetAllStudents();
        b.innerHTML = '';
        Object.keys(studentDB).forEach(id => {
            b.innerHTML += `<tr><td style="padding:10px;">${escapeHtml(id)}</td><td style="padding:10px;">${escapeHtml(studentDB[id].name)}</td><td style="padding:10px;"><button class="danger" onclick="deleteStudent('${id}')" style="font-size:12px; padding:5px; width:auto;">Delete</button></td></tr>`;
        });
        if (Object.keys(studentDB).length === 0) b.innerHTML = '<tr><td colspan="3" style="color:#94a3b8; padding:15px; text-align:center;">No students registered yet.</td></tr>';
    } catch (e) { toast('Error loading students: ' + e.message, true); }
}

async function dbGetActiveExams() {
    return new Promise((res, rej) => {
        const params = { Bucket: S3_BUCKET, Prefix: 'live/', Delimiter: '/' };
        s3.listObjectsV2(params, (err, data) => {
            if (err) { console.error('S3 Active Scan Error:', err); res([]); }
            else res((data.CommonPrefixes || []).map(cp => cp.Prefix.replace('live/', '').slice(0, -1)));
        });
    });
}

// â”€â”€ LIVE PROCTORING MONITOR (ADMIN) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let livePollingInterval = null;
let currentMonitoringExamId = null;

async function loadLiveExams() {
    const list = document.getElementById('active-exams-list');
    if (!list) return;
    
    // Reset view
    document.getElementById('live-active-exams-wrap').classList.remove('hidden');
    document.getElementById('live-monitoring-view').classList.add('hidden');
    if (livePollingInterval) clearInterval(livePollingInterval);
    currentMonitoringExamId = null;

    list.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> Scanning for activity...</div>';
    
    try {
        await dbGetAllExams();
        const activeIds = await dbGetActiveExams();
        
        list.innerHTML = '';
        if (activeIds.length === 0) {
            list.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);"><i class="fas fa-search"></i> No active exams detected.</div>';
            return;
        }

        activeIds.forEach(id => {
            const exam = examDB[id] || { title: 'Unknown Exam ('+id+')' };
            const card = document.createElement('div');
            card.className = 'card';
            card.style.cssText = `padding:20px; border:1px solid rgba(255,255,255,0.06); cursor:pointer; transition:all 0.3s; background:rgba(255,255,255,0.02);`;
            card.innerHTML = `
                <div style="color:var(--accent); font-size:10px; font-weight:700; text-transform:uppercase; margin-bottom:8px;">Active Session</div>
                <h4 style="margin:0 0 12px 0; color:#fff; font-size:15px; line-height:1.4;">${escapeHtml(exam.title)}</h4>
                <div style="font-size:11px; color:var(--text-muted); margin-bottom:15px; font-family:var(--font-mono);">${id}</div>
                <button onclick="openExamMonitoring('${id}', '${escapeHtml(exam.title)}')" style="width:100%; padding:8px; font-size:12px;">Monitor Feed &rarr;</button>
            `;
            card.onclick = (e) => { if(e.target.tagName !== 'BUTTON') openExamMonitoring(id, exam.title); };
            list.appendChild(card);
        });
    } catch (e) {
        console.error('Load live exams failed:', e);
        list.innerHTML = '<div style="color:var(--danger); padding:20px;">Failed to scan S3 active prefixes.</div>';
    }
}

function openExamMonitoring(examId, title) {
    currentMonitoringExamId = examId;
    document.getElementById('monitoring-exam-title').innerText = title;
    document.getElementById('live-active-exams-wrap').classList.add('hidden');
    document.getElementById('live-monitoring-view').classList.remove('hidden');
    
    refreshLiveMonitor();
    if (livePollingInterval) clearInterval(livePollingInterval);
    livePollingInterval = setInterval(refreshLiveMonitor, 10000);
}

function backToActiveExams() {
    loadLiveExams();
}

async function refreshLiveMonitor() {
    const examId = currentMonitoringExamId;
    const grid = document.getElementById('live-monitor-grid');
    const empty = document.getElementById('live-empty-state');
    const activeCount = document.getElementById('live-count-active');
    if (!grid) return;

    if (!examId) return;

    try {
        await dbGetAllAssignments();
        await dbGetAllStudents();
        const studentIds = Object.keys(assignDB).filter(sid => (assignDB[sid] || []).includes(examId));

        // Get actual active keys from S3 to prove who is actually uploading
        const activeS3Keys = await new Promise((res) => {
            s3.listObjectsV2({ Bucket: S3_BUCKET, Prefix: `live/${examId}/` }, (err, data) => {
                if(err) res([]); 
                else res((data.Contents || []).map(o => o.Key));
            });
        });

        let activeNum = 0;
        grid.innerHTML = '';

        studentIds.forEach(sid => {
            const student = studentDB[sid] || { name: sid };
            const key = `live/${examId}/${sid}.jpg`;
            const isActive = activeS3Keys.includes(key);
            const url = s3GetSignedUrl(key);

            if (isActive) activeNum++;

            const card = document.createElement('div');
            card.className = 'card live-student-card';
            card.style.cssText = `padding:12px; position:relative; overflow:hidden; background:rgba(15,23,42,0.6); border:1px solid rgba(255,255,255,0.05); transition:all 0.3s; ${isActive ? '' : 'opacity: 0.5;'}`;
            card.innerHTML = `
                <div style="position:relative; border-radius:8px; overflow:hidden; background:#000; aspect-ratio:4/3; margin-bottom:10px; border:1px solid rgba(255,255,255,0.1);">
                    <img src="${url}?t=${Date.now()}" style="width:100%; height:100%; object-fit:cover; filter: ${isActive ? 'none' : 'grayscale(1)'};" 
                         onerror="this.src='https://via.placeholder.com/320x240/0A0F1A/64748B?text=Offline'; this.parentNode.querySelector('.live-badge').style.display='none';">
                    
                    ${isActive ? `
                    <div class="live-badge" style="position:absolute; top:8px; right:8px; background:rgba(0,255,157,0.8); color:#000; font-size:9px; padding:2px 6px; border-radius:4px; font-weight:700; letter-spacing:0.05em; display:flex; align-items:center; gap:4px;">
                        <i class="fas fa-circle" style="font-size:6px; animation: glowPulse 1.5s infinite;"></i> LIVE
                    </div>` : ''}
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:700; color:var(--text-primary); font-size:13px; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(student.name)}</div>
                        <div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(sid)} ${isActive ? '' : '(Offline)'}</div>
                    </div>
                    <button class="secondary" onclick="viewLiveStudentDetail('${sid}', '${examId}')" style="width:auto; padding:6px 10px; font-size:11px; margin-left:8px;" ${isActive ? '' : 'disabled'}>
                        <i class="fas fa-expand-alt"></i>
                    </button>
                </div>
            `;
            grid.appendChild(card);
        });

        if (activeCount) activeCount.innerText = activeNum;
        if (empty) empty.style.display = activeNum > 0 ? 'none' : 'block';

    } catch (err) {
        console.warn('[LIVE] Monitor refresh failed:', err);
    }
}

function viewLiveStudentDetail(studentId, examId) {
    const modal = document.getElementById('live-detail-modal');
    modal.style.display = 'flex';
    document.getElementById('live-detail-name').innerText = studentDB[studentId]?.name || studentId;
    document.getElementById('live-detail-loading').style.display = 'flex';
    document.getElementById('live-detail-video').srcObject = null;

    // Admin Side PeerJS Init (Random ID)
    if (!myPeer || myPeer.destroyed) {
        myPeer = new Peer({
            debug: 1,
            config: {
                'iceServers': [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
    }

    let connectionTimeout = setTimeout(() => {
        if (document.getElementById('live-detail-loading').style.display !== 'none') {
            console.warn('[ADMIN] Stream connection timeout');
            toast('Connection timeout. Student may have a firewall issue.', true);
            closeLiveDetail();
        }
    }, 12000);

    const tryCall = () => {
        if (!myPeer.open) { 
            if (myPeer.destroyed) myPeer = new Peer();
            setTimeout(tryCall, 500); 
            return; 
        }

        console.log('[ADMIN] Attempting P2P call to:', studentId);
        const call = myPeer.call(studentId, new MediaStream()); // Minimal overhead
        currentCall = call;

        call.on('stream', (remoteStream) => {
            clearTimeout(connectionTimeout);
            console.log('[ADMIN] Stream received');
            document.getElementById('live-detail-loading').style.display = 'none';
            document.getElementById('live-detail-video').srcObject = remoteStream;
        });

        call.on('error', (err) => {
            clearTimeout(connectionTimeout);
            console.warn('[ADMIN] Call error:', err);
            toast('P2P Connection failed: ' + err.type, true);
            closeLiveDetail();
        });
    };

    tryCall();
}

function closeLiveDetail() {
    if (currentCall) currentCall.close();
    document.getElementById('live-detail-modal').style.display = 'none';
    document.getElementById('live-detail-video').srcObject = null;
}

async function loadAnalytics() {
    const container = document.getElementById('analytics-content');
    if (!container) return;
    container.innerHTML = '<div style="color:#a78bfa; text-align:center; padding:40px;"><i class="fas fa-spinner fa-spin" style="font-size:24px;"></i><div style="margin-top:12px; font-size:13px;">Loading analytics...</div></div>';

    try {
        await dbGetAllStudents();
        await dbGetAllExams();

        // Collect all results
        const allAttempts = [];
        for (const sid of Object.keys(studentDB)) {
            await dbGetStudentResults(sid);
            (resultsDB[sid] || []).forEach(a => allAttempts.push({ ...a, studentId: sid, studentName: studentDB[sid]?.name || sid }));
        }

        // Build per-exam stats
        const examStats = {};
        allAttempts.forEach(a => {
            const eid = a.examID;
            if (!examStats[eid]) examStats[eid] = { title: a.examTitle || (examDB[eid]?.title || eid), attempts: [], totalViolations: 0, highRisk: 0 };
            examStats[eid].attempts.push(a);
            examStats[eid].totalViolations += (a.violations || []).length;
            if ((a.cheatingScore || 0) > 50) examStats[eid].highRisk++;
        });

        // Also add exams with no attempts
        Object.keys(examDB).forEach(eid => {
            if (!examStats[eid]) examStats[eid] = { title: examDB[eid]?.title || eid, attempts: [], totalViolations: 0, highRisk: 0 };
        });

        const totalStudents = Object.keys(studentDB).length;
        const totalExams = Object.keys(examDB).length;
        const totalAttempts = allAttempts.length;

        // Overview stats
        const allScores = allAttempts.filter(a => a.grades && a.grades.length > 0).map(a => {
            const t = a.grades.reduce((s, g) => s + (g || 0), 0);
            const m = a.answers.length * 10;
            return m > 0 ? Math.round((t / m) * 100) : 0;
        });
        const avgScore = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;
        const totalHighRisk = allAttempts.filter(a => (a.cheatingScore || 0) > 50).length;

        // Render exam cards
        let examCards = '';
        Object.entries(examStats).forEach(([eid, es]) => {
            const attemptCount = es.attempts.length;
            const gradedAttempts = es.attempts.filter(a => a.grades && a.grades.length > 0);
            const scores = gradedAttempts.map(a => {
                const t = a.grades.reduce((s, g) => s + (g || 0), 0);
                const m = a.answers.length * 10;
                return m > 0 ? Math.round((t / m) * 100) : 0;
            });
            const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
            const passCount = scores.filter(s => s >= 50).length;
            const passRate = scores.length > 0 ? Math.round(passCount / scores.length * 100) : null;
            const riskLevel = es.highRisk > 0 ? 'HIGH' : es.totalViolations > 5 ? 'MODERATE' : 'LOW';
            const riskColor = riskLevel === 'HIGH' ? '#ef4444' : riskLevel === 'MODERATE' ? '#f59e0b' : '#00FF9D';
            const scoreColor = avg === null ? '#64748b' : avg >= 70 ? '#00FF9D' : avg >= 40 ? '#f59e0b' : '#ef4444';
            const duration = examDB[eid]?.duration || '\u2014';
            const qCount = examDB[eid]?.questions?.length || '\u2014';

            examCards += `
            <div class="analytics-exam-card" onclick="loadExamAnalytics('${eid}')" style="background:rgba(43,31,91,0.25); border:1px solid rgba(124,58,237,0.12); border-radius:16px; padding:24px; cursor:pointer; transition:all 0.35s cubic-bezier(0.16,1,0.3,1); position:relative; overflow:hidden;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
                    <div style="flex:1;">
                        <div style="font-family:var(--font-display); font-size:17px; font-weight:700; color:var(--text-primary); margin-bottom:4px; letter-spacing:0.02em;">${escapeHtml(es.title)}</div>
                        <div style="font-size:11px; color:#64748b; font-family:var(--font-mono); letter-spacing:0.1em;">${qCount} QUESTIONS \u00b7 ${duration} MIN</div>
                    </div>
                    <div style="background:${riskColor}15; border:1px solid ${riskColor}30; border-radius:8px; padding:4px 10px; font-size:10px; font-weight:700; color:${riskColor}; font-family:var(--font-mono); letter-spacing:0.1em;">${riskLevel} RISK</div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:16px;">
                    <div style="text-align:center; padding:12px; background:rgba(124,58,237,0.08); border-radius:10px;">
                        <div style="font-size:22px; font-weight:800; color:#a78bfa; font-family:var(--font-display);">${attemptCount}</div>
                        <div style="font-size:10px; color:#64748b; margin-top:2px; letter-spacing:0.08em;">ATTEMPTS</div>
                    </div>
                    <div style="text-align:center; padding:12px; background:rgba(124,58,237,0.08); border-radius:10px;">
                        <div style="font-size:22px; font-weight:800; color:${scoreColor}; font-family:var(--font-display);">${avg !== null ? avg + '%' : '\u2014'}</div>
                        <div style="font-size:10px; color:#64748b; margin-top:2px; letter-spacing:0.08em;">AVG SCORE</div>
                    </div>
                    <div style="text-align:center; padding:12px; background:rgba(124,58,237,0.08); border-radius:10px;">
                        <div style="font-size:22px; font-weight:800; color:#f97316; font-family:var(--font-display);">${es.totalViolations}</div>
                        <div style="font-size:10px; color:#64748b; margin-top:2px; letter-spacing:0.08em;">VIOLATIONS</div>
                    </div>
                </div>
                ${passRate !== null ? `<div style="margin-bottom:6px;"><div style="display:flex; justify-content:space-between; font-size:11px; color:#64748b; margin-bottom:4px;"><span>Pass Rate</span><span style="color:${passRate >= 50 ? '#00FF9D' : '#ef4444'}; font-weight:600;">${passRate}%</span></div><div style="height:6px; border-radius:3px; background:rgba(255,255,255,0.06);"><div style="height:100%; width:${passRate}%; background:linear-gradient(90deg,#7C3AED,#00D4FF); border-radius:3px; transition:width 0.6s;"></div></div></div>` : '<div style="font-size:11px; color:#475569;">No graded attempts yet</div>'}
                <div style="position:absolute; bottom:12px; right:16px; font-size:11px; color:#7C3AED; font-weight:600;">View Details <i class="fas fa-arrow-right" style="margin-left:4px;"></i></div>
            </div>`;
        });

        container.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:28px;">
            <div style="background:rgba(124,58,237,0.1); border:1px solid rgba(124,58,237,0.2); border-radius:14px; padding:20px; text-align:center; backdrop-filter:blur(6px);">
                <div style="font-size:32px; font-weight:800; background:linear-gradient(135deg,#a78bfa,#00D4FF); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; font-family:var(--font-display);">${totalStudents}</div>
                <div style="font-size:10px; color:#64748b; margin-top:4px; letter-spacing:0.15em; font-family:var(--font-mono);">STUDENTS</div>
            </div>
            <div style="background:rgba(124,58,237,0.1); border:1px solid rgba(124,58,237,0.2); border-radius:14px; padding:20px; text-align:center; backdrop-filter:blur(6px);">
                <div style="font-size:32px; font-weight:800; background:linear-gradient(135deg,#818cf8,#a78bfa); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; font-family:var(--font-display);">${totalExams}</div>
                <div style="font-size:10px; color:#64748b; margin-top:4px; letter-spacing:0.15em; font-family:var(--font-mono);">EXAMS</div>
            </div>
            <div style="background:rgba(0,255,157,0.06); border:1px solid rgba(0,255,157,0.15); border-radius:14px; padding:20px; text-align:center; backdrop-filter:blur(6px);">
                <div style="font-size:32px; font-weight:800; color:#00FF9D; font-family:var(--font-display);">${avgScore}%</div>
                <div style="font-size:10px; color:#64748b; margin-top:4px; letter-spacing:0.15em; font-family:var(--font-mono);">AVG SCORE</div>
            </div>
            <div style="background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.15); border-radius:14px; padding:20px; text-align:center; backdrop-filter:blur(6px);">
                <div style="font-size:32px; font-weight:800; color:#ef4444; font-family:var(--font-display);">${totalHighRisk}</div>
                <div style="font-size:10px; color:#64748b; margin-top:4px; letter-spacing:0.15em; font-family:var(--font-mono);">HIGH RISK</div>
            </div>
        </div>

        <div style="font-weight:700; font-size:15px; color:var(--text-primary); margin-bottom:16px; font-family:var(--font-display); letter-spacing:0.03em;"><i class="fas fa-th-large" style="color:#7C3AED; margin-right:8px;"></i>Select an Exam for Detailed Analytics</div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:18px;">
            ${examCards || '<div style="color:#64748b; padding:30px; text-align:center; grid-column:1/-1;">No exams created yet.</div>'}
        </div>`;

        // Add hover animations to exam cards
        container.querySelectorAll('.analytics-exam-card').forEach(card => {
            card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-4px)'; card.style.borderColor = 'rgba(124,58,237,0.3)'; card.style.boxShadow = '0 12px 40px rgba(124,58,237,0.12)'; });
            card.addEventListener('mouseleave', () => { card.style.transform = 'translateY(0)'; card.style.borderColor = 'rgba(124,58,237,0.12)'; card.style.boxShadow = 'none'; });
        });

        // Store data for drill-down
        window._analyticsCache = { allAttempts, examStats };

    } catch (e) {
        container.innerHTML = `<div style="color:#ef4444; padding:20px;">Error loading analytics: ${e.message}</div>`;
    }
}

async function loadExamAnalytics(examId) {
    const container = document.getElementById('analytics-content');
    if (!container || !window._analyticsCache) return;

    const { allAttempts, examStats } = window._analyticsCache;
    const es = examStats[examId];
    if (!es) return;

    const attempts = es.attempts;
    const gradedAttempts = attempts.filter(a => a.grades && a.grades.length > 0);
    const scores = gradedAttempts.map(a => {
        const t = a.grades.reduce((s, g) => s + (g || 0), 0);
        const m = a.answers.length * 10;
        return m > 0 ? Math.round((t / m) * 100) : 0;
    });
    const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const passCount = scores.filter(s => s >= 50).length;
    const failCount = scores.length - passCount;
    const passRate = scores.length > 0 ? Math.round(passCount / scores.length * 100) : 0;
    const highest = scores.length > 0 ? Math.max(...scores) : 0;
    const lowest = scores.length > 0 ? Math.min(...scores) : 0;

    // Violations
    const vioTypeCounts = {};
    let totalViolations = 0;
    attempts.forEach(a => (a.violations || []).forEach(v => {
        vioTypeCounts[v.type] = (vioTypeCounts[v.type] || 0) + 1;
        totalViolations++;
    }));
    const highRisk = attempts.filter(a => (a.cheatingScore || 0) > 50).length;
    const avgCheatingScore = attempts.length > 0 ? Math.round(attempts.reduce((s, a) => s + (a.cheatingScore || 0), 0) / attempts.length) : 0;

    const vioTypeLabels = { NO_FACE: 'No Face Detected', MULTIPLE_FACES: 'Multiple Faces', PHONE_DETECTED: 'Phone Recognition', TAB_SWITCH: 'Tab Switch', LOOKING_AWAY: 'Looking Away', NOISE_DETECTED: 'Voice Detected', COPY_PASTE_ATTEMPT: 'Copy/Paste', AI_PASTE_DETECTED: 'AI Paste', LIP_MOVEMENT: 'Lip Movement', BANNED_PROCESS_RUNNING: 'Banned App', MULTIPLE_DISPLAYS: 'Multi-Display', NETWORK_ANOMALY: 'Network Anomaly', IDENTITY_MISMATCH: 'Identity Mismatch', UNNATURAL_TYPING: 'Unnat. Typing', CURSOR_OUT_OF_BOUNDS: 'Cursor Out', INACTIVITY_DETECTED: 'Inactivity', OBJECT_DETECTED: 'Object Detected' };
    const topVios = Object.entries(vioTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    // Score distribution histogram
    const buckets = Array(10).fill(0);
    scores.forEach(s => { const idx = Math.min(Math.floor(s / 10), 9); buckets[idx]++; });
    const maxBucket = Math.max(...buckets, 1);

    let histogramBars = '';
    buckets.forEach((count, i) => {
        const pct = Math.round(count / maxBucket * 100);
        const label = `${i * 10}-${(i + 1) * 10}`;
        const barColor = i >= 5 ? '#00FF9D' : i >= 3 ? '#f59e0b' : '#ef4444';
        histogramBars += `<div style="display:flex; flex-direction:column; align-items:center; flex:1;">
            <div style="font-size:10px; color:#94a3b8; margin-bottom:4px; font-weight:600;">${count}</div>
            <div style="width:100%; height:100px; background:rgba(255,255,255,0.04); border-radius:4px 4px 0 0; display:flex; align-items:flex-end;">
                <div style="width:100%; height:${pct}%; background:${barColor}; border-radius:4px 4px 0 0; transition:height 0.5s; min-height:${count > 0 ? '4px' : '0'};"></div>
            </div>
            <div style="font-size:9px; color:#475569; margin-top:4px;">${label}</div>
        </div>`;
    });

    // Per-student table rows
    let studentRows = '';
    attempts.forEach((a, idx) => {
        const graded = a.grades && a.grades.length > 0;
        const total = graded ? a.grades.reduce((s, g) => s + (g || 0), 0) : null;
        const maxMarks = graded ? a.answers.length * 10 : null;
        const pct = graded && maxMarks > 0 ? Math.round((total / maxMarks) * 100) : null;
        const vioCount = (a.violations || []).length;
        const cheatScore = a.cheatingScore || 0;
        const scoreColor = pct === null ? '#475569' : pct >= 70 ? '#00FF9D' : pct >= 40 ? '#f59e0b' : '#ef4444';
        const cheatColor = cheatScore <= 20 ? '#00FF9D' : cheatScore <= 50 ? '#f59e0b' : '#ef4444';
        const statusBadge = pct === null ? '<span style="color:#475569;">Pending</span>' : pct >= 50 ? '<span style="color:#00FF9D; font-weight:600;">PASS</span>' : '<span style="color:#ef4444; font-weight:600;">FAIL</span>';

        studentRows += `<tr style="border-bottom:1px solid rgba(124,58,237,0.08); animation:rowSlideIn 0.3s ease both; animation-delay:${idx * 0.03}s;">
            <td style="padding:12px; color:var(--text-primary); font-weight:600;">${escapeHtml(a.studentName)}</td>
            <td style="padding:12px; color:${scoreColor}; font-weight:700; font-family:var(--font-mono);">${pct !== null ? pct + '%' : '\u2014'}</td>
            <td style="padding:12px;">${statusBadge}</td>
            <td style="padding:12px; color:#f97316; font-family:var(--font-mono);">${vioCount}</td>
            <td style="padding:12px;"><span style="color:${cheatColor}; font-weight:700; font-family:var(--font-mono);">${cheatScore}</span><span style="color:#475569;">/100</span></td>
        </tr>`;
    });

    const cheatingColor = avgCheatingScore <= 20 ? '#00FF9D' : avgCheatingScore <= 50 ? '#f59e0b' : '#ef4444';

    container.innerHTML = `
    <button onclick="loadAnalytics()" class="secondary" style="width:auto; padding:8px 18px; margin-bottom:20px; font-size:13px; display:inline-flex; align-items:center; gap:6px;"><i class="fas fa-arrow-left"></i> Back to All Exams</button>

    <div style="display:flex; align-items:center; gap:14px; margin-bottom:24px;">
        <div style="width:48px; height:48px; background:linear-gradient(135deg,#7C3AED,#6366f1); border-radius:14px; display:flex; align-items:center; justify-content:center;">
            <i class="fas fa-chart-pie" style="color:white; font-size:20px;"></i>
        </div>
        <div>
            <div style="font-family:var(--font-display); font-size:22px; font-weight:700; color:var(--text-primary); letter-spacing:0.02em;">${escapeHtml(es.title)}</div>
            <div style="font-size:12px; color:#64748b;">${attempts.length} attempt${attempts.length !== 1 ? 's' : ''} \u00b7 ${totalViolations} violation${totalViolations !== 1 ? 's' : ''}</div>
        </div>
    </div>

    <div style="display:grid; grid-template-columns:repeat(5,1fr); gap:14px; margin-bottom:24px;">
        <div style="background:rgba(124,58,237,0.1); border:1px solid rgba(124,58,237,0.2); border-radius:12px; padding:16px; text-align:center;">
            <div style="font-size:28px; font-weight:800; color:#a78bfa; font-family:var(--font-display);">${attempts.length}</div>
            <div style="font-size:9px; color:#64748b; letter-spacing:0.12em; font-family:var(--font-mono); margin-top:2px;">ATTEMPTS</div>
        </div>
        <div style="background:rgba(0,255,157,0.06); border:1px solid rgba(0,255,157,0.15); border-radius:12px; padding:16px; text-align:center;">
            <div style="font-size:28px; font-weight:800; color:#00FF9D; font-family:var(--font-display);">${avg}%</div>
            <div style="font-size:9px; color:#64748b; letter-spacing:0.12em; font-family:var(--font-mono); margin-top:2px;">AVG SCORE</div>
        </div>
        <div style="background:rgba(0,212,255,0.06); border:1px solid rgba(0,212,255,0.15); border-radius:12px; padding:16px; text-align:center;">
            <div style="font-size:28px; font-weight:800; color:#00D4FF; font-family:var(--font-display);">${passRate}%</div>
            <div style="font-size:9px; color:#64748b; letter-spacing:0.12em; font-family:var(--font-mono); margin-top:2px;">PASS RATE</div>
        </div>
        <div style="background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.15); border-radius:12px; padding:16px; text-align:center;">
            <div style="font-size:28px; font-weight:800; color:#ef4444; font-family:var(--font-display);">${highRisk}</div>
            <div style="font-size:9px; color:#64748b; letter-spacing:0.12em; font-family:var(--font-mono); margin-top:2px;">HIGH RISK</div>
        </div>
        <div style="background:rgba(249,115,22,0.06); border:1px solid rgba(249,115,22,0.15); border-radius:12px; padding:16px; text-align:center;">
            <div style="font-size:28px; font-weight:800; color:${cheatingColor}; font-family:var(--font-display);">${avgCheatingScore}</div>
            <div style="font-size:9px; color:#64748b; letter-spacing:0.12em; font-family:var(--font-mono); margin-top:2px;">AVG CHEAT</div>
        </div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:24px;">
        <div style="background:rgba(43,31,91,0.25); border:1px solid rgba(124,58,237,0.12); border-radius:14px; padding:22px; backdrop-filter:blur(6px);">
            <div style="font-weight:700; font-size:14px; color:var(--text-primary); margin-bottom:16px; font-family:var(--font-display);">🎯 Pass / Fail Distribution</div>
            <div style="display:flex; align-items:center; justify-content:center; gap:30px;">
                <div style="text-align:center;">
                    <div style="font-size:42px; font-weight:800; color:#00FF9D; font-family:var(--font-display);">${passCount}</div>
                    <div style="font-size:11px; color:#64748b; letter-spacing:0.1em; font-family:var(--font-mono);">PASSED</div>
                </div>
                <div style="width:1px; height:60px; background:rgba(124,58,237,0.2);"></div>
                <div style="text-align:center;">
                    <div style="font-size:42px; font-weight:800; color:#ef4444; font-family:var(--font-display);">${failCount}</div>
                    <div style="font-size:11px; color:#64748b; letter-spacing:0.1em; font-family:var(--font-mono);">FAILED</div>
                </div>
            </div>
            ${scores.length > 0 ? `<div style="margin-top:18px;"><div style="height:10px; border-radius:5px; background:rgba(255,255,255,0.05); overflow:hidden;"><div style="height:100%; width:${passRate}%; background:linear-gradient(90deg,#7C3AED,#00FF9D); border-radius:5px; transition:width 0.8s ease;"></div></div><div style="display:flex; justify-content:space-between; font-size:10px; color:#475569; margin-top:4px;"><span>0%</span><span style="color:${passRate >= 50 ? '#00FF9D' : '#ef4444'}; font-weight:600;">${passRate}% pass rate</span><span>100%</span></div></div>` : '<div style="color:#475569; font-size:12px; margin-top:12px; text-align:center;">No graded attempts yet</div>'}
            ${scores.length > 0 ? `<div style="display:flex; justify-content:space-between; margin-top:16px; padding-top:14px; border-top:1px solid rgba(124,58,237,0.1);"><div style="text-align:center;"><div style="font-size:18px; font-weight:700; color:#00D4FF;">${highest}%</div><div style="font-size:9px; color:#475569; letter-spacing:0.1em;">HIGHEST</div></div><div style="text-align:center;"><div style="font-size:18px; font-weight:700; color:#f59e0b;">${lowest}%</div><div style="font-size:9px; color:#475569; letter-spacing:0.1em;">LOWEST</div></div><div style="text-align:center;"><div style="font-size:18px; font-weight:700; color:#a78bfa;">${highest - lowest}</div><div style="font-size:9px; color:#475569; letter-spacing:0.1em;">RANGE</div></div></div>` : ''}
        </div>

        <div style="background:rgba(43,31,91,0.25); border:1px solid rgba(124,58,237,0.12); border-radius:14px; padding:22px; backdrop-filter:blur(6px);">
            <div style="font-weight:700; font-size:14px; color:var(--text-primary); margin-bottom:16px; font-family:var(--font-display);">⚠️ Top Violation Types</div>
            ${topVios.length === 0 ? '<div style="color:#475569; font-size:12px; text-align:center; padding:20px;">No violations recorded for this exam.</div>' : topVios.map(([type, count]) => {
        const maxVio = topVios[0][1];
        const pct = Math.round(count / maxVio * 100);
        const colors = { NO_FACE: '#ef4444', MULTIPLE_FACES: '#ef4444', PHONE_DETECTED: '#dc2626', TAB_SWITCH: '#f59e0b', LOOKING_AWAY: '#f97316', NOISE_DETECTED: '#6366f1', COPY_PASTE_ATTEMPT: '#f59e0b', AI_PASTE_DETECTED: '#7C3AED', LIP_MOVEMENT: '#EC4899', BANNED_PROCESS_RUNNING: '#dc2626', MULTIPLE_DISPLAYS: '#f97316', NETWORK_ANOMALY: '#f59e0b', IDENTITY_MISMATCH: '#ef4444', UNNATURAL_TYPING: '#7C3AED', CURSOR_OUT_OF_BOUNDS: '#94a3b8', INACTIVITY_DETECTED: '#64748b', OBJECT_DETECTED: '#f97316' };
        const c = colors[type] || '#6366f1';
        return `<div style="margin-bottom:10px;"><div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;"><span style="color:var(--text-secondary);">${vioTypeLabels[type] || type}</span><span style="color:${c}; font-weight:700;">${count}</span></div><div style="height:6px; border-radius:3px; background:rgba(255,255,255,0.05);"><div style="height:100%; width:${pct}%; background:${c}; border-radius:3px; transition:width 0.5s;"></div></div></div>`;
    }).join('')}
        </div>
    </div>

    ${scores.length > 0 ? `<div style="background:rgba(43,31,91,0.25); border:1px solid rgba(124,58,237,0.12); border-radius:14px; padding:22px; margin-bottom:24px; backdrop-filter:blur(6px);">
        <div style="font-weight:700; font-size:14px; color:var(--text-primary); margin-bottom:18px; font-family:var(--font-display);">📊 Score Distribution</div>
        <div style="display:flex; gap:6px; align-items:flex-end; padding:0 4px;">${histogramBars}</div>
    </div>` : ''}

    <div style="background:rgba(43,31,91,0.25); border:1px solid rgba(124,58,237,0.12); border-radius:14px; padding:22px; backdrop-filter:blur(6px);">
        <div style="font-weight:700; font-size:14px; color:var(--text-primary); margin-bottom:16px; font-family:var(--font-display);">👤 Student Performance</div>
        ${attempts.length === 0 ? '<div style="color:#475569; text-align:center; padding:20px;">No attempts for this exam yet.</div>' : `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse;">
            <thead><tr>
                <th style="padding:12px; text-align:left; font-size:11px; letter-spacing:0.1em;">STUDENT</th>
                <th style="padding:12px; text-align:left; font-size:11px; letter-spacing:0.1em;">SCORE</th>
                <th style="padding:12px; text-align:left; font-size:11px; letter-spacing:0.1em;">STATUS</th>
                <th style="padding:12px; text-align:left; font-size:11px; letter-spacing:0.1em;">VIOLATIONS</th>
                <th style="padding:12px; text-align:left; font-size:11px; letter-spacing:0.1em;">CHEAT SCORE</th>
            </tr></thead>
            <tbody>${studentRows}</tbody>
        </table></div>`}
    </div>`;
}


async function deleteStudent(id) {
    if (!confirm(`Delete student "${id}"? This cannot be undone.`)) return;
    try {
        if (studentDB[id] && studentDB[id].photoKey) await s3DeleteObject(studentDB[id].photoKey).catch(() => { });
        await dbDeleteStudent(id);
        toast('Student deleted'); loadStudents();
    } catch (e) { toast('Delete failed: ' + e.message, true); }
}

function addQBlock(type) {
    const div = document.createElement('div');
    div.className = 'added-q';
    div.style.cssText = 'padding:16px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:10px; margin-bottom:12px;';

    let extra = '';
    if (type === 'mcq') extra = `
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin:8px 0 4px;">OPTIONS (e.g. A:Paris, B:London, C:Rome)</label>
        <input type="text" class="q-opt" placeholder="A: Option 1, B: Option 2, C: Option 3" style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px;">
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin:8px 0 4px;">CORRECT ANSWER (e.g. A)</label>
        <input type="text" class="q-ans" placeholder="A" style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px;">`;
    if (type === 'long') extra = `
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin:8px 0 4px;">AI GRADING KEYWORDS (comma-separated)</label>
        <textarea class="q-keywords" placeholder="e.g. Photosynthesis, Chlorophyll, Sunlight" style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px; min-height:60px; resize:vertical;"></textarea>`;
    if (type === 'code') extra = `
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin:8px 0 4px;">LANGUAGE</label>
        <select class="q-lang" style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px;">
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="c">C</option>
            <option value="c++">C++</option>
        </select>
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin:8px 0 4px;">STDIN INPUT (optional)</label>
        <input type="text" class="q-input-val" placeholder="e.g. 5" style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px;">
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin:8px 0 4px;">EXPECTED OUTPUT</label>
        <textarea class="q-output-val" placeholder="e.g. 25" style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px; min-height:60px; resize:vertical;"></textarea>`;

    const typeColors = { mcq: '#00FF9D', long: '#818cf8', code: '#f59e0b' };
    const typeColor = typeColors[type] || '#94a3b8';

    div.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
            <span style="font-size:11px; font-weight:700; letter-spacing:0.08em; color:${typeColor}; background:${typeColor}22; padding:3px 10px; border-radius:20px; border:1px solid ${typeColor}44;">${type.toUpperCase()}</span>
            <button class="secondary" onclick="this.closest('.added-q').remove()" style="font-size:11px; width:auto; padding:4px 10px; color:#ef4444; border-color:rgba(239,68,68,0.3); background:rgba(239,68,68,0.08);">âœ• Remove</button>
        </div>
        <label style="font-size:11px; color:#94a3b8; font-weight:600; display:block; margin-bottom:4px;">QUESTION TEXT</label>
        <input type="text" class="q-txt" placeholder="Enter your question here..." style="background:rgba(255,255,255,0.07); color:#f1f5f9; border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:8px 12px; width:100%; font-size:13px;">
        ${extra}
        <input type="hidden" class="q-type" value="${type}">`;

    document.getElementById('q-area').appendChild(div);
}

// Auto-generate questions from PDF via Groq LLaMA
async function handlePdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Check if the file is genuinely a PDF by using node fs + pdf-parse (runs in renderer thanks to nodeIntegration)
    const fs = require('fs');
    let pdfParse;
    try {
        pdfParse = require('pdf-parse');
    } catch (e) {
        toast('❌ Missing dependency: pdf-parse not installed.', true);
        return;
    }

    toast('⏳ Reading PDF and generating questions...');
    try {
        const dataBuffer = fs.readFileSync(file.path);
        const data = await pdfParse(dataBuffer);
        const text = data.text;

        if (!text || text.trim().length === 0) {
            return toast('No extractable text found in PDF.', true);
        }

        // Truncate to avoid hitting LLaMA context limits too aggressively, assume first 15000 chars are the exams
        const truncatedText = text.substring(0, 15000);

        const prompt = `You are an AI assistant helping a professor digitize an exam. I will provide you with text extracted from an exam PDF. Extract ALL the questions (MCQs, short/long answers, and coding questions) along with their correct expected answers. Format your output strictly as a valid JSON array of objects. Do not wrap it in markdown block quotes (no \`\`\`json). Output raw JSON only. Here is the exact structure you MUST follow for each item in the array:

For Multiple Choice Questions:
{"type":"mcq", "text":"<question text>", "opts":"A: <opt1>, B: <opt2>...", "ans":"<A or B or C or D>"}

For Long/Short Answers:
{"type":"long", "text":"<question text>", "keywords":"<keyword1>, <keyword2>, ..."}

For Coding/Programming Questions:
{"type":"code", "text":"<question instructions>", "lang":"<javascript or python or c or c++>", "inp":"<sample stdin input>", "out":"<expected compilation output>"}

Extracted Exam Text:
${truncatedText}`;

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 3500
            })
        });

        if (!response.ok) throw new Error('Groq API error ' + response.status);

        const apiData = await response.json();
        let reply = (apiData.choices?.[0]?.message?.content || '').trim();
        if (reply.startsWith('\`\`\`')) reply = reply.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');

        const questions = JSON.parse(reply);

        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error('No questions extracted or invalid format returned.');
        }

        questions.forEach(q => {
            if (['mcq', 'long', 'code'].includes(q.type)) {
                addQBlock(q.type);
                const blocks = document.querySelectorAll('#q-area .added-q');
                const lastBlock = blocks[blocks.length - 1];

                if (lastBlock) {
                    const txtEl = lastBlock.querySelector('.q-txt');
                    if (txtEl && q.text) txtEl.value = q.text;

                    if (q.type === 'mcq') {
                        const optEl = lastBlock.querySelector('.q-opt');
                        const ansEl = lastBlock.querySelector('.q-ans');
                        if (optEl && q.opts) optEl.value = q.opts;
                        if (ansEl && q.ans) ansEl.value = q.ans;
                    } else if (q.type === 'long') {
                        const kwEl = lastBlock.querySelector('.q-keywords');
                        if (kwEl && q.keywords) kwEl.value = q.keywords;
                    } else if (q.type === 'code') {
                        const langEl = lastBlock.querySelector('.q-lang');
                        const inpEl = lastBlock.querySelector('.q-input-val');
                        const outEl = lastBlock.querySelector('.q-output-val');
                        if (langEl && q.lang) {
                            const l = String(q.lang).toLowerCase();
                            if (['javascript', 'python', 'c', 'c++'].includes(l)) langEl.value = l;
                        }
                        if (inpEl && q.inp) inpEl.value = q.inp;
                        if (outEl && q.out) outEl.value = q.out;
                    }
                }
            }
        });

        toast(`✅ Auto-generated ${questions.length} questions from PDF!`);
    } catch (err) {
        console.error('PDF Parse/AI Extraction Error:', err);
        toast('❌ Failed to extract questions: ' + err.message, true);
    } finally {
        event.target.value = ''; // Reset input to allow re-upload 
    }
}

async function saveExam() {
    const t = document.getElementById('exam-title').value; if (!t) return toast("Title Required", true);
    const qs = [];
    document.querySelectorAll('.added-q').forEach(e => {
        qs.push({ text: e.querySelector('.q-txt').value, type: e.querySelector('.q-type').value, opts: e.querySelector('.q-opt')?.value || '', ans: e.querySelector('.q-ans')?.value || '', keywords: e.querySelector('.q-keywords')?.value || '', lang: e.querySelector('.q-lang')?.value || '', inp: e.querySelector('.q-input-val')?.value || '', out: e.querySelector('.q-output-val')?.value || '' });
    });
    if (qs.length === 0) return toast('Add at least one question', true);
    const eid = 'exam_' + Date.now();
    const startAt = document.getElementById('exam-start-at').value || null;
    const endAt = document.getElementById('exam-end-at').value || null;
    try {
        await dbPutExam(eid, { title: t, duration: document.getElementById('exam-duration').value, severity: document.getElementById('exam-severity').value, questions: qs, startAt, endAt });
        toast("Saved! \u2705"); loadExamList(); document.getElementById('q-area').innerHTML = '';
        document.getElementById('exam-title').value = '';
    } catch (e) { toast('Save failed: ' + e.message, true); }
}

function loadExamList() {
    document.getElementById('exam-list-mini').innerHTML = Object.keys(examDB).map(k => `<div style="padding:10px; border-bottom:1px solid #eee;"><b>${escapeHtml(examDB[k].title)}</b></div>`).join('');
}

// --- ASSIGN (Group-based) ---
function loadAssign() {
    const examList = document.getElementById('assign-exam-list');
    const examKeys = Object.keys(examDB);
    if (examKeys.length === 0) { examList.innerHTML = '<div style="color:#94a3b8; padding:10px;">No exams created yet.</div>'; }
    else { examList.innerHTML = examKeys.map(k => `<div style="padding:8px 0; border-bottom:1px solid #f1f5f9;"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="radio" name="ae" value="${k}" style="width:auto;"><span style="font-weight:500;">${escapeHtml(examDB[k].title)}</span><span style="font-size:11px; color:#94a3b8;">(${examDB[k].questions.length} Q)</span></label></div>`).join(''); }

    const groupList = document.getElementById('assign-group-list');
    const groupKeys = Object.keys(groupDB);
    if (groupKeys.length === 0) { groupList.innerHTML = '<div style="color:#94a3b8; padding:10px;">No groups created yet. Go to <b>Groups</b> tab first.</div>'; }
    else { groupList.innerHTML = groupKeys.map(gid => { const g = groupDB[gid]; const mc = g.students ? g.students.length : 0; return `<div style="padding:8px 0; border-bottom:1px solid #f1f5f9;"><label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" class="ag" value="${gid}" style="width:auto;"><span style="font-weight:500;">${escapeHtml(g.name)}</span><span style="font-size:11px; color:#94a3b8;">(${mc} student${mc !== 1 ? 's' : ''})</span></label></div>`; }).join(''); }
}

async function doAssign() {
    const eid = document.querySelector('input[name="ae"]:checked')?.value;
    if (!eid) return toast("Select an exam first", true);
    const selectedGroups = [...document.querySelectorAll('.ag:checked')].map(c => c.value);
    if (selectedGroups.length === 0) return toast("Select at least one group", true);
    let total = 0, skipped = 0;
    const exam = examDB[eid];
    try {
        for (const gid of selectedGroups) {
            const group = groupDB[gid]; if (!group || !group.students) continue;
            for (const sid of group.students) {
                const current = await dbGetAssignments(sid);
                if (!current.includes(eid)) {
                    await dbSetAssignments(sid, [...current, eid]);
                    total++;
                    // Send invitation email to student
                    const student = studentDB[sid];
                    if (student && student.email) {
                        const windowInfo = (exam.startAt && exam.endAt)
                            ? `Exam Window: ${new Date(exam.startAt).toLocaleString()} â€“ ${new Date(exam.endAt).toLocaleString()}`
                            : 'No specific time window â€” available now.';
                        sendExamInvitationEmail(student, exam, windowInfo).catch(e => console.warn('Invite email failed:', e.message));
                    }
                } else skipped++;
            }
        }
        if (total > 0) toast(`Assigned to ${total} student${total > 1 ? 's' : ''} \u2705 · Invitation emails sent!`);
        if (skipped > 0) toast(`${skipped} already assigned â€” skipped`);
    } catch (e) { toast('Assign failed: ' + e.message, true); }
}

async function sendExamInvitationEmail(student, exam, windowInfo) {
    const https = require('https');
    const postData = JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
            to_name: student.name || 'Student',
            to_email: student.email,
            email: student.email,
            reply_to: student.email,
            otp_code: `You have been assigned a new exam: "${exam.title}"\n${windowInfo}\n\nDuration: ${exam.duration} minutes\nLog in to SecurePro to take the exam.`
        }
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.emailjs.com', path: '/api/v1.0/email/send', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Origin': 'http://localhost' }
        }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { if (res.statusCode === 200) resolve(); else reject(new Error('EmailJS ' + res.statusCode)); }); });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// --- MANAGE GROUPS ---
function loadManageGroups() {
    const checklist = document.getElementById('group-student-checklist');
    const stuKeys = Object.keys(studentDB);
    if (stuKeys.length === 0) { checklist.innerHTML = '<div style="color:#94a3b8; padding:10px;">No students registered yet.</div>'; }
    else { checklist.innerHTML = stuKeys.map(sid => `<div style="padding:6px 0; border-bottom:1px solid #f8fafc;"><label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:14px;"><input type="checkbox" class="gs" value="${sid}" style="width:auto;">${escapeHtml(studentDB[sid].name)} <span style="font-size:11px; color:#94a3b8;">(${sid})</span></label></div>`).join(''); }

    const list = document.getElementById('existing-groups-list');
    const groupKeys = Object.keys(groupDB);
    if (groupKeys.length === 0) { list.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:20px;">No groups created yet.</div>'; return; }
    list.innerHTML = groupKeys.map(gid => {
        const g = groupDB[gid];
        const mn = (g.students || []).map(sid => studentDB[sid] ? studentDB[sid].name : sid);
        return `<div class="result-card" style="cursor:default; flex-direction:column; align-items:stretch;"><div style="display:flex; justify-content:space-between; align-items:center;"><div><div style="font-weight:600;">${escapeHtml(g.name)}</div><div style="font-size:12px; color:#64748b; margin-top:2px;">${mn.length} student${mn.length !== 1 ? 's' : ''}</div></div><div><button onclick="editGroup('${gid}')" class="secondary" style="width:auto; padding:6px 14px; font-size:12px; margin-right:8px;"><i class="fas fa-edit"></i> Edit</button><button onclick="deleteGroup('${gid}')" class="danger" style="width:auto; padding:6px 14px; font-size:12px;"><i class="fas fa-trash"></i> Delete</button></div></div><div style="font-size:12px; color:#64748b; margin-top:8px; padding-top:8px; border-top:1px solid #e5e7eb;">${mn.join(', ') || '<em>No students</em>'}</div></div>`;
    }).join('');
}

window.editingGroupId = null;

function editGroup(gid) {
    const group = groupDB[gid];
    if (!group) return;
    document.getElementById('group-name').value = group.name;
    document.querySelectorAll('.gs').forEach(c => {
        c.checked = (group.students || []).includes(c.value);
    });
    window.editingGroupId = gid;
    const saveBtn = document.querySelector('button[onclick="saveGroup()"]');
    if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Update Group';
}

async function saveGroup() {
    const name = document.getElementById('group-name').value.trim();
    if (!name) return toast('Enter a group name', true);
    const selected = [...document.querySelectorAll('.gs:checked')].map(c => c.value);
    if (selected.length === 0) return toast('Select at least one student', true);
    try {
        const gid = window.editingGroupId || ('group_' + Date.now());
        const isUpdate = !!window.editingGroupId;
        await dbPutGroup(gid, { name, students: selected });
        document.getElementById('group-name').value = '';
        document.querySelectorAll('.gs:checked').forEach(c => c.checked = false);
        window.editingGroupId = null;
        const saveBtn = document.querySelector('button[onclick="saveGroup()"]');
        if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Group';
        toast(`Group "${name}" ${isUpdate ? 'updated' : 'created'} \u2705`); loadManageGroups();
    } catch (e) { toast('Failed: ' + e.message, true); }
}

async function deleteGroup(gid) {
    const group = groupDB[gid];
    if (!group || !confirm(`Delete group "${group.name}"?`)) return;
    try { await dbDeleteGroup(gid); toast('Group deleted'); loadManageGroups(); }
    catch (e) { toast('Failed: ' + e.message, true); }
}

// --- MANAGE EXAMS ---
function loadManageExams() {
    const container = document.getElementById('manage-exam-list');
    const examKeys = Object.keys(examDB);
    if (examKeys.length === 0) { container.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:40px;">No exams created yet.</div>'; return; }
    let html = `<table style="width:100%; border-collapse:collapse;"><thead><tr style="background:#f1f5f9; text-align:left;"><th style="padding:12px;">Title</th><th style="padding:12px;">Questions</th><th style="padding:12px;">Types</th><th style="padding:12px;">Assigned To</th><th style="padding:12px;">Action</th></tr></thead><tbody>`;
    examKeys.forEach(eid => {
        const exam = examDB[eid]; const qc = exam.questions ? exam.questions.length : 0;
        const tc = {}; (exam.questions || []).forEach(q => { tc[q.type] = (tc[q.type] || 0) + 1; });
        const tb = Object.entries(tc).map(([t, c]) => { const co = { mcq: '#dcfce7;color:#166534', long: '#e0e7ff;color:#4338ca', code: '#fef3c7;color:#92400e' }; return `<span style="padding:2px 6px; border-radius:4px; font-size:11px; background:${co[t] || '#e5e7eb;color:#374151'}">${c} ${t}</span>`; }).join(' ');
        let ac = 0; Object.values(assignDB).forEach(list => { if (list.includes(eid)) ac++; });
        html += `<tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:12px; font-weight:600;">${escapeHtml(exam.title)}</td><td style="padding:12px;">${qc}</td><td style="padding:12px;">${tb || 'â€”'}</td><td style="padding:12px;">${ac > 0 ? ac + ' student' + (ac > 1 ? 's' : '') : '<span style="color:#94a3b8;">None</span>'}</td><td style="padding:12px; display:flex; gap:8px;">
            <button onclick="runPlagiarismCheck('${eid}')" class="secondary" style="width:auto; padding:6px 14px; font-size:12px; background:rgba(0,212,255,0.1); color:#00D4FF; border-color:rgba(0,212,255,0.3);"><i class="fas fa-search"></i> Check Plagiarism</button>
            <button onclick="deleteExam('${eid}')" class="danger" style="width:auto; padding:6px 14px; font-size:12px;"><i class="fas fa-trash"></i> Delete</button>
        </td></tr>`;
    });
    html += '</tbody></table>'; container.innerHTML = html;
}

// === PHASE 4: PAIRWISE PLAGIARISM CHECK ===
async function runPlagiarismCheck(eid) {
    toast('Running plagiarism check... This might take a moment.', false);

    // Fetch all results across all students
    let allAttempts = [];
    for (const sid of Object.keys(studentDB)) {
        await dbGetStudentResults(sid);
        const attempts = resultsDB[sid] || [];
        attempts.forEach(a => {
            if (a.examID === eid) allAttempts.push({ studentId: sid, ...a });
        });
    }

    if (allAttempts.length < 2) {
        toast('Need at least 2 attempts to run pairwise check.', true);
        return;
    }

    const exam = examDB[eid];
    const longQuestionIndices = exam.questions.map((q, i) => q.type === 'long' ? i : -1).filter(i => i !== -1);

    if (longQuestionIndices.length === 0) {
        toast('No long-answer questions to compare.', true);
        return;
    }

    let flaggedCount = 0;

    for (let i = 0; i < allAttempts.length; i++) {
        for (let j = i + 1; j < allAttempts.length; j++) {
            const a1 = allAttempts[i];
            const a2 = allAttempts[j];

            for (const qIdx of longQuestionIndices) {
                const ans1 = a1.answers[qIdx]?.answer || '';
                const ans2 = a2.answers[qIdx]?.answer || '';
                if (ans1.length < 50 || ans2.length < 50) continue;

                const score = cosineSimilarity(ans1, ans2);
                if (score > 70) {
                    flaggedCount++;
                    const warning = `SIMILARITY WARNING: ${score}% match on Q${qIdx + 1} with student ${a2.studentId}`;
                    const warning2 = `SIMILARITY WARNING: ${score}% match on Q${qIdx + 1} with student ${a1.studentId}`;

                    if (!a1.feedback[qIdx].includes('SIMILARITY')) a1.feedback[qIdx] += `<br><span style="color:#ef4444; font-weight:bold;">ðŸš¨ ${warning}</span>`;
                    if (!a2.feedback[qIdx].includes('SIMILARITY')) a2.feedback[qIdx] += `<br><span style="color:#ef4444; font-weight:bold;">ðŸš¨ ${warning2}</span>`;
                }
            }
        }
    }

    if (flaggedCount > 0) {
        // Save updated attempts back to DB
        const savePromises = allAttempts.map(a => dbPutResult(a.studentId, {
            attemptId: a.attemptId,
            examID: a.examID,
            examTitle: a.examTitle,
            answers: a.answers,
            violations: a.violations,
            cheatingScore: a.cheatingScore,
            submittedAt: a.submittedAt,
            grades: a.grades,
            feedback: a.feedback
        }));
        await Promise.all(savePromises);
        toast(`Done! Flagged ${flaggedCount} highly similar answers. Check Results page.`, true);
    } else {
        toast('Done! No significant similarity found. âœ…');
    }
}

async function deleteExam(eid) {
    const exam = examDB[eid];
    if (!exam) return toast('Exam not found', true);
    if (!confirm(`Delete "${exam.title}"?\n\nThis will un-assign it from all students. Cannot be undone.`)) return;
    try {
        await dbDeleteExam(eid);
        await dbGetAllAssignments();
        for (const sid of Object.keys(assignDB)) {
            const updated = assignDB[sid].filter(id => id !== eid);
            if (updated.length !== assignDB[sid].length) await dbSetAssignments(sid, updated);
        }
        toast(`"${exam.title}" deleted`); loadManageExams(); loadExamList();
    } catch (e) { toast('Delete failed: ' + e.message, true); }
}

// --- RESULTS & AI GRADING ---

// Layer 1: Show all students who have results
async function loadResults() {
    document.getElementById('results-student-list').classList.remove('hidden');
    document.getElementById('results-history-view').classList.add('hidden');
    document.getElementById('results-detail-view').classList.add('hidden');
    const list = document.getElementById('results-student-list');
    list.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">Loading...</div>';
    try {
        const ids = await dbGetAllResultStudentIds();
        await dbGetAllStudents();
        list.innerHTML = '';
        for (const sid of ids.filter(id => studentDB[id])) {
            const attempts = await dbGetStudentResults(sid);
            if (attempts.length > 0) {
                list.innerHTML += `<div class="result-card" onclick="showStudentResults('${sid}')"><div><b>${escapeHtml(studentDB[sid].name)}</b><div style="font-size:12px;color:#64748b;">ID: ${sid}</div></div><div class="badge pass">${attempts.length} Attempt${attempts.length > 1 ? 's' : ''}</div></div>`;
            }
        }
        if (list.innerHTML === '') list.innerHTML = '<div style="color:#94a3b8; text-align:center; padding:40px;">No exam results yet.</div>';
    } catch (e) { list.innerHTML = `<div style="color:#ef4444; padding:20px;">Error: ${e.message}</div>`; }
}

// Layer 2: Show all exam attempts for a student
async function showStudentResults(sid) {
    currentResultViewID = sid;
    document.getElementById('results-student-list').classList.add('hidden');
    document.getElementById('results-history-view').classList.remove('hidden');
    document.getElementById('results-detail-view').classList.add('hidden');
    document.getElementById('history-student-name').innerText = (studentDB[sid]?.name || sid) + ' â€” Exam History';
    const historyList = document.getElementById('exam-history-list');
    historyList.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">Loading...</div>';

    const attempts = await dbGetStudentResults(sid);
    if (attempts.length === 0) { historyList.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">No exam attempts found.</div>'; return; }

    historyList.innerHTML = '';
    attempts.forEach((attempt) => {
        const examTitle = attempt.examTitle || (examDB[attempt.examID] ? examDB[attempt.examID].title : 'Unknown Exam');
        const qc = attempt.answers ? attempt.answers.length : 0;
        const hasGrades = attempt.grades && attempt.grades.length > 0;
        const totalScore = hasGrades ? attempt.grades.reduce((s, g) => s + (g || 0), 0) : null;
        const maxScore = qc * 10;
        const scoreBadge = hasGrades ? `<span class="badge ${totalScore > maxScore / 2 ? 'pass' : 'fail'}">${totalScore}/${maxScore}</span>` : '<span class="badge" style="background:#e5e7eb; color:#6b7280;">Not Graded</span>';
        const score = attempt.cheatingScore || 0;
        const scoreColor = score <= 20 ? '#10b981' : score <= 50 ? '#f59e0b' : '#ef4444';
        const scoreLabel = score <= 20 ? 'Low Risk' : score <= 50 ? 'Medium Risk' : 'HIGH RISK \u26a0';
        const riskBadge = `<span style="padding:4px 10px; border-radius:20px; font-size:11px; font-weight:700; background:${score <= 20 ? '#dcfce7' : score <= 50 ? '#fef9c3' : '#fee2e2'}; color:${scoreColor};">${score}/100 · ${scoreLabel}</span>`;
        const vioCount = (attempt.violations || []).length;
        const vioLine = vioCount > 0 ? `<div style="font-size:11px; color:#ef4444; margin-top:3px;">\u26a0 ${vioCount} violation${vioCount > 1 ? 's' : ''} recorded</div>` : `<div style="font-size:11px; color:#10b981; margin-top:3px;">\u2705 No violations</div>`;

        historyList.innerHTML += `<div class="result-card" style="cursor:default;"><div style="flex:1;"><div style="font-weight:600; margin-bottom:4px;">${examTitle}</div><div style="font-size:12px; color:#64748b;">${qc} questions</div>${vioLine}</div><div style="display:flex; align-items:center; gap:10px;">${riskBadge} ${scoreBadge}<button onclick="viewAttemptDetails('${sid}', '${attempt.attemptId}')" style="width:auto; padding:8px 16px; font-size:12px;"><i class="fas fa-eye"></i> View</button><button onclick="deleteAttempt('${sid}', '${attempt.attemptId}')" class="danger" style="width:auto; padding:8px 16px; font-size:12px;"><i class="fas fa-trash"></i> Delete</button></div></div>`;
    });
}

// Delete a specific exam attempt
async function deleteAttempt(sid, attemptId) {
    const attempt = (resultsDB[sid] || []).find(a => a.attemptId === attemptId);
    if (!attempt || !confirm('Delete this attempt? Cannot be undone.')) return;
    try {
        for (const v of (attempt.violations || [])) { if (v.screenshotKey) await s3DeleteObject(v.screenshotKey).catch(() => { }); }
        await dbDeleteResult(sid, attemptId);
        toast('Attempt deleted');
        if (!resultsDB[sid] || resultsDB[sid].length === 0) loadResults();
        else showStudentResults(sid);
    } catch (e) { toast('Delete failed: ' + e.message, true); }
}

// Layer 3: View detailed answers for a specific attempt
function viewAttemptDetails(sid, attemptId) {
    currentResultViewID = sid;
    currentResultAttemptIdx = attemptId;
    document.getElementById('results-student-list').classList.add('hidden');
    document.getElementById('results-history-view').classList.add('hidden');
    document.getElementById('results-detail-view').classList.remove('hidden');
    document.getElementById('res-student-name').innerText = studentDB[sid]?.name || sid;
    const attempt = (resultsDB[sid] || []).find(a => a.attemptId === attemptId);
    if (!attempt) { toast('Attempt not found', true); return; }
    const examTitle = attempt.examTitle || (examDB[attempt.examID] ? examDB[attempt.examID].title : 'Unknown Exam');
    document.getElementById('res-exam-title').innerText = examTitle;

    const hasGrades = attempt.grades && attempt.grades.length > 0;
    const maxScore = attempt.answers.length * 10;
    if (hasGrades) { const ts = attempt.grades.reduce((s, g) => s + (g || 0), 0); document.getElementById('res-score-badge').innerText = `Score: ${ts}/${maxScore}`; document.getElementById('res-score-badge').className = ts > maxScore / 2 ? 'badge pass' : 'badge fail'; }
    else { document.getElementById('res-score-badge').innerText = 'Not Graded'; document.getElementById('res-score-badge').className = 'badge'; document.getElementById('res-score-badge').style.background = '#e5e7eb'; }

    const aiBtn = document.querySelector('.ai-btn');
    if (aiBtn) aiBtn.innerHTML = '<i class="fas fa-magic"></i> &nbsp; Run AI Auto-Correction';

    renderProctorReport(attempt);

    const content = document.getElementById('results-content'); content.innerHTML = '';
    attempt.answers.forEach((ans, i) => {
        const eg = (attempt.grades && attempt.grades[i] !== undefined) ? attempt.grades[i] : '';
        const ef = (attempt.feedback && attempt.feedback[i]) ? attempt.feedback[i] : '';
        const ad = ans.isCode ? `<pre style="background:#0A0F1A; color:#CDD6F4; padding:12px; border-radius:8px; overflow-x:auto; font-size:13px; margin:0; border:1px solid rgba(255,255,255,0.06);">${escapeHtml(ans.answer)}</pre>` : `<div style="background:rgba(255,255,255,0.03); padding:12px; border:1px solid rgba(255,255,255,0.07); border-radius:6px; font-size:14px; line-height:1.6; color:var(--text-secondary);">${escapeHtml(ans.answer) || '<em style="color:var(--text-muted);">No answer provided</em>'}</div>`;
        const timeStr = ans.timeSpentSeconds != null ? (ans.timeSpentSeconds < 60 ? `${ans.timeSpentSeconds}s` : `${Math.floor(ans.timeSpentSeconds / 60)}m ${ans.timeSpentSeconds % 60}s`) : 'N/A';
        const isFast = attempt.fastAnswerFlags && attempt.fastAnswerFlags.some(q => ans.question.startsWith(q.substring(0, 30)));
        const timeBadge = `<span style="font-size:11px; padding:2px 8px; border-radius:4px; margin-left:8px; background:${isFast ? 'rgba(255,45,85,0.1)' : 'rgba(0,212,255,0.08)'}; color:${isFast ? '#FF2D55' : '#94A3B8'}; border:1px solid ${isFast ? 'rgba(255,45,85,0.3)' : 'rgba(0,212,255,0.15)'};">â± ${timeStr}${isFast ? ' âš¡ FAST' : ''}</span>`;
        content.innerHTML += `<div class="answer-block" id="ans-block-${i}"><div style="font-weight:600; margin-bottom:8px; color:var(--text-primary); display:flex; align-items:center;"><span class="q-number-chip">${i + 1}</span>${escapeHtml(ans.question)}${timeBadge}</div>${ad}<div class="ai-feedback-box" id="ai-feed-${i}" style="${ef ? 'display:block;' : ''}">${ef ? `<b>Score: ${eg}/10</b><br>${ef}` : ''}</div><div style="display:flex; align-items:center; gap:10px; margin-top:12px; padding:10px; background:rgba(0,212,255,0.04); border-radius:8px; border:1px solid var(--border-accent);"><label style="font-size:13px; font-weight:600; color:var(--accent); white-space:nowrap; font-family:var(--font-mono);">SCORE:</label><input type="number" id="manual-score-${i}" min="0" max="10" step="0.5" value="${eg}" placeholder="0â€“10" style="width:80px; margin-bottom:0; text-align:center; font-weight:600;"><span style="font-size:13px; color:var(--text-muted);">/ 10</span></div></div>`;
    });
}

// Proctoring report helpers
function renderScoreCircle(score) {
    const color = score <= 20 ? '#00FF9D' : score <= 50 ? '#FFB800' : '#FF2D55';
    const label = score <= 20 ? 'Low Risk' : score <= 50 ? 'Medium Risk' : 'HIGH RISK';
    const r = 28, circ = 2 * Math.PI * r, dash = (score / 100) * circ;
    return `<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="${r}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="7"/><circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-dasharray="${dash} ${circ}" stroke-linecap="round" transform="rotate(-90 40 40)"/><text x="40" y="37" text-anchor="middle" font-size="14" font-weight="bold" fill="${color}">${score}</text><text x="40" y="51" text-anchor="middle" font-size="8" fill="#94a3b8">/100</text></svg><div style="font-size:10px; font-weight:700; color:${color}; text-align:center;">${label}</div>`;
}

function renderProctorReport(attempt) {
    const violations = attempt.violations || [];
    const score = attempt.cheatingScore || 0;
    const section = document.getElementById('proctor-report-section');
    if (!section) return;
    document.getElementById('cheating-score-display').innerHTML = renderScoreCircle(score);
    const color = score <= 20 ? '#10b981' : score <= 50 ? '#f59e0b' : '#ef4444';
    document.getElementById('proctor-summary-line').innerHTML = `<span style="color:${color}; font-weight:600;">${violations.length} violations Â· Score: ${score}/100</span>`;
    const weights = {
        NO_FACE: { pts: 8, max: 40 }, MULTIPLE_FACES: { pts: 15, max: 30 },
        PHONE_DETECTED: { pts: 20, max: 40 }, TAB_SWITCH: { pts: 12, max: 36 },
        LOOKING_AWAY: { pts: 4, max: 20 }, NOISE_DETECTED: { pts: 2, max: 10 },
        COPY_PASTE_ATTEMPT: { pts: 10, max: 30 }, AI_PASTE_DETECTED: { pts: 15, max: 45 },
        LIP_MOVEMENT: { pts: 6, max: 18 },
        BANNED_PROCESS_RUNNING: { pts: 25, max: 50 },
        MULTIPLE_DISPLAYS: { pts: 20, max: 40 },
        NETWORK_ANOMALY: { pts: 18, max: 36 },
        IDENTITY_MISMATCH: { pts: 30, max: 60 },
        OBJECT_DETECTED: { pts: 12, max: 36 },
        UNNATURAL_TYPING: { pts: 15, max: 30 },
        CURSOR_OUT_OF_BOUNDS: { pts: 5, max: 15 },
        INACTIVITY_DETECTED: { pts: 4, max: 12 }
    };
    const typeLabels = { NO_FACE: 'No Face Detected', MULTIPLE_FACES: 'Multiple Faces', PHONE_DETECTED: 'Phone Recognition', TAB_SWITCH: 'Tab Switch', LOOKING_AWAY: 'Looking Away', NOISE_DETECTED: 'Voice Detected', COPY_PASTE_ATTEMPT: 'Copy/Paste', AI_PASTE_DETECTED: 'AI Paste', LIP_MOVEMENT: 'Lip Movement', BANNED_PROCESS_RUNNING: 'Banned App Running', MULTIPLE_DISPLAYS: 'Multiple Displays', NETWORK_ANOMALY: 'Network Anomaly', IDENTITY_MISMATCH: 'Identity Mismatch', OBJECT_DETECTED: 'Object Detected', UNNATURAL_TYPING: 'Unnatural Typing', CURSOR_OUT_OF_BOUNDS: 'Cursor Out of Bounds', INACTIVITY_DETECTED: 'Inactivity Detected' };
    const counts = {}; violations.forEach(v => counts[v.type] = (counts[v.type] || 0) + 1);
    let rows = '';
    for (const [type, count] of Object.entries(counts)) { const w = weights[type]; const pts = w ? Math.min(count * w.pts, w.max) : 0; rows += `<tr><td style="padding:8px;">${typeLabels[type] || type}</td><td style="padding:8px; font-weight:600;">${count}</td><td style="padding:8px; color:var(--danger);">+${pts}</td></tr>`; }
    document.getElementById('vio-summary-body').innerHTML = rows || '<tr><td colspan="3" style="padding:8px; color:var(--text-muted);">No violations recorded</td></tr>';
    const grid = document.getElementById('vio-photo-grid');
    const typeColors = { NO_FACE: '#ef4444', MULTIPLE_FACES: '#ef4444', PHONE_DETECTED: '#dc2626', TAB_SWITCH: '#f59e0b', LOOKING_AWAY: '#f97316', NOISE_DETECTED: '#6366f1', COPY_PASTE_ATTEMPT: '#f59e0b', AI_PASTE_DETECTED: '#7C3AED', LIP_MOVEMENT: '#EC4899', BANNED_PROCESS_RUNNING: '#dc2626', MULTIPLE_DISPLAYS: '#f97316', NETWORK_ANOMALY: '#f59e0b', IDENTITY_MISMATCH: '#ef4444', OBJECT_DETECTED: '#f97316', UNNATURAL_TYPING: '#7C3AED', CURSOR_OUT_OF_BOUNDS: '#94a3b8', INACTIVITY_DETECTED: '#64748b' };
    const proofBadge = { screen: 'ðŸ–¥ï¸ Screen', camera: 'ðŸ“· Webcam', audio: 'ðŸŽ¤ Audio', none: 'â€”' };
    if (violations.length === 0) { grid.innerHTML = '<p style="color:#94a3b8; font-size:13px;">No proof captured.</p>'; }
    else {
        grid.innerHTML = violations.map(v => {
            const d = new Date(v.timestamp);
            const ts = d.toTimeString().split(' ')[0];
            const mins = Math.floor((v.timeIntoExam || 0) / 60);
            const secs = (v.timeIntoExam || 0) % 60;
            const c = typeColors[v.type] || '#6366f1';
            const pType = v.proofType || 'camera';
            let proofHtml;
            if (v.audioKey) {
                const audioUrl = s3GetSignedUrl(v.audioKey);
                proofHtml = `<div style="width:100%;background:#0f172a;border-radius:6px 6px 0 0;padding:12px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:6px;">
                    <i class="fas fa-volume-up" style="color:#6366f1;font-size:24px;"></i>
                    <span style="color:#6366f1;font-size:10px;font-weight:700;">VOICE RECORDING</span>
                    <audio controls src="${audioUrl}" style="width:100%;height:28px;"></audio>
                </div>`;
            } else if (v.screenshotKey) {
                const lbl = pType === 'screen' ? 'ðŸ–¥ï¸ Screen Capture' : 'ðŸ“· Webcam Photo';
                proofHtml = `<div style="position:relative;">
                    <img src="${s3GetSignedUrl(v.screenshotKey)}" style="width:100%;height:110px;object-fit:cover;border-radius:6px 6px 0 0;display:block;">
                    <span style="position:absolute;bottom:4px;left:4px;font-size:9px;background:rgba(0,0,0,0.75);color:#fff;padding:2px 5px;border-radius:3px;">${lbl}</span>
                </div>`;
            } else {
                proofHtml = `<div style="width:100%;height:70px;background:#1e293b;border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:center;color:#475569;font-size:11px;">No proof captured</div>`;
            }
            return `<div style="border:1px solid rgba(255,255,255,0.08);background:var(--bg-card);border-radius:8px;overflow:hidden;font-size:12px;">
                ${proofHtml}
                <div style="padding:8px;">
                    <div style="font-weight:700;color:${c};margin-bottom:3px;">${typeLabels[v.type] || v.type}</div>
                    <div style="color:#64748b;">ðŸ• ${ts}</div>
                    <div style="color:#64748b;">â± ${mins}m ${secs}s into exam</div>
                    <div style="color:#475569;font-size:10px;margin-top:2px;">${proofBadge[pType] || pType}</div>
                </div>
            </div>`;
        }).join('');
    }
    section.style.display = 'block';
}

function toggleProctorReport() {
    const body = document.getElementById('proctor-report-body');
    const chevron = document.getElementById('proctor-chevron');
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
}

// Save manually entered grades
async function saveManualGrades() {
    const sid = currentResultViewID;
    const attemptId = currentResultAttemptIdx;
    const attempt = (resultsDB[sid] || []).find(a => a.attemptId === attemptId);
    if (!sid || !attemptId || !attempt) { toast('No attempt selected', true); return; }
    if (!attempt.grades) attempt.grades = [];
    if (!attempt.feedback) attempt.feedback = [];
    let totalScore = 0;
    const maxScore = attempt.answers.length * 10;
    attempt.answers.forEach((ans, i) => {
        const input = document.getElementById(`manual-score-${i}`);
        let score = parseFloat(input.value); if (isNaN(score)) score = 0;
        score = Math.max(0, Math.min(10, score)); input.value = score;
        attempt.grades[i] = score;
        if (!attempt.feedback[i]) attempt.feedback[i] = 'Manually graded by admin';
        totalScore += score;
    });
    try {
        await dbPutResult(sid, attempt);
        document.getElementById('res-score-badge').innerText = `Score: ${totalScore}/${maxScore}`;
        document.getElementById('res-score-badge').className = totalScore > maxScore / 2 ? 'badge pass' : 'badge fail';
        toast('Grades saved \u2705');
    } catch (e) { toast('Save failed: ' + e.message, true); }
}

// Navigation helpers
function backToStudentList() { loadResults(); }
function backToHistory() { showStudentResults(currentResultViewID); }
function backToResults() { loadResults(); }

// HTML escaping utility
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// â”€â”€ AI AUTO-CORRECTION (Groq) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Fallback local grading (used when API key is not set or API fails)
function localGrade(ans, q) {
    let score = 0, feedback = '';
    if (q.type === 'mcq') {
        if (ans.answer.trim().toLowerCase() === q.ans.trim().toLowerCase()) {
            score = 10; feedback = 'Correct Answer âœ…';
        } else {
            score = 0; feedback = `Incorrect. Correct was: ${q.ans}`;
        }
    } else if (q.type === 'code') {
        if (ans.passed) { score = 10; feedback = 'Code compiled and passed test cases âœ…'; }
        else { score = 2; feedback = 'Code failed test cases or compilation error.'; }
    } else if (q.type === 'long') {
        const keywords = q.keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
        let matches = 0;
        const studentText = ans.answer.toLowerCase();
        keywords.forEach(k => { if (studentText.includes(k)) matches++; });
        if (keywords.length > 0) {
            let percent = matches / keywords.length;
            score = Math.round(percent * 10);
            feedback = `Local Analysis: Found ${matches}/${keywords.length} key concepts.`;
        } else { score = 5; feedback = 'Could not verify (no keywords provided).'; }
    }
    return { score, feedback };
}

// â”€â”€ Groq API caller (Fallback AI provider) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function callGroqAPI(question, expectedAnswer, studentAnswer, questionType) {
    const prompt = `You are an exam grader evaluating a coding question.
Question: ${question}
Expected Output: ${expectedAnswer}
Student's Code: ${studentAnswer}

Evaluate the code for correctness, logic, and whether it would produce the expected output.
Score 10/10 for fully correct code, partial credit for partially correct approaches.
Respond ONLY in this exact JSON format (no markdown, no code blocks):
{"score": <number 0-10>, "feedback": "<brief explanation of code quality and correctness>"}`;

    const https = require('https');
    const postData = JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Groq API error ${res.statusCode}: ${body.substring(0, 300)}`));
                    return;
                }
                try {
                    const data = JSON.parse(body);
                    const textReply = data.choices?.[0]?.message?.content || '';
                    let cleaned = textReply.trim();
                    if (cleaned.startsWith('```')) {
                        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
                    }
                    try {
                        const result = JSON.parse(cleaned);
                        resolve({
                            score: Math.max(0, Math.min(10, Math.round(result.score))),
                            feedback: result.feedback || 'AI evaluated.'
                        });
                    } catch (parseErr) {
                        const scoreMatch = cleaned.match(/(\d+)\s*\/\s*10/);
                        resolve({
                            score: scoreMatch ? Math.min(10, parseInt(scoreMatch[1])) : 5,
                            feedback: cleaned.substring(0, 200) || 'AI evaluation completed.'
                        });
                    }
                } catch (jsonErr) {
                    reject(new Error('Failed to parse Groq response: ' + jsonErr.message));
                }
            });
        });
        req.on('error', (err) => reject(new Error('Groq network error: ' + err.message)));
        req.write(postData);
        req.end();
    });
}

async function runAutoCorrect() {
    const btn = document.querySelector('.ai-btn');
    const sid = currentResultViewID;
    const attemptId = currentResultAttemptIdx;
    const attempt = (resultsDB[sid] || []).find(a => a.attemptId === attemptId);

    if (!sid || !attemptId || !attempt) {
        toast('No attempt selected', true);
        return;
    }

    const exam = examDB[attempt.examID];

    if (!exam) {
        toast('Exam data not found â€” cannot grade', true);
        return;
    }

    const hasAI = GROQ_API_KEY && GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE';
    const codeQuestionCount = exam.questions.filter(q => q.type === 'code').length;

    btn.innerHTML = hasAI && codeQuestionCount > 0
        ? `<i class="fas fa-spinner fa-spin"></i> Grading (${codeQuestionCount} code Q via Groq AI)...`
        : '<i class="fas fa-spinner fa-spin"></i> Grading locally...';
    btn.disabled = true;

    if (!attempt.grades) attempt.grades = [];
    if (!attempt.feedback) attempt.feedback = [];

    let totalScore = 0;
    const maxScore = attempt.answers.length * 10;
    let apiCallsMade = 0;

    // Sequential for loop â€” await actually pauses here (unlike forEach)
    for (let i = 0; i < attempt.answers.length; i++) {
        const ans = attempt.answers[i];
        const q = exam.questions[i];
        const box = document.getElementById(`ai-feed-${i}`);
        const manualInput = document.getElementById(`manual-score-${i}`);
        let result;

        if (q.type === 'mcq') {
            // â”€â”€ LOCAL: Exact match â”€â”€
            if (ans.answer.trim().toLowerCase() === q.ans.trim().toLowerCase()) {
                result = { score: 10, feedback: 'ðŸ“‹ âœ… Correct answer.' };
            } else {
                result = { score: 0, feedback: `ðŸ“‹ âŒ Incorrect. Correct answer: ${q.ans}` };
            }

        } else if (q.type === 'long') {
            // â”€â”€ LOCAL: Keyword check â”€â”€
            const keywords = q.keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
            let localFeedback = '';
            let localScore = 5;
            if (keywords.length > 0) {
                const studentText = (ans.answer || '').toLowerCase();
                let matches = 0;
                const matched = [], missed = [];
                keywords.forEach(k => {
                    if (studentText.includes(k)) { matches++; matched.push(k); }
                    else missed.push(k);
                });
                localScore = Math.max(3, Math.round((matches / keywords.length) * 10));
                localFeedback = `ðŸ“‹ Found ${matches}/${keywords.length} key concepts. Matched: [${matched.join(', ')}]${missed.length ? '. Missing: [' + missed.join(', ') + ']' : ''}`;
            } else {
                localFeedback = 'ðŸ“‹ No keywords provided by admin â€” default score.';
            }

            // === PHASE 4: AI GENERATION CHECK ===
            let aiWarning = '';
            if (hasAI && (ans.answer || '').trim().length > 50) {
                box.style.display = 'block';
                box.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#ec4899;"></i> <span style="color:#ec4899;">Checking for AI generation...</span>`;
                apiCallsMade++;
                const aiCheck = await detectAIGenerated(ans.answer);
                if (aiCheck.isAI && aiCheck.confidence > 75) {
                    aiWarning = `<br><span style="padding:3px 6px; border-radius:4px; font-size:11px; background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid #ef4444; font-weight:700;"><i class="fas fa-robot"></i> AI-GENERATED (Confidence: ${aiCheck.confidence}%)</span>`;
                } else if (aiCheck.confidence > 0) {
                    aiWarning = `<br><span style="padding:3px 6px; border-radius:4px; font-size:11px; background:rgba(16,185,129,0.15); color:#10b981; border:1px solid #10b981; font-weight:700;">Human written (AI Confidence: ${aiCheck.confidence}%)</span>`;
                }
            }

            result = {
                score: localScore,
                feedback: localFeedback + aiWarning
            };

        } else if (q.type === 'code') {
            // â”€â”€ GROQ AI for code questions â”€â”€
            const expectedOutput = q.out || 'No expected output';

            if (hasAI) {
                // Rate limit delay between API calls
                if (apiCallsMade > 0) {
                    box.style.display = 'block';
                    box.innerHTML = `<i class="fas fa-clock" style="color:#f59e0b;"></i> <span style="color:#f59e0b;">Rate limit cooldown...</span>`;
                    await new Promise(r => setTimeout(r, 1500));
                }

                box.style.display = 'block';
                box.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#6366f1;"></i> <span style="color:#6366f1;">Groq AI analyzing Q${i + 1} code...</span>`;

                try {
                    result = await callGroqAPI(q.text, expectedOutput, ans.answer, 'code');
                    result.feedback = 'ðŸ¤– Groq: ' + result.feedback;
                    apiCallsMade++;
                } catch (err) {
                    console.warn(`Groq AI failed for Q${i + 1}, using local fallback.`, err.message);
                    if (ans.passed) {
                        result = { score: 10, feedback: `<span style="color:#f59e0b;">âš ï¸ AI unavailable. Local Fallback: Test cases passed. âœ…</span>` };
                    } else {
                        result = { score: 2, feedback: `<span style="color:#ef4444;">âš ï¸ AI unavailable. Local Fallback: Test cases failed. Manual review recommended.</span>` };
                    }
                }
            } else {
                if (ans.passed) {
                    result = { score: 10, feedback: 'ðŸ“‹ Code passed local test cases âœ…' };
                } else {
                    result = { score: 2, feedback: 'ðŸ“‹ Code failed local tests. Use manual score to override.' };
                }
            }

        } else {
            result = { score: 0, feedback: 'Unknown question type.' };
        }

        attempt.grades[i] = result.score;
        attempt.feedback[i] = result.feedback;
        totalScore += result.score;

        box.style.display = 'block';
        box.innerHTML = `<b>Score: ${result.score}/10</b><br>${result.feedback}`;
        if (manualInput) manualInput.value = result.score;
    }

    try { await dbPutResult(sid, attempt); } catch (e) { console.warn('Save failed:', e.message); }

    document.getElementById('res-score-badge').innerText = `Score: ${totalScore}/${maxScore}`;
    document.getElementById('res-score-badge').className = totalScore > (maxScore / 2) ? 'badge pass' : 'badge fail';

    btn.innerHTML = '<i class="fas fa-check"></i> Grading Complete';
    btn.disabled = false;
    toast(apiCallsMade > 0 ? `Grading done â€” ${apiCallsMade} code Q graded by Groq AI âœ…` : 'Grading complete âœ…');
}

// --- STUDENT EXAM ---
async function loadMyExams() {
    const list = document.getElementById('my-exam-list');
    list.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">Loading your exams...</div>';
    try {
        const examIds = await dbGetAssignments(currentStudent);
        await dbGetAllExams();
        await dbGetStudentResults(currentStudent);
        list.innerHTML = '';
        const available = examIds.filter(eid => examDB[eid]);
        if (available.length === 0) { list.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">No exams assigned yet.</div>'; return; }

        const completedExamIds = new Set((resultsDB[currentStudent] || []).map(a => a.examID));
        const now = Date.now();

        available.forEach(eid => {
            const e = examDB[eid];
            const isCompleted = completedExamIds.has(eid);

            // Scheduled window check
            const hasWindow = e.startAt && e.endAt;
            const windowStart = hasWindow ? new Date(e.startAt).getTime() : null;
            const windowEnd = hasWindow ? new Date(e.endAt).getTime() : null;
            const beforeWindow = hasWindow && now < windowStart;
            const afterWindow = hasWindow && now > windowEnd;
            const windowLocked = beforeWindow || afterWindow;

            let windowBadge = '';
            let windowNote = '';
            if (hasWindow) {
                const startStr = new Date(e.startAt).toLocaleString();
                const endStr = new Date(e.endAt).toLocaleString();
                if (beforeWindow) {
                    windowBadge = `<span style="font-size:11px; background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.3); padding:3px 8px; border-radius:20px;">â° Opens ${startStr}</span>`;
                } else if (afterWindow) {
                    windowBadge = `<span style="font-size:11px; background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.3); padding:3px 8px; border-radius:20px;">â›” Closed ${endStr}</span>`;
                } else {
                    windowBadge = `<span style="font-size:11px; background:rgba(0,255,157,0.1); color:#00FF9D; border:1px solid rgba(0,255,157,0.25); padding:3px 8px; border-radius:20px;">ðŸŸ¢ Open until ${endStr}</span>`;
                }
                windowNote = `<div style="font-size:11px; color:#64748b; margin-top:3px;">${startStr} â†’ ${endStr}</div>`;
            }

            if (isCompleted) {
                list.innerHTML += `<div class="result-card" style="cursor:default; opacity:0.7;"><div><b>${escapeHtml(e.title)}</b><div style="font-size:12px;color:#64748b;">${e.questions.length} Questions â€¢ ${e.duration} mins</div></div><span class="badge" style="background:rgba(0,255,157,0.1); color:#00FF9D; border:1px solid rgba(0,255,157,0.25); font-size:12px;">âœ“ COMPLETED</span></div>`;
            } else if (windowLocked) {
                list.innerHTML += `<div class="result-card" style="cursor:default; opacity:0.75;"><div style="flex:1;"><b>${escapeHtml(e.title)}</b><div style="font-size:12px;color:#64748b;">${e.questions.length} Questions â€¢ ${e.duration} mins</div>${windowNote}</div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">${windowBadge}</div></div>`;
            } else {
                const windowInfo = hasWindow ? `<div style="font-size:11px; color:#64748b; margin-top:3px;">ðŸ“… ${new Date(e.startAt).toLocaleString()} â†’ ${new Date(e.endAt).toLocaleString()}</div>` : '';
                list.innerHTML += `<div class="result-card" onclick="startExam('${eid}')"><div style="flex:1;"><b>${escapeHtml(e.title)}</b><div style="font-size:12px;color:#64748b;">${e.questions.length} Questions â€¢ ${e.duration} mins</div>${windowInfo}${windowBadge ? '<div style="margin-top:4px;">' + windowBadge + '</div>' : ''}</div><button style="width:auto; padding:8px 20px;">Start Exam</button></div>`;
            }
        });
    } catch (e) { list.innerHTML = `<div style="color:#ef4444; padding:20px;">Error: ${e.message}</div>`; }
}

function switchStudentTab(tab) {
    document.getElementById('tab-stu-exams').classList.remove('active');
    document.getElementById('tab-stu-results').classList.remove('active');
    document.getElementById('tab-stu-' + tab).classList.add('active');

    if (tab === 'exams') {
        document.getElementById('my-exam-list').classList.remove('hidden');
        document.getElementById('my-results-list').classList.add('hidden');
        loadMyExams();
    } else {
        document.getElementById('my-exam-list').classList.add('hidden');
        document.getElementById('my-results-list').classList.remove('hidden');
        loadMyResults();
    }
}

async function loadMyResults() {
    const list = document.getElementById('my-results-list');
    list.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">Loading your results...</div>';
    try {
        await dbGetAllExams();
        const results = await dbGetStudentResults(currentStudent);
        list.innerHTML = '';
        if (results.length === 0) { list.innerHTML = '<div style="color:#94a3b8; padding:20px; text-align:center;">No results available yet.</div>'; return; }

        // Sort by timestamp descending
        results.sort((a, b) => b.timestamp - a.timestamp);

        results.forEach(res => {
            const e = examDB[res.examID];
            const examTitle = e ? e.title : res.examID;

            // Calculate total marks possible (matches admin panel logic)
            const questionCount = res.answers ? res.answers.length : 0;
            const maxScore = questionCount * 10;

            // Check if attempt has been graded by admin
            const isGraded = res.grades && res.grades.length > 0;
            let totalAchieved = 0;
            if (isGraded) {
                res.grades.forEach(g => { if (typeof g === 'number') totalAchieved += g; });
            }

            const dateStr = new Date(res.timestamp).toLocaleString();

            let statusBadge = '';
            if (isGraded) {
                const passClass = totalAchieved > maxScore / 2 ? 'color:var(--success); background:rgba(0,255,157,0.1); border:1px solid rgba(0,255,157,0.2);' : 'color:var(--danger); background:rgba(255,45,85,0.1); border:1px solid rgba(255,45,85,0.2);';
                statusBadge = `<div class="badge" style="${passClass} font-size:14px; padding:6px 12px;"> Score: ${totalAchieved} / ${maxScore} </div>`;
            } else {
                statusBadge = `<div class="badge" style="background:#1e293b; color:#94a3b8; font-size:12px; padding:6px 12px; border:1px solid #334155;"> Not Graded Yet </div>`;
            }

            list.innerHTML += `<div class="result-card" style="cursor:default; align-items:center;">
                <div>
                    <b>${escapeHtml(examTitle)}</b>
                    <div style="font-size:12px;color:#64748b;">Submitted: ${dateStr}</div>
                </div>
                ${statusBadge}
            </div>`;
        });
    } catch (e) { list.innerHTML = `<div style="color:#ef4444; padding:20px;">Error: ${e.message}</div>`; }
}

async function startExam(eid) {
    // Phase 1: Block if multiple displays detected
    if (multiDisplayBlocked) {
        toast('\ud83d\udda5\ufe0f Cannot start exam! Disconnect external monitors first.', true);
        return;
    }
    showDeviceSelector(eid);
}

// --- DEVICE SELECTION ---
let pendingExamId = null;
let previewStream = null;
let selectedVideoId = null;
let selectedAudioId = null;

const VIRTUAL_KEYWORDS = ['virtual', 'obs', 'vcam', 'snap camera', 'manycam', 'xsplit', 'droidcam'];

function isVirtualDevice(label) {
    return VIRTUAL_KEYWORDS.some(kw => label.toLowerCase().includes(kw));
}

async function showDeviceSelector(eid) {
    pendingExamId = eid;
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        tempStream.getTracks().forEach(t => t.stop());
    } catch (e) { console.warn('Temp stream for labels failed:', e); }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    const audioDevices = devices.filter(d => d.kind === 'audioinput');

    const selVideo = document.getElementById('sel-video'); selVideo.innerHTML = '';
    videoDevices.forEach((d, i) => {
        const isVirtual = isVirtualDevice(d.label);
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = isVirtual ? `⚠️ ${d.label || 'Camera ' + (i + 1)} (VIRTUAL)` : `\u2705 ${d.label || 'Camera ' + (i + 1)}`;
        if (isVirtual) opt.style.color = '#ef4444';
        selVideo.appendChild(opt);
    });
    const physicalCam = videoDevices.find(d => !isVirtualDevice(d.label));
    if (physicalCam) selVideo.value = physicalCam.deviceId;

    const selAudio = document.getElementById('sel-audio'); selAudio.innerHTML = '';
    audioDevices.forEach((d, i) => {
        const isVirtual = isVirtualDevice(d.label);
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = isVirtual ? `⚠️ ${d.label || 'Mic ' + (i + 1)} (VIRTUAL)` : `\u2705 ${d.label || 'Mic ' + (i + 1)}`;
        if (isVirtual) opt.style.color = '#ef4444';
        selAudio.appendChild(opt);
    });
    const physicalMic = audioDevices.find(d => !isVirtualDevice(d.label));
    if (physicalMic) selAudio.value = physicalMic.deviceId;

    document.getElementById('device-selector').style.display = 'flex';
    previewDevice();
}

async function previewDevice() {
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
    const videoId = document.getElementById('sel-video').value;
    const audioId = document.getElementById('sel-audio').value;
    const statusEl = document.getElementById('preview-status');
    if (!videoId) { statusEl.innerText = 'No camera selected'; return; }
    statusEl.innerText = '\u23f3 Opening camera preview...';
    try {
        previewStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: videoId } },
            audio: audioId ? { deviceId: { exact: audioId } } : false
        });
        const previewVid = document.getElementById('preview-video');
        previewVid.srcObject = previewStream;
        previewVid.onloadedmetadata = () => { previewVid.play().catch(e => console.warn('preview play:', e)); };
        const vt = previewStream.getVideoTracks()[0];
        statusEl.innerText = `\u2705 ${vt.label} \u2014 ${vt.getSettings().width}x${vt.getSettings().height}`;
        statusEl.style.color = '#10b981';
    } catch (err) {
        console.error('Preview failed:', err);
        statusEl.innerText = `\u274c ${err.message}`;
        statusEl.style.color = '#ef4444';
    }
}

function cancelDeviceSelect() {
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
    document.getElementById('device-selector').style.display = 'none';
}

function confirmDeviceSelect() {
    selectedVideoId = document.getElementById('sel-video').value;
    selectedAudioId = document.getElementById('sel-audio').value;
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
    document.getElementById('preview-video').srcObject = null;
    document.getElementById('device-selector').style.display = 'none';

    // === PRE-EXAM SECURITY SCAN ===
    // Scan task list for banned processes before starting exam
    showPreExamSecurityCheck(pendingExamId, selectedVideoId, selectedAudioId);
}

// Pre-exam banned process check and kill dialog
function showPreExamSecurityCheck(eid, videoId, audioId) {
    // Show scanning modal
    const modal = document.createElement('div');
    modal.id = 'pre-exam-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:99999;
        background:rgba(0,0,0,0.92);
        display:flex; align-items:center; justify-content:center;
        font-family:'DM Sans',sans-serif;
    `;
    modal.innerHTML = `
        <div style="background:#0f172a; border:1px solid rgba(0,212,255,0.25); border-radius:18px;
                    padding:36px; max-width:520px; width:90%; text-align:center; box-shadow:0 0 60px rgba(0,212,255,0.1);">
            <div style="font-size:42px; margin-bottom:12px;">ðŸ”</div>
            <div style="font-size:20px; font-weight:700; color:#f1f5f9; margin-bottom:8px;">Security System Check</div>
            <div style="color:#64748b; font-size:14px; margin-bottom:24px;">Scanning for restricted software...</div>
            <div id="pre-exam-spinner" style="color:#00D4FF; font-size:14px;">
                <i class="fas fa-spinner fa-spin"></i> Scanning running processes...
            </div>
            <div id="pre-exam-result" style="display:none;"></div>
        </div>`;
    document.body.appendChild(modal);

    // Scan processes using tasklist
    const { exec } = require('child_process');
    const BANNED = [
        { key: 'chrome', name: 'Google Chrome', exe: 'chrome.exe' },
        { key: 'firefox', name: 'Mozilla Firefox', exe: 'firefox.exe' },
        { key: 'brave', name: 'Brave Browser', exe: 'brave.exe' },
        { key: 'opera', name: 'Opera', exe: 'opera.exe' },
        { key: 'discord', name: 'Discord', exe: 'discord.exe' },
        { key: 'obs', name: 'OBS Studio', exe: 'obs.exe' },
        { key: 'obs64', name: 'OBS Studio (64-bit)', exe: 'obs64.exe' },
        { key: 'zoom', name: 'Zoom', exe: 'zoom.exe' },
        { key: 'skype', name: 'Skype', exe: 'skype.exe' },
        { key: 'telegram', name: 'Telegram', exe: 'telegram.exe' },
        { key: 'slack', name: 'Slack', exe: 'slack.exe' },
        { key: 'whatsapp', name: 'WhatsApp', exe: 'whatsapp.exe' },
        { key: 'teamviewer', name: 'TeamViewer', exe: 'teamviewer.exe' },
        { key: 'anydesk', name: 'AnyDesk', exe: 'anydesk.exe' },
        { key: 'snippingtool', name: 'Snipping Tool', exe: 'snippingtool.exe' },
        { key: 'screensketch', name: 'Screen Sketch', exe: 'screensketch.exe' },
        { key: 'sharex', name: 'ShareX', exe: 'sharex.exe' },
        { key: 'lightshot', name: 'Lightshot', exe: 'lightshot.exe' },
        { key: 'vmware', name: 'VMware', exe: 'vmware.exe' },
        { key: 'virtualbox', name: 'VirtualBox', exe: 'virtualboxvm.exe' },
        { key: 'parsec', name: 'Parsec', exe: 'parsec.exe' },
        { key: 'rustdesk', name: 'RustDesk', exe: 'rustdesk.exe' }
    ];

    const cmd = process.platform === 'win32' ? 'tasklist /FO CSV /NH' : 'ps aux';
    const detectRestrictedApps = () => new Promise(resolve => {
        exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
            if (err || !stdout) {
                resolve([]);
                return;
            }
            const running = stdout.toLowerCase();
            resolve(BANNED.filter(b => running.includes(b.key.toLowerCase())));
        });
    });

    detectRestrictedApps().then((detected) => {
        const resultEl = document.getElementById('pre-exam-result');
        const spinnerEl = document.getElementById('pre-exam-spinner');

        spinnerEl.style.display = 'none';
        resultEl.style.display = 'block';

        if (detected.length === 0) {
            // All clear â€” start exam directly
            resultEl.innerHTML = `
                <div style="color:#00FF9D; font-size:24px; margin-bottom:12px;">âœ…</div>
                <div style="color:#00FF9D; font-weight:700; font-size:16px; margin-bottom:8px;">All Clear!</div>
                <div style="color:#94a3b8; font-size:13px; margin-bottom:24px;">No restricted software detected. Starting exam...</div>`;
            setTimeout(() => {
                modal.remove();
                launchExam(eid, videoId, audioId);
            }, 1200);
        } else {
            // Found restricted apps â€” show list and ask to terminate
            const listHtml = detected.map(b =>
                `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(239,68,68,0.1);
                 border:1px solid rgba(239,68,68,0.25);border-radius:8px;margin-bottom:6px;">
                    <span style="color:#ef4444;font-size:16px;">â›”</span>
                    <span style="color:#f1f5f9;font-size:14px;font-weight:600;">${b.name}</span>
                 </div>`
            ).join('');

            resultEl.innerHTML = `
                <div style="color:#ef4444; font-size:24px; margin-bottom:10px;">âš ï¸</div>
                <div style="color:#f87171; font-weight:700; font-size:16px; margin-bottom:6px;">
                    ${detected.length} Restricted App${detected.length > 1 ? 's' : ''} Detected
                </div>
                <div style="color:#94a3b8; font-size:13px; margin-bottom:16px;">
                    The following applications must be closed before starting the exam.
                    Click <b style="color:#00D4FF;">Close All & Start Exam</b> and the system will automatically terminate them.
                </div>
                <div style="text-align:left; margin-bottom:20px; max-height:200px; overflow-y:auto;">${listHtml}</div>
                <div style="display:flex; gap:12px; justify-content:center;">
                    <button id="btn-kill-start" style="
                        background:linear-gradient(135deg,#00D4FF,#6366f1); color:#000; font-weight:700;
                        border:none; padding:12px 24px; border-radius:10px; cursor:pointer;
                        font-size:14px; font-family:'DM Sans',sans-serif; width:auto;">
                        ðŸ”« Close All & Start Exam
                    </button>
                    <button id="btn-cancel-exam" style="
                        background:rgba(255,255,255,0.07); color:#94a3b8;
                        border:1px solid rgba(255,255,255,0.1); padding:12px 20px;
                        border-radius:10px; cursor:pointer; font-size:14px;
                        font-family:'DM Sans',sans-serif; width:auto;">
                        Cancel
                    </button>
                </div>`;

            document.getElementById('btn-kill-start').onclick = async () => {
                // Show killing status
                resultEl.innerHTML = `
                    <div style="color:#f59e0b; font-size:24px; margin-bottom:12px;">ðŸ”«</div>
                    <div style="color:#f59e0b; font-weight:700; margin-bottom:8px;">Terminating restricted apps...</div>
                    <div style="color:#64748b; font-size:13px;">${detected.map(b => b.name).join(', ')}</div>`;

                // Kill and verify that nothing restricted is still running
                const killResponse = await ipcRenderer.invoke('kill-banned-processes-and-wait').catch(() => null);
                let stillRunning = [];
                if (killResponse && Array.isArray(killResponse.remaining)) {
                    stillRunning = BANNED.filter(b =>
                        killResponse.remaining.some(procName => procName.toLowerCase().includes(b.key.toLowerCase()))
                    );
                }
                if (stillRunning.length === 0) {
                    stillRunning = await detectRestrictedApps();
                }

                if (stillRunning.length > 0) {
                    resultEl.innerHTML = `
                        <div style="color:#ef4444; font-size:24px; margin-bottom:10px;">!</div>
                        <div style="color:#f87171; font-weight:700; margin-bottom:8px;">Some restricted apps are still running</div>
                        <div style="color:#94a3b8; font-size:13px; margin-bottom:14px;">Close them manually (or run SecurePro as Administrator) and try again.</div>
                        <div style="display:flex; gap:10px; justify-content:center;">
                            <button id="btn-retry-kill" style="background:linear-gradient(135deg,#00D4FF,#6366f1); color:#000; font-weight:700; border:none; padding:10px 18px; border-radius:8px; cursor:pointer; font-size:13px; width:auto;">Retry</button>
                            <button id="btn-close-manual" style="background:rgba(255,255,255,0.07); color:#94a3b8; border:1px solid rgba(255,255,255,0.1); padding:10px 18px; border-radius:8px; cursor:pointer; font-size:13px; width:auto;">Cancel</button>
                        </div>`;
                    document.getElementById('btn-retry-kill').onclick = () => {
                        modal.remove();
                        showPreExamSecurityCheck(eid, videoId, audioId);
                    };
                    document.getElementById('btn-close-manual').onclick = () => {
                        modal.remove();
                    };
                    return;
                }

                resultEl.innerHTML = `
                    <div style="color:#00FF9D; font-size:24px; margin-bottom:12px;">OK</div>
                    <div style="color:#00FF9D; font-weight:700; margin-bottom:8px;">Restricted apps closed</div>
                    <div style="color:#94a3b8; font-size:13px;">Starting exam...</div>`;
                setTimeout(() => {
                    modal.remove();
                    launchExam(eid, videoId, audioId);
                }, 900);
            };

            document.getElementById('btn-cancel-exam').onclick = () => {
                modal.remove();
            };
        }
    });
}



async function launchExam(eid, videoDeviceId, audioDeviceId) {
    activeExamID = eid;
    violationLog = [];
    lastVioTime = {};
    questionTimers = {};
    activeQuestionIndex = null;
    objectDetectionStreak = { phone: 0, object: 0 };
    window._highRiskWarned = false;
    window._lastHighRiskToast = null;
    const e = examDB[eid];
    document.getElementById('student-screen').classList.add('hidden');
    document.getElementById('exam-interface').style.display = 'flex';
    document.getElementById('paper-title').innerText = e.title;
    const sidebarTitle = document.getElementById('paper-title-sidebar');
    if (sidebarTitle) sidebarTitle.innerText = e.title;
    examStartTime = Date.now();
    const b = document.getElementById('paper-content'); b.innerHTML = '';

    // Feature 2: Shuffle questions
    const shuffledQuestions = shuffleArray(e.questions);

    shuffledQuestions.forEach((q, i) => {
        let h = '';
        if (q.type === 'mcq') {
            const opts = shuffleArray(q.opts.split(',').map(o => o.trim()));
            h = opts.map(o => `<div class="mcq-option" onclick="this.querySelector('input').checked=true"><input type="radio" name="q_${i}" value="${escapeHtml(o)}"> <span>${escapeHtml(o)}</span></div>`).join('');
        }
        else if (q.type === 'long') h = `<textarea id="q_${i}" style="height:100px;" placeholder="Type your answer here..."></textarea>`;
        else if (q.type === 'code') {
            const boilerplate = getBoilerplate(q.lang || 'javascript');
            const langDisplay = { 'javascript': 'JavaScript', 'python': 'Python', 'c': 'C', 'c++': 'C++' }[q.lang] || q.lang;
            h = `<div style="background:#0A0F1A; padding:15px; border-radius:var(--radius-md); border:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="color:#CDD6F4; font-size:13px; font-weight:600; font-family:var(--font-mono);"><i class="fas fa-code"></i> ${langDisplay}</span>
                    <span id="run-status_${i}" style="font-size:11px; color:var(--text-muted); font-family:var(--font-mono);">Ready</span>
                </div>
                <textarea id="code_${i}" class="code-editor" spellcheck="false" data-lang="${q.lang || 'javascript'}">${boilerplate}</textarea>
                <div style="display:flex; gap:8px; margin-top:10px; align-items:center;">
                    <button onclick="runCode(${i}, '${q.lang || 'javascript'}')" class="secondary" style="width:auto; font-size:12px; padding:6px 14px;">â–¶ Run</button>
                    <button onclick="checkCode(${i}, '${q.lang || 'javascript'}', '${(q.out || '').replace(/'/g, "\\\\'").replace(/\n/g, '\\\\n')}', '${(q.inp || '').replace(/'/g, "\\\\'").replace(/\n/g, '\\\\n')}')" style="width:auto; font-size:12px; padding:6px 14px; background:var(--success); color:var(--bg-base);">âœ” Test</button>
                    <span id="test-result_${i}" style="font-size:12px; margin-left:8px;"></span>
                </div>
                <div id="console_${i}" class="console-output">// Output will appear here</div>
                <input type="hidden" id="pass_${i}" value="false">
            </div>`;
        }
        b.innerHTML += `<div class="q-block" data-idx="${i}" data-type="${q.type}" data-text="${escapeHtml(q.text)}" data-lang="${q.lang || ''}">
            <div style="display:flex; align-items:center; margin-bottom:12px;"><span class="q-number-chip">${i + 1}</span><span style="font-weight:600; color:var(--text-primary); font-size:15px;">${escapeHtml(q.text)}</span></div>${h}</div>`;
    });

    // Feature 4: AI Paste Detection on long-answer textareas
    document.querySelectorAll('.q-block[data-type="long"] textarea').forEach(ta => {
        ta.addEventListener('paste', (ev) => {
            const pasted = (ev.clipboardData || window.clipboardData).getData('text');
            if (pasted && pasted.trim().length > 80) showVio('AI_PASTE_DETECTED');
        });
    });

    // Feature 3: Question time tracking â€” click listeners
    document.querySelectorAll('.q-block').forEach(div => {
        div.addEventListener('click', () => {
            const idx = parseInt(div.getAttribute('data-idx'));
            const now = Date.now();
            if (activeQuestionIndex !== null && questionTimers[activeQuestionIndex]) {
                questionTimers[activeQuestionIndex].totalSeconds += Math.floor((now - questionTimers[activeQuestionIndex].startTime) / 1000);
            }
            if (!questionTimers[idx]) questionTimers[idx] = { startTime: now, totalSeconds: 0 };
            else questionTimers[idx].startTime = now;
            activeQuestionIndex = idx;
        });
    });
    if (shuffledQuestions.length > 0) { questionTimers[0] = { startTime: Date.now(), totalSeconds: 0 }; activeQuestionIndex = 0; }

    // Feature 8: Question navigation grid
    buildQuestionNav(shuffledQuestions);
    navUpdateInterval = setInterval(updateQuestionNavStatus, 2000);

    // Feature 6: Countdown timer
    examTimeRemainingSeconds = parseInt(e.duration) * 60;
    const timerEl = document.getElementById('exam-countdown');
    if (timerEl) {
        examCountdownInterval = setInterval(() => {
            examTimeRemainingSeconds--;
            const m = Math.floor(examTimeRemainingSeconds / 60);
            const s = examTimeRemainingSeconds % 60;
            timerEl.innerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            if (examTimeRemainingSeconds <= 300) timerEl.style.color = '#FFB800';
            if (examTimeRemainingSeconds <= 60) timerEl.style.color = '#FF2D55';
            if (examTimeRemainingSeconds <= 0) { clearInterval(examCountdownInterval); toast('\u23f0 Time is up! Auto-submitting...'); submitPaper(); }
        }, 1000);
    }

    stopAllCameras();
    if (noiseRecorder && noiseRecorder.state === 'recording') {
        try { noiseRecorder.stop(); } catch (_) { }
    }
    analyser = null;
    dataArray = null;
    audioTimeDataArray = null;
    resetAudioMonitoringState();
    if (audioContext) {
        audioContext.close().catch(() => { });
        audioContext = null;
    }

    try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
    } catch (acErr) { console.warn('AudioContext init failed:', acErr); }

    const constraints = {
        video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true
    };

    try {
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        const videoEl = document.getElementById('exam-video');
        videoEl.srcObject = currentStream;
        videoEl.onloadedmetadata = () => {
            videoEl.play().then(() => console.log('Exam video playing')).catch(err => console.error('Play failed:', err));
        };
        setupAudio(currentStream);

        // Feature 1: Copy-paste blocking
        document.addEventListener('keydown', blockExamShortcuts);
        document.addEventListener('contextmenu', blockContextMenu);
        document.addEventListener('copy', blockClipboardEvents);
        document.addEventListener('cut', blockClipboardEvents);
        document.addEventListener('paste', blockClipboardEvents);
        document.addEventListener('visibilitychange', handleTabSwitch);
        window.addEventListener('blur', handleTabSwitch);

        // Block trackpad pinch-zoom, ctrl+scroll, and horizontal swipe navigation
        window.addEventListener('wheel', blockGestureWheel, { passive: false });
        window.addEventListener('gesturestart', blockNativeGesture, { passive: false });
        window.addEventListener('gesturechange', blockNativeGesture, { passive: false });
        window.addEventListener('gestureend', blockNativeGesture, { passive: false });

        // Phase 1/2/3 Initialization
        ipcRenderer.send('start-process-monitor');
        ipcRenderer.send('show-blackout'); // ðŸ–¤ Black out + global shortcut blocking
        checkNetworkIP();
        networkCheckInterval = setInterval(checkNetworkIP, 300000);
        faceReverifyInterval = setInterval(periodicFaceReverify, 600000);

        // EYE TRACKING & LIVE MONITORING
        initGazeTracking();
        setTimeout(startCalibrationProcess, 2000);
        document.addEventListener('keydown', trackTypingSpeed);
        document.addEventListener('mouseleave', trackCursorLeave);
        document.addEventListener('mousemove', trackActivity);
        document.addEventListener('scroll', trackActivity);
        inactivityInterval = setInterval(checkInactivity, 60000);
        setInterval(checkQuestionTimeouts, 1000);
        populateWatermark();

        proctorInt = setInterval(() => checkFrame(), parseInt(e.severity));
    } catch (err) {
        console.error('Media Error:', err);
        alert(`Hardware Error: ${err.name} - ${err.message}.\nCheck camera permissions.`);
    }

    // Feature 7: Auto-save + restore draft
    autoSaveInterval = setInterval(autoSaveAnswers, 30000);
    try {
        const draftRes = await dynamodb.get({ TableName: 'securepro-drafts', Key: { studentId: currentStudent, examId: eid } }).promise();
        if (draftRes.Item && draftRes.Item.draft) {
            const draft = draftRes.Item.draft;
            Object.keys(draft).forEach(idx => {
                const type = document.querySelector(`.q-block[data-idx="${idx}"]`)?.getAttribute('data-type');
                if (type === 'long' && document.getElementById(`q_${idx}`)) document.getElementById(`q_${idx}`).value = draft[idx];
                if (type === 'code' && document.getElementById(`code_${idx}`)) document.getElementById(`code_${idx}`).value = draft[idx];
                if (type === 'mcq') { const radio = document.querySelector(`input[name="q_${idx}"][value="${draft[idx]}"]`); if (radio) radio.checked = true; }
            });
            toast('\ud83d\udcdd Draft restored from last session');
        }
    } catch (e) { /* no draft */ }
}

// Feature 7: Auto-save function
async function autoSaveAnswers() {
    if (!currentStudent || !activeExamID) return;
    const draft = {};
    document.querySelectorAll('.q-block').forEach(div => {
        const i = div.getAttribute('data-idx');
        const type = div.getAttribute('data-type');
        if (type === 'mcq') { const el = document.querySelector(`input[name="q_${i}"]:checked`); if (el) draft[i] = el.value; }
        else if (type === 'long') draft[i] = document.getElementById(`q_${i}`)?.value || '';
        else if (type === 'code') draft[i] = document.getElementById(`code_${i}`)?.value || '';
    });
    try {
        await dynamodb.put({ TableName: 'securepro-drafts', Item: { studentId: currentStudent, examId: activeExamID, draft, savedAt: Date.now() } }).promise();
        const ind = document.getElementById('autosave-indicator');
        if (ind) { ind.innerText = '\u2713 SAVED'; ind.style.opacity = '1'; setTimeout(() => ind.style.opacity = '0.3', 2000); }
    } catch (e) { console.warn('Autosave failed:', e.message); }
}

// Feature 8: Question navigation
function buildQuestionNav(questions) {
    const grid = document.getElementById('q-nav-grid');
    if (!grid) return;
    grid.innerHTML = questions.map((q, i) =>
        `<div id="qnav-${i}" onclick="scrollToQuestion(${i})"
            style="width:32px; height:32px; border-radius:6px; display:flex; align-items:center;
                   justify-content:center; font-size:12px; font-weight:700; cursor:pointer;
                   background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1);
                   color:#64748B; font-family:'JetBrains Mono',monospace; transition:all 0.2s;
                   user-select:none;" title="Q${i + 1}">${i + 1}</div>`
    ).join('');
}
function scrollToQuestion(idx) {
    const block = document.querySelector(`.q-block[data-idx="${idx}"]`);
    if (block) block.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function updateQuestionNavStatus() {
    document.querySelectorAll('.q-block').forEach(div => {
        const i = parseInt(div.getAttribute('data-idx'));
        const type = div.getAttribute('data-type');
        const navDot = document.getElementById(`qnav-${i}`);
        if (!navDot) return;
        let answered = false;
        if (type === 'mcq') answered = !!document.querySelector(`input[name="q_${i}"]:checked`);
        else if (type === 'long') answered = (document.getElementById(`q_${i}`)?.value || '').trim().length > 0;
        else if (type === 'code') {
            const code = document.getElementById(`code_${i}`)?.value || '';
            const lang = div.getAttribute('data-lang') || 'javascript';
            const boiler = getBoilerplate(lang);
            answered = code.trim() !== boiler.trim();
        }
        navDot.style.background = answered ? 'rgba(0,255,157,0.15)' : 'rgba(255,255,255,0.05)';
        navDot.style.borderColor = answered ? 'rgba(0,255,157,0.4)' : 'rgba(255,255,255,0.1)';
        navDot.style.color = answered ? '#00FF9D' : '#64748B';
    });
}

async function submitPaper() {
    isDisqualified = false;
    clearInterval(proctorInt);
    if (examCountdownInterval) clearInterval(examCountdownInterval);
    if (autoSaveInterval) clearInterval(autoSaveInterval);
    if (navUpdateInterval) clearInterval(navUpdateInterval);
    if (networkCheckInterval) clearInterval(networkCheckInterval);
    if (faceReverifyInterval) clearInterval(faceReverifyInterval);
    if (inactivityInterval) clearInterval(inactivityInterval);
    if (liveSnapshotInterval) clearInterval(liveSnapshotInterval);
    try { if (typeof webgazer !== 'undefined') webgazer.end(); } catch (e) { }

    ipcRenderer.send('stop-process-monitor');
    ipcRenderer.send('hide-blackout'); // âœ… Remove black overlay â€” exam over
    stopAllCameras();
    if (noiseRecorder && noiseRecorder.state === 'recording') {
        try { noiseRecorder.stop(); } catch (_) { }
    }
    analyser = null;
    dataArray = null;
    audioTimeDataArray = null;
    resetAudioMonitoringState();
    if (audioContext) {
        audioContext.close().catch(() => { });
        audioContext = null;
    }

    document.removeEventListener('keydown', blockExamShortcuts);
    document.removeEventListener('contextmenu', blockContextMenu);
    document.removeEventListener('copy', blockClipboardEvents);
    document.removeEventListener('cut', blockClipboardEvents);
    document.removeEventListener('paste', blockClipboardEvents);
    document.removeEventListener('visibilitychange', handleTabSwitch);
    window.removeEventListener('blur', handleTabSwitch);
    window.removeEventListener('wheel', blockGestureWheel);
    window.removeEventListener('gesturestart', blockNativeGesture);
    window.removeEventListener('gesturechange', blockNativeGesture);
    window.removeEventListener('gestureend', blockNativeGesture);
    document.removeEventListener('keydown', trackTypingSpeed);
    document.removeEventListener('mouseleave', trackCursorLeave);
    document.removeEventListener('mousemove', trackActivity);
    document.removeEventListener('scroll', trackActivity);

    const submitBtn = document.querySelector('#exam-interface button[onclick="submitPaper()"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = '\u23f3 Submitting...'; }

    // Feature 3: Finalize active question timer
    if (activeQuestionIndex !== null && questionTimers[activeQuestionIndex]) {
        questionTimers[activeQuestionIndex].totalSeconds += Math.floor((Date.now() - questionTimers[activeQuestionIndex].startTime) / 1000);
    }

    const answers = [];
    document.querySelectorAll('.q-block').forEach(div => {
        const i = div.getAttribute('data-idx');
        const type = div.getAttribute('data-type');
        let ans = '', passed = false;
        if (type === 'mcq') { const el = document.querySelector(`input[name="q_${i}"]:checked`); ans = el ? el.value : ''; }
        else if (type === 'long') ans = document.getElementById(`q_${i}`).value;
        else if (type === 'code') { ans = document.getElementById(`code_${i}`).value; passed = document.getElementById(`pass_${i}`).value === 'true'; }
        answers.push({ question: div.getAttribute('data-text'), answer: ans, isCode: type === 'code', passed, timeSpentSeconds: questionTimers[parseInt(i)] ? questionTimers[parseInt(i)].totalSeconds : null });
    });

    // Feature 3: Fast answer flags
    const fastAnswerFlags = answers.filter(a => {
        if (!a.timeSpentSeconds) return false;
        if (a.isCode) return a.timeSpentSeconds < 15;
        if (a.answer && a.answer.length > 100) return a.timeSpentSeconds < 10;
        return false;
    }).map(a => a.question.substring(0, 60));

    const attemptId = `${activeExamID}_${Date.now()}`;
    const uploadedViolations = [];
    for (const v of (violationLog || [])) {
        const vc = { type: v.type, timestamp: v.timestamp, timeIntoExam: v.timeIntoExam, proofType: v.proofType || 'camera' };

        // Upload screenshot proof (webcam photo OR screen screenshot)
        if (v.screenshotBase64) {
            try {
                const isScreen = v.proofType === 'screen';
                const ext = isScreen ? '.png' : '.jpg';
                const mime = isScreen ? 'image/png' : 'image/jpeg';
                const key = `violations/${currentStudent}/${attemptId}/${v.timestamp}${ext}`;
                await s3UploadBase64(key, v.screenshotBase64, mime);
                vc.screenshotKey = key;
            } catch (e) { console.warn('Screenshot upload failed:', e.message); vc.screenshotKey = null; }
        }

        // Upload audio proof (voice clips)
        if (v.audioBase64) {
            try {
                const key = `violations/${currentStudent}/${attemptId}/${v.timestamp}.webm`;
                await s3UploadBase64(key, v.audioBase64, 'audio/webm');
                vc.audioKey = key;
            } catch (e) { console.warn('Audio upload failed:', e.message); vc.audioKey = null; }
        }

        uploadedViolations.push(vc);
    }

    const attempt = { attemptId, examID: activeExamID, examTitle: document.getElementById('paper-title').innerText, answers, violations: uploadedViolations, cheatingScore: calculateCheatingScore(violationLog || []), submittedAt: Date.now(), fastAnswerFlags };
    try {
        await dbPutResult(currentStudent, attempt);
        // Delete draft
        try { await dynamodb.delete({ TableName: 'securepro-drafts', Key: { studentId: currentStudent, examId: activeExamID } }).promise(); } catch (de) { }
        // Feature 9: Show receipt
        document.getElementById('exam-interface').style.display = 'none';
        const receipt = document.getElementById('receipt-screen');
        receipt.style.display = 'flex';
        document.getElementById('receipt-exam-title').innerText = attempt.examTitle;
        document.getElementById('receipt-attempt-id').innerText = attempt.attemptId;
        document.getElementById('receipt-timestamp').innerText = new Date(attempt.submittedAt).toLocaleString();
        setTimeout(() => location.reload(), 5000);
    } catch (e) { toast('Submission failed: ' + e.message, true); console.error(e); if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Submit Exam'; } }
}

// --- AUDIO PROCESSING ---
function resetAudioMonitoringState() {
    audioFrameLastTs = 0;
    voiceActiveMs = 0;
    lastVoiceViolationTs = 0;
    roomAudioBaseline = { calibrated: false, rms: 0.012, speechRatio: 0.25, zcr: 0.08 };
    roomAudioCalibration = {
        active: false,
        endsAt: 0,
        rmsSamples: [],
        speechRatioSamples: [],
        zcrSamples: []
    };
}

function beginRoomAudioCalibration() {
    resetAudioMonitoringState();
    roomAudioCalibration.active = true;
    roomAudioCalibration.endsAt = Date.now() + AUDIO_CALIBRATION_MS;
    toast('Calibrating room audio for 5 seconds. Please stay quiet.');
}

function finishRoomAudioCalibration() {
    const rmsSamples = roomAudioCalibration.rmsSamples;
    const speechSamples = roomAudioCalibration.speechRatioSamples;
    const zcrSamples = roomAudioCalibration.zcrSamples;

    const mean = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const rmsMean = mean(rmsSamples);
    const speechMean = mean(speechSamples);
    const zcrMean = mean(zcrSamples);

    roomAudioBaseline = {
        calibrated: true,
        rms: Math.max(0.008, rmsMean || 0.012),
        speechRatio: Math.max(0.12, speechMean || 0.22),
        zcr: Math.max(0.03, zcrMean || 0.08)
    };

    roomAudioCalibration.active = false;
    roomAudioCalibration.endsAt = 0;
    roomAudioCalibration.rmsSamples = [];
    roomAudioCalibration.speechRatioSamples = [];
    roomAudioCalibration.zcrSamples = [];

    toast('Room audio calibrated. Voice-only monitoring is active.');
}

function getAudioFeatures() {
    if (!analyser || !dataArray || !audioTimeDataArray) return null;

    analyser.getByteFrequencyData(dataArray);
    analyser.getByteTimeDomainData(audioTimeDataArray);

    let totalFreq = 0;
    let totalEnergy = 0;
    let speechEnergy = 0;
    let highEnergy = 0;

    const sampleRate = (audioContext && audioContext.sampleRate) ? audioContext.sampleRate : 48000;
    const nyquist = sampleRate / 2;
    const binHz = nyquist / dataArray.length;

    for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i];
        totalFreq += v;
        const norm = v / 255;
        totalEnergy += norm;
        const hz = i * binHz;
        if (hz >= 300 && hz <= 3400) speechEnergy += norm;
        if (hz >= 4000) highEnergy += norm;
    }

    let sumSquares = 0;
    let signChanges = 0;
    let prev = (audioTimeDataArray[0] - 128) / 128;
    for (let i = 0; i < audioTimeDataArray.length; i++) {
        const centered = (audioTimeDataArray[i] - 128) / 128;
        sumSquares += centered * centered;
        if ((centered >= 0) !== (prev >= 0)) signChanges++;
        prev = centered;
    }

    const avg = totalFreq / dataArray.length;
    const rms = Math.sqrt(sumSquares / audioTimeDataArray.length);
    const zcr = signChanges / audioTimeDataArray.length;
    const speechRatio = speechEnergy / Math.max(totalEnergy, 1e-6);
    const highRatio = highEnergy / Math.max(totalEnergy, 1e-6);

    return { avg, rms, zcr, speechRatio, highRatio };
}

function isLikelyVoice(features) {
    if (!features) return false;
    // Act as a room noise threshold: Any noise 1.5x louder than the room's average
    // will trigger the alarm, rather than specifically restricting to human voice only.
    const rmsGate = Math.max(MIN_VOICE_RMS, roomAudioBaseline.rms * 1.5);

    return features.rms >= rmsGate;
}

function setupAudio(stream) {
    if (!audioContext) return;
    if (audioContext.state === 'suspended') {
        audioContext.resume().catch(e => console.error('Could not resume audio:', e));
    }
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 1024;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    audioTimeDataArray = new Uint8Array(analyser.fftSize);
    beginRoomAudioCalibration();
    monitorAudio();
}

function monitorAudio() {
    if (!analyser) return;
    requestAnimationFrame(monitorAudio);

    const features = getAudioFeatures();
    if (!features) return;

    const now = Date.now();
    if (!audioFrameLastTs) audioFrameLastTs = now;
    const deltaMs = Math.max(8, now - audioFrameLastTs);
    audioFrameLastTs = now;

    // Original bar (hidden, kept for compatibility)
    const bar = document.getElementById('audio-level');
    if (bar) {
        bar.style.width = features.avg + '%';
        if (features.avg > NOISE_THRESHOLD) bar.classList.add('loud');
        else bar.classList.remove('loud');
    }

    // Animate new waveform bars
    const bars = document.querySelectorAll('#audio-bars-display .audio-bar');
    bars.forEach((b, i) => {
        const freq = dataArray[Math.floor((i / bars.length) * dataArray.length / 3)] || 0;
        const h = Math.max(3, (freq / 255) * 26);
        b.style.height = h + 'px';
        if (features.avg > NOISE_THRESHOLD) b.classList.add('loud');
        else b.classList.remove('loud');
    });

    if (roomAudioCalibration.active) {
        roomAudioCalibration.rmsSamples.push(features.rms);
        roomAudioCalibration.speechRatioSamples.push(features.speechRatio);
        roomAudioCalibration.zcrSamples.push(features.zcr);
        if (now >= roomAudioCalibration.endsAt) finishRoomAudioCalibration();
        return;
    }
    if (!roomAudioBaseline.calibrated) return;

    const likelyVoice = isLikelyVoice(features);
    if (likelyVoice) voiceActiveMs += deltaMs;
    else voiceActiveMs = Math.max(0, voiceActiveMs - (deltaMs * 1.7));

    if (
        likelyVoice &&
        voiceActiveMs >= VOICE_MIN_ACTIVE_MS &&
        (now - lastVoiceViolationTs) >= VOICE_MIN_GAP_MS
    ) {
        lastVoiceViolationTs = now;
        voiceActiveMs = 0;
        showVio('NOISE_DETECTED');
    }
}

// --- PROCTORING ---
function checkFrame() {
    const v = document.getElementById('exam-video');
    if (!v || v.videoWidth === 0 || v.videoHeight === 0) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const b64 = c.toDataURL('image/jpeg');
    const b = getBuffer(b64);
    if (b.length < 100) return;

    // Strict allow-list (exact normalized label match only)
    const phoneLabels = new Set([
        'phone', 'mobile phone', 'cell phone', 'smartphone', 'telephone'
    ]);
    const objectLabels = new Set([
        'book', 'textbook',
        'tablet', 'tablet computer', 'ipad',
        'document', 'paper'
    ]);

    rekognition.detectLabels({ Image: { Bytes: b }, MinConfidence: 85 }, (e, d) => {
        if (e || !d || !d.Labels) return;
        const labels = d.Labels.map(l => ({
            name: normalizeAwsLabel(l.Name),
            confidence: Number(l.Confidence || 0),
            hasInstance: Array.isArray(l.Instances) && l.Instances.length > 0
        }));

        // Phone detection
        const isPhone = labels.some(l =>
            phoneLabels.has(l.name) &&
            l.confidence >= 90 &&
            l.hasInstance
        );
        objectDetectionStreak.phone = isPhone ? objectDetectionStreak.phone + 1 : 0;
        if (objectDetectionStreak.phone >= OBJECT_DETECTION_STREAK_REQUIRED) {
            objectDetectionStreak.phone = 0;
            showVio('PHONE_DETECTED');
        }

        // Book / electronics detection
        const foundObj = labels.find(l =>
            objectLabels.has(l.name) &&
            l.confidence >= 93 &&
            l.hasInstance
        );
        if (foundObj) {
            objectDetectionStreak.object += 1;
        } else {
            objectDetectionStreak.object = 0;
        }
        if (objectDetectionStreak.object >= OBJECT_DETECTION_STREAK_REQUIRED) {
            objectDetectionStreak.object = 0;
            showVio('OBJECT_DETECTED');
        }
    });

    if (!isTestBypassUser()) {
        rekognition.detectFaces({ Image: { Bytes: b }, Attributes: ['ALL'] }, (e, d) => {
            if (!e) {
                if (d.FaceDetails.length === 0) showVio('NO_FACE');
                else if (d.FaceDetails.length > 1) showVio('MULTIPLE_FACES');
                else {
                    const face = d.FaceDetails[0];
                    const p = face.Pose;
                    // 25Â° threshold for looking away (aligned with 25% movement request)
                    if (Math.abs(p.Yaw) > 25 || Math.abs(p.Pitch) > 25) {
                        showVio('LOOKING_AWAY');
                    }

                    // Lip movement detection
                    const mouth = face.MouthOpen;
                    if (mouth && mouth.Value === true && mouth.Confidence > 85) {
                        window._mouthOpenCount = (window._mouthOpenCount || 0) + 1;
                        if (window._mouthOpenCount >= 3) { showVio('LIP_MOVEMENT'); window._mouthOpenCount = 0; }
                    } else {
                        window._mouthOpenCount = Math.max(0, (window._mouthOpenCount || 0) - 1);
                    }
                }
            }
        });
    }
}

let vioTimeout = null;
function showVio(m) {
    if (isDisqualified) return;
    const vOverlay = document.getElementById('v-overlay');
    vOverlay.style.display = 'flex';
    const displayNames = {
        'NOISE_DETECTED': 'VOICE DETECTED',
        'PHONE_DETECTED': 'PHONE RECOGNITION',
        'OBJECT_DETECTED': 'OBJECT DETECTED',
        'IDENTITY_MISMATCH': 'IDENTITY MISMATCH',
        'BANNED_PROCESS_RUNNING': 'BANNED APP DETECTED',
        'MULTIPLE_DISPLAYS': 'MULTIPLE DISPLAYS',
        'NETWORK_ANOMALY': 'NETWORK ANOMALY',
        'UNNATURAL_TYPING': 'UNNATURAL TYPING',
        'CURSOR_OUT_OF_BOUNDS': 'CURSOR OUT OF BOUNDS',
        'INACTIVITY_DETECTED': 'INACTIVITY DETECTED',
        'NO_FACE': 'NO FACE DETECTED',
        'MULTIPLE_FACES': 'MULTIPLE FACES',
        'LOOKING_AWAY': 'LOOKING AWAY',
        'COPY_PASTE_ATTEMPT': 'COPY PASTE ATTEMPT',
        'AI_PASTE_DETECTED': 'AI PASTE DETECTED',
        'LIP_MOVEMENT': 'LIP MOVEMENT',
        'TAB_SWITCH': 'TAB SWITCH'
    };
    document.getElementById('v-msg').innerText = displayNames[m] || m.replace(/_/g, ' ');

    if (vioTimeout) clearTimeout(vioTimeout);
    vioTimeout = setTimeout(() => {
        if (!isDisqualified && vOverlay) vOverlay.style.display = 'none';
    }, 4000);

    // Camera border flash
    const camWrap = document.getElementById('exam-cam-wrap');
    if (camWrap) {
        camWrap.className = 'exam-cam-wrap violation';
        setTimeout(() => { if (camWrap) camWrap.className = 'exam-cam-wrap monitoring'; }, 5000);
    }

    const now = Date.now();
    const typeKey = m.replace(/ /g, '_');
    if (lastVioTime[typeKey] && (now - lastVioTime[typeKey]) < 15000) return; // Cooldown
    lastVioTime[typeKey] = now;

    if (violationLog.length >= 20) {
        // Still record but no more proof captures after 20
        violationLog.push({ type: typeKey, timestamp: now, timeIntoExam: Math.floor((now - (examStartTime || now)) / 1000), proofType: 'none' });
    } else {
        // Create violation entry first (proof filled async below)
        const vioEntry = {
            type: typeKey,
            timestamp: now,
            timeIntoExam: Math.floor((now - (examStartTime || now)) / 1000),
            screenshotBase64: null,
            audioBase64: null,
            proofType: 'none'
        };
        violationLog.push(vioEntry);

        if (typeKey === 'TAB_SWITCH') {
            // ðŸ“º Capture the SCREEN (not webcam) as proof of what they switched to
            captureScreenScreenshot().then(ss => {
                if (ss) { vioEntry.screenshotBase64 = ss; vioEntry.proofType = 'screen'; }
            }).catch(() => { });

        } else if (typeKey === 'NOISE_DETECTED') {
            // ðŸŽ™ Record 6s of voice audio as proof
            recordNoiseAudio(6000).then(audio => {
                if (audio) { vioEntry.audioBase64 = audio; vioEntry.proofType = 'audio'; }
            }).catch(() => { });

        } else {
            // ðŸ“· Default: webcam snapshot (face-based violations)
            vioEntry.screenshotBase64 = captureViolationSnapshot();
            vioEntry.proofType = 'camera';
        }
    }

    // === HIGH CHEATING SCORE WARNING (no auto-submit â€” admin sees everything at end) ===
    const currentScore = calculateCheatingScore(violationLog);
    if (currentScore > 65 && !window._highRiskWarned) {
        window._highRiskWarned = true;
        // Show a non-blocking warning â€” student can still continue and submit
        toast(`âš ï¸ High cheating score detected (${currentScore}/100). All violations are being recorded for admin review.`, true);
        // Flash the overlay briefly but don't lock the exam
        const vOverlay = document.getElementById('v-overlay');
        if (vOverlay) {
            vOverlay.style.display = 'flex';
            document.getElementById('v-msg').innerText = `âš ï¸ WARNING: High Risk Score (${currentScore}/100)\nAll violations recorded. Continue your exam.`;
            setTimeout(() => { vOverlay.style.display = 'none'; }, 5000);
        }
    } else if (currentScore > 65) {
        // Subsequent high-score violations â€” just toast, no overlay spam
        if (!window._lastHighRiskToast || Date.now() - window._lastHighRiskToast > 60000) {
            window._lastHighRiskToast = Date.now();
            toast(`ðŸš¨ Cheating score: ${currentScore}/100 â€” Recorded for admin`, true);
        }
    }
}

// === QUESTION TIME LIMITS ===
function checkQuestionTimeouts() {
    if (!activeExamID) return;
    const maxTime = 300; // e.g., 5 mins max per question (300 sec)
    for (const [idx, timer] of Object.entries(questionTimers)) {
        let total = timer.totalSeconds;
        if (activeQuestionIndex === parseInt(idx)) {
            total += Math.floor((Date.now() - timer.startTime) / 1000);
        }
        if (total > maxTime) {
            const block = document.querySelector(`.q-block[data-idx="${idx}"]`);
            if (block && !block.classList.contains('locked')) {
                block.classList.add('locked');
                block.querySelectorAll('input, textarea, button').forEach(el => el.disabled = true);
                block.style.opacity = '0.6';
                block.querySelector('.q-number-chip').innerText += ' â³ LOCKED';
                block.querySelector('.q-number-chip').style.color = '#ef4444';
            }
        }
    }
}

function getBuffer(b64) {
    return Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
}

// â”€â”€ AUTO-PROVISION TEST STUDENT s2 + TEST EXAM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ensures the bypass test account always exists with an exam assigned so devs
// / admins can quickly test features without manual setup.
async function provisionTestStudent() {
    try {
        // 1. Ensure student s2 exists
        const existing = await dbGetStudent(TEST_BYPASS_ID);
        if (!existing) {
            await dbPutStudent(TEST_BYPASS_ID, {
                name: 'Test Student',
                email: 'test@securepro.local',
                mobile: '0000000000',
                photoKey: 'photos/s2_placeholder.jpg' // bypassed by TEST_BYPASS_ID
            });
            console.log('[TEST] Created test student s2');
        }

        // 2. Ensure test exam exists
        await dbGetAllExams();
        const TEST_EXAM_TITLE = 'ðŸ§ª SecurePro Feature Test Exam';
        const existingTestExam = Object.values(examDB).find(e => e.title === TEST_EXAM_TITLE);
        let testExamId;

        if (!existingTestExam) {
            testExamId = 'exam_test_s2_permanent';
            await dbPutExam(testExamId, {
                title: TEST_EXAM_TITLE,
                duration: '30',
                severity: '3000',
                questions: [
                    {
                        type: 'mcq',
                        text: 'What is 1 + 1?',
                        opts: 'A: 1, B: 2, C: 3, D: 4',
                        ans: 'B',
                        keywords: '',
                        lang: '',
                        inp: '',
                        out: ''
                    },
                    {
                        type: 'long',
                        text: 'Briefly describe what you can see in this room.',
                        opts: '',
                        ans: '',
                        keywords: 'room,see,describe',
                        lang: '',
                        inp: '',
                        out: ''
                    }
                ],
                startAt: null,
                endAt: null
            });
            console.log('[TEST] Created test exam:', testExamId);
        } else {
            testExamId = existingTestExam.examId;
        }

        // 3. Ensure test exam is assigned to s2
        const assigned = await dbGetAssignments(TEST_BYPASS_ID);
        if (!assigned.includes(testExamId)) {
            await dbSetAssignments(TEST_BYPASS_ID, [...assigned, testExamId]);
            console.log('[TEST] Assigned test exam to s2');
        }
    } catch (e) {
        console.warn('[TEST] Could not provision test student:', e.message);
    }
}

// Run test provisioning on page load (after AWS is ready)
setTimeout(() => provisionTestStudent(), 3000);

// â”€â”€ CLEANUP ON APP CLOSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.addEventListener('beforeunload', () => {
    try { ipcRenderer.send('hide-blackout'); } catch (e) { /* ignore */ }
    try { ipcRenderer.send('stop-process-monitor'); } catch (e) { /* ignore */ }
});

ipcRenderer.on('app-closing', () => {
    try { ipcRenderer.send('hide-blackout'); } catch (e) { /* ignore */ }
});

// Auth form enter key submission listener
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const authScreen = document.getElementById('auth-screen');
        if (authScreen && authScreen.style.display !== 'none') {
            const activeView = document.querySelector('.auth-card > div:not(.hidden):not(.auth-tabs):not(.auth-logo):not(.auth-subtitle)');
            if (activeView) {
                if (activeView.id === 'view-login') handleStudentLogin();
                else if (activeView.id === 'view-admin') handleAdminLogin();
                else if (activeView.id === 'view-register') registerUser();
            }
        }
    }
});


