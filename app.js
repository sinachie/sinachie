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

// --- AUTHENTICATION LOGIC ---
_supabase.auth.onAuthStateChange((event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    statusEl.textContent = `Logged in. Connecting to camera...`;
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
    statusEl.textContent = 'DB Error: ' + error.message;
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
    statusEl.textContent = 'Loading AI models (please wait)...';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    statusEl.textContent = 'Models loaded. Starting camera...';
    // Request camera
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } 
    });
    
    video.srcObject = stream;
    
    // Force video to play on mobile browsers
    video.onloadedmetadata = async () => {
      try {
        await video.play();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        if (!isLiveLoopRunning) {
          isLiveLoopRunning = true;
          detectFacesLoop();
        }
      } catch (err) {
        statusEl.innerHTML = `<span style="color:red;">Video play error: ${err.message}</span>`;
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
    statusEl.textContent = 'Face detected. Ready.';
  } else {
    registerBtn.disabled = true;
    recognizeBtn.disabled = true;
    statusEl.textContent = 'Align your face in the camera.';
  }

  setTimeout(() => requestAnimationFrame(detectFacesLoop), 100);
}

// --- REGISTER FACE ---
registerBtn.onclick = async () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return alert('Please enter a name first.');

  registerBtn.disabled = true;
  statusEl.textContent = 'Capturing face...';

  const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                  .withFaceLandmarks()
                                  .withFaceDescriptor();

  if (!detection) {
    statusEl.textContent = 'Failed to capture. Please try again.';
    registerBtn.disabled = false;
    return;
  }

  const { error } = await _supabase.from('users').insert({
    name: name,
    face_descriptor: Array.from(detection.descriptor)
  });

  if (error) {
    statusEl.textContent = 'DB Error: ' + error.message;
  } else {
    statusEl.textContent = `✅ Successfully registered ${name}`;
    document.getElementById('nameInput').value = '';
    await loadUsersFromSupabase();
  }
  registerBtn.disabled = false;
};

// --- RECOGNIZE & LIVENESS CHECK ---
recognizeBtn.onclick = async () => {
  if (labeledDescriptors.length === 0) return alert('No faces registered yet.');
  
  statusEl.textContent = 'Please blink your eyes to verify liveness...';
  let blinkDetected = false;
  let earHistory = [];

  const checkInterval = setInterval(async () => {
    const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                    .withFaceLandmarks()
                                    .withFaceDescriptor();

    if (!detection) return;

    const leftEye = detection.landmarks.getLeftEye();
    const ear = (Math.hypot(leftEye[1].x - leftEye[5].x, leftEye[1].y - leftEye[5].y) + 
                 Math.hypot(leftEye[2].x - leftEye[4].x, leftEye[2].y - leftEye[4].y)) / 
                 (2.0 * Math.hypot(leftEye[0].x - leftEye[3].x, leftEye[0].y - leftEye[3].y));

    earHistory.push(ear);

    if (earHistory.length > 2 && earHistory[earHistory.length - 2] < 0.22 && ear > 0.25) {
      blinkDetected = true;
      clearInterval(checkInterval);
      statusEl.textContent = 'Liveness confirmed! Matching identity...';
      
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

      if (bestMatch.label === 'unknown') {
        statusEl.textContent = '❌ Unknown face. Please register.';
      } else {
        const { error } = await _supabase.from('attendance').insert({
          user_id: currentUser.id,
          user_name: bestMatch.label,
          check_in_time: new Date().toISOString()
        });

        if (error) {
          statusEl.textContent = `✅ ${bestMatch.label} matched, but DB error: ${error.message}`;
        } else {
          statusEl.textContent = `✅ ${bestMatch.label} checked in successfully!`;
        }
      }
    }
  }, 200);

  setTimeout(() => {
    if (!blinkDetected) {
      clearInterval(checkInterval);
      statusEl.textContent = '❌ Liveness timeout. Please click again and blink clearly.';
    }
  }, 8000);
};