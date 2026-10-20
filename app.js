const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
const SUPABASE_URL = 'https://aoqnbjdlhrlvowgomyab.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GxpcijTSf1zXIyzySE7sgg_lBvcL4E_';

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const authSection = document.getElementById('authSection');
const appContent = document.getElementById('appContent');
const registerBtn = document.getElementById('registerBtn');
const recognizeBtn = document.getElementById('recognizeBtn');
const authStatus = document.getElementById('authStatus');

const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let labeledDescriptors = [];
let currentUser = null;
let faceMatcher = null;
let isLiveLoopRunning = false;
let isProcessing = false; // Prevents button spam

// --- AUTHENTICATION LOGIC ---
_supabase.auth.onAuthStateChange((event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    statusEl.innerHTML = `Logged in. Connecting to camera...`;
    loadUsersFromSupabase();
  } else {
    currentUser = null;
    authSection.style.display = 'block';
    appContent.style.display = 'none';
    labeledDescriptors = [];
    if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
  }
});

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) authStatus.textContent = `Error: ${error.message}`;
};

document.getElementById('signupBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const { error } = await _supabase.auth.signUp({ email, password });
  if (error) authStatus.textContent = `Error: ${error.message}`;
  else authStatus.textContent = 'Check your email to confirm, then login.';
};

document.getElementById('logoutBtn').onclick = async () => {
  await _supabase.auth.signOut();
};

// --- DATABASE & AI INITIALIZATION ---
async function loadUsersFromSupabase() {
  const { data, error } = await _supabase.from('users').select('name, face_descriptor');
  if (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
    return;
  }
  labeledDescriptors = data.map(user => ({
    name: user.name,
    descriptor: new Float32Array(user.face_descriptor)
  }));
  
  if (labeledDescriptors.length > 0) {
    faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
  }
  
  await startCameraAndModels();
}

async function startCameraAndModels() {
  try {
    statusEl.innerHTML = 'Loading AI models...';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    statusEl.innerHTML = 'Starting camera...';
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } 
    });
    
    video.srcObject = stream;
    
    video.onloadedmetadata = async () => {
      await video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      if (!isLiveLoopRunning) {
        isLiveLoopRunning = true;
        detectFacesLoop();
      }
    };
  } catch (error) {
    statusEl.innerHTML = `<span style="color:red;">Startup Error: ${error.message}</span>`;
  }
}

// --- REAL-TIME LIVE TRACKING LOOP ---
async function detectFacesLoop() {
  if (!currentUser || video.paused || video.ended || video.readyState < 2) {
    setTimeout(() => requestAnimationFrame(detectFacesLoop), 500);
    return;
  }

  const displaySize = { width: video.videoWidth, height: video.videoHeight };
  const detections = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                  .withFaceLandmarks()
                                  .withFaceDescriptor();
  
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (detections) {
    const resizedDet = faceapi.resizeResults(detections, displaySize);
    const box = resizedDet.detection.box;
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    
    registerBtn.disabled = false;
    recognizeBtn.disabled = false;
    
    // Only update text if we aren't currently in the middle of a check-in
    if (!isProcessing) {
      statusEl.innerHTML = `<span style="color:#4caf50;">Face detected. Ready.</span>`;
    }
  } else {
    registerBtn.disabled = true;
    recognizeBtn.disabled = true;
    if (!isProcessing) {
      statusEl.innerHTML = `Align your face in the camera.`;
    }
  }

  setTimeout(() => requestAnimationFrame(detectFacesLoop), 100);
}

// --- REGISTER FACE ---
registerBtn.onclick = async () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return alert('Please enter a name first.');

  isProcessing = true;
  registerBtn.disabled = true;
  statusEl.innerHTML = 'Capturing face...';

  const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                  .withFaceLandmarks()
                                  .withFaceDescriptor();

  if (!detection) {
    statusEl.innerHTML = '<span style="color:red;">Failed to capture. Please align your face.</span>';
    registerBtn.disabled = false;
    isProcessing = false;
    return;
  }

  statusEl.innerHTML = 'Saving to database...';
  const { error } = await _supabase.from('users').insert({
    name: name,
    face_descriptor: Array.from(detection.descriptor)
  });

  if (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
  } else {
    statusEl.innerHTML = `<span style="color:#4caf50;">✅ Successfully registered ${name}!</span>`;
    document.getElementById('nameInput').value = '';
    await loadUsersFromSupabase(); // Reload matcher
  }
  
  registerBtn.disabled = false;
  isProcessing = false;
}

// --- RECOGNIZE & LIVENESS CHECK ---
recognizeBtn.onclick = async () => {
  if (labeledDescriptors.length === 0) return alert('No faces registered yet.');
  
  isProcessing = true;
  let blinkDetected = false;
  let openFrames = 0;
  let closedFrames = 0;
  let timeoutReached = false;

  statusEl.innerHTML = '👁️ Please blink your eyes slowly to verify liveness...';

  const checkInterval = setInterval(async () => {
    if (blinkDetected || timeoutReached) return;

    const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                    .withFaceLandmarks()
                                    .withFaceDescriptor();

    if (!detection) return;

    const leftEye = detection.landmarks.getLeftEye();
    const ear = (Math.hypot(leftEye[1].x - leftEye[5].x, leftEye[1].y - leftEye[5].y) + 
                 Math.hypot(leftEye[2].x - leftEye[4].x, leftEye[2].y - leftEye[4].y)) / 
                 (2.0 * Math.hypot(leftEye[0].x - leftEye[3].x, leftEye[0].y - leftEye[3].y));

    // Much more forgiving blink detection logic
    if (ear < 0.24) { 
      closedFrames++;
    } else {
      openFrames++;
    }

    // If we have seen the eyes closed and then open again
    if (closedFrames >= 1 && openFrames >= 2 && !blinkDetected) {
      blinkDetected = true;
      clearInterval(checkInterval);
      statusEl.innerHTML = '✅ Liveness confirmed! Matching identity...';
      
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

      if (bestMatch.label === 'unknown') {
        statusEl.innerHTML = '❌ Unknown face. Please register.';
        isProcessing = false;
      } else {
        const { error } = await _supabase.from('attendance').insert({
          user_id: currentUser.id,
          user_name: bestMatch.label,
          check_in_time: new Date().toISOString()
        });

        if (error) {
          statusEl.innerHTML = `<span style="color:red;">✅ ${bestMatch.label} matched, but DB error: ${error.message}</span>`;
        } else {
          statusEl.innerHTML = `<span style="color:#4caf50;">✅ ${bestMatch.label} checked in successfully!</span>`;
        }
        isProcessing = false;
      }
    }
  }, 150);

  // Timeout after 10 seconds
  setTimeout(() => {
    if (!blinkDetected) {
      clearInterval(checkInterval);
      statusEl.innerHTML = '<span style="color:red;">❌ Liveness timeout. Click again and blink clearly.</span>';
      isProcessing = false;
    }
  }, 10000);
};