(() => {
    const video = document.getElementById('vt-video');
    const startBtn = document.getElementById('vt-start');
    const retryBtn = document.getElementById('vt-retry');
    const distanceStatus = document.getElementById('distance-status');
    const warningEl = document.getElementById('vt-warning');
    const stageEl = document.getElementById('vt-stage');
    const letterEl = document.getElementById('vt-letter');
    const resultEl = document.getElementById('vt-result');
    const toggleCamBtn = document.getElementById('toggle-camera');

    if (!video || !startBtn || !distanceStatus || !stageEl || !letterEl) return;

    // For phone usage distance (arm's length): ~0.30–0.50 m
    const idealMin = 0.30; // meters
    const idealMax = 0.50; // meters
    let streamActive = false;
    let testActive = false;
    let model = null;
    let detectionRunning = false;
    let direction = 'up';
    let sizeStepIndex = 0;
    let correctStreak = 0;
    const steps = [
        { px: 120, acuity: '6/60' },
        { px: 96, acuity: '6/36' },
        { px: 72, acuity: '6/24' },
        { px: 56, acuity: '6/18' },
        { px: 44, acuity: '6/12' },
        { px: 36, acuity: '6/9' },
        { px: 30, acuity: '6/6' }
    ];

    function pickDirection() {
        const dirs = ['up','down','left','right'];
        direction = dirs[Math.floor(Math.random() * dirs.length)];
        const rotations = { up: 0, right: 90, down: 180, left: 270 };
        letterEl.style.transform = `rotate(${rotations[direction]}deg)`;
    }

    function setSize() {
        const step = steps[sizeStepIndex];
        letterEl.style.fontSize = step.px + 'px';
    }

    const readyBadge = document.getElementById('ready-badge');
    function setReadyState(isReady) {
        if (!readyBadge) return;
        readyBadge.textContent = isReady ? 'Ready' : 'Adjust';
        readyBadge.classList.toggle('ready', isReady);
        readyBadge.classList.toggle('adjust', !isReady);
    }

    function updateDistanceStatus(distanceMeters) {
        if (!Number.isFinite(distanceMeters)) {
            distanceStatus.textContent = 'Distance: unknown';
            return;
        }
        distanceStatus.textContent = `Distance: ${distanceMeters.toFixed(2)} m`;
        if (distanceMeters < idealMin || distanceMeters > idealMax) {
            warningEl.textContent = 'Please move farther or closer to the screen to start the test.';
            setReadyState(false);
        } else {
            warningEl.textContent = '';
        }
    }

    async function waitForVideoReady() {
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) return;
        await new Promise((resolve) => {
            const onReady = () => {
                video.removeEventListener('loadedmetadata', onReady);
                resolve();
            };
            video.addEventListener('loadedmetadata', onReady, { once: true });
        });
    }

    async function enableCamera() {
        if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
            warningEl.textContent = 'Camera requires HTTPS. Please use a secure connection.';
            return;
        }
        try {
            // Try to query permission state first (best-effort)
            if (navigator.permissions && navigator.permissions.query) {
                try {
                    const status = await navigator.permissions.query({ name: 'camera' });
                    if (status.state === 'denied') {
                        warningEl.textContent = 'Camera permission denied. Enable it in your browser settings.';
                        return;
                    }
                } catch (_) {}
            }

            const constraints = { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            streamActive = true;
            document.querySelector('.vt-camera').style.display = 'block';
            warningEl.textContent = '';
            try { await video.play(); } catch (_) {}
            await waitForVideoReady();

            if (!model && window.blazeface) {
                try {
                    if (window.tf && tf.ready) {
                        await tf.ready();
                        if (tf.setBackend) {
                            try { await tf.setBackend('webgl'); } catch (_) {}
                        }
                    }
                    model = await blazeface.load();
                } catch (e) {
                    warningEl.textContent = 'Face model failed to load.';
                }
            }
            detectionLoop();
        } catch (e) {
            warningEl.textContent = 'Unable to access camera. Please grant permission in your browser.';
        }
    }

    function disableCamera() {
        const stream = video.srcObject;
        if (stream && stream.getTracks) stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
        streamActive = false;
        const cam = document.querySelector('.vt-camera');
        if (cam) cam.style.display = 'none';
    }

    // Distance and gaze estimation using BlazeFace
    function estimateDistance(face) {
        const focalLength = 4.15; // mm
        const sensorWidth = 6.4; // mm
        const faceWidth = 160; // mm average face width
        const imageFaceWidth = Math.max(1, face.right - face.left); // pixels
        const cameraResolutionWidth = video.videoWidth || 640; // pixels
        const distanceMm = (faceWidth * focalLength) / (imageFaceWidth * (sensorWidth / cameraResolutionWidth));
        return distanceMm / 1000; // meters
    }

    function estimateGazeForward(face) {
        const cx = (face.left + face.right) / 2;
        const cy = (face.top + face.bottom) / 2;
        const w = (face.right - face.left);
        const h = (face.bottom - face.top);
        const nx = cx / (video.videoWidth || 640) - 0.5;
        const ny = cy / (video.videoHeight || 480) - 0.5;
        const centered = Math.abs(nx) < 0.18 && Math.abs(ny) < 0.18;
        const ratio = w / Math.max(1, h);
        const frontal = ratio > 0.7 && ratio < 1.4;
        return centered && frontal;
    }

    function toFaceBox(pred) {
        // BlazeFace returns topLeft and bottomRight as [x,y] (numbers). Some builds may return arrays of arrays.
        const tl = Array.isArray(pred.topLeft) ? pred.topLeft : [pred.topLeft[0], pred.topLeft[1]];
        const br = Array.isArray(pred.bottomRight) ? pred.bottomRight : [pred.bottomRight[0], pred.bottomRight[1]];
        return { left: tl[0], top: tl[1], right: br[0], bottom: br[1] };
    }

    function detectionLoop() {
        if (!model || !streamActive || detectionRunning) return;
        detectionRunning = true;
        const step = async () => {
            if (!model || !streamActive) { detectionRunning = false; return; }
            try {
                const predictions = await model.estimateFaces(video, false);
                if (predictions && predictions.length > 0) {
                    const face = toFaceBox(predictions[0]);
                    const distance = estimateDistance(face);
                    updateDistanceStatus(distance);
                    const looking = estimateGazeForward(face);
                    if (!looking) {
                        warningEl.textContent = 'Please face the camera for accurate results.';
                        setReadyState(false);
                    } else {
                        // Clear warning only if distance is also OK
                        const text = distanceStatus.textContent || '';
                        const match = text.match(/([0-9]+\.[0-9]+)/);
                        const dist = match ? parseFloat(match[1]) : NaN;
                        const ok = dist >= idealMin && dist <= idealMax;
                        if (ok) warningEl.textContent = '';
                        setReadyState(ok);
                    }
                } else {
                    warningEl.textContent = 'Face not detected. Make sure your face is visible.';
                    setReadyState(false);
                }
            } catch (_) {}
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    toggleCamBtn?.addEventListener('click', () => {
        if (streamActive) disableCamera(); else enableCamera();
    });

    // Try to auto-start camera on page load
    window.addEventListener('load', () => {
        enableCamera();
    });

    function startTest() {
        // Require distance in range
        const text = distanceStatus.textContent || '';
        const match = text.match(/([0-9]+\.[0-9]+)/);
        const dist = match ? parseFloat(match[1]) : NaN;
        const ready = readyBadge && readyBadge.classList.contains('ready');
        if (!(dist >= idealMin && dist <= idealMax) || !ready) {
            warningEl.textContent = 'Please move farther or closer to the screen to start the test.';
            return;
        }
        testActive = true;
        startBtn.hidden = true;
        retryBtn.hidden = true;
        resultEl.hidden = true;
        sizeStepIndex = 0;
        correctStreak = 0;
        setSize();
        pickDirection();
    }

    function endTest(finalAcuity) {
        testActive = false;
        startBtn.hidden = false;
        retryBtn.hidden = false;
        resultEl.hidden = false;
        resultEl.textContent = `Your vision is approximately ${finalAcuity}.`;
        const history = JSON.parse(localStorage.getItem('visionHistory') || '[]');
        history.push({ when: new Date().toISOString(), acuity: finalAcuity });
        localStorage.setItem('visionHistory', JSON.stringify(history));
    }

    startBtn.addEventListener('click', startTest);
    retryBtn.addEventListener('click', startTest);

    document.querySelectorAll('.vt-controls .btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!testActive) return;
            const answer = btn.getAttribute('data-dir');
            if (answer === direction) {
                correctStreak += 1;
                if (correctStreak >= 3) {
                    correctStreak = 0;
                    if (sizeStepIndex < steps.length - 1) {
                        sizeStepIndex += 1;
                        setSize();
                    } else {
                        endTest(steps[steps.length - 1].acuity);
                        return;
                    }
                }
            } else {
                // One incorrect moves back a step if possible or ends with current
                if (sizeStepIndex > 0) sizeStepIndex -= 1;
                endTest(steps[sizeStepIndex].acuity);
                return;
            }
            pickDirection();
        });
    });
})();

