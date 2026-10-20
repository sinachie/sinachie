// ==========================================
// SINACHIE FACIAL ATTENDANCE - CORE LOGIC
// ==========================================

const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

// SUPABASE CREDENTIALS
const SUPABASE_URL = 'https://aoqnbjdlhrlvowgomyab.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GxpcijTSf1zXIyzySE7sgg_lBvcL4E_';

// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const authSection = document.getElementById('authSection');
const appContent = document.getElementById('appContent');
const registerBtn = document.getElementById('registerBtn');
const recognizeBtn = document.getElementById('recognizeBtn');
const authStatus = document.getElementById('authStatus');
const departmentInput = document.getElementById('departmentInput');
const adminDashboard = document.getElementById('adminDashboard');
const logsTableBody = document.getElementById('logsTableBody');

// Supabase Initialization
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Global State
let labeledDescriptors = [];
let currentUser = null;
let faceMatcher = null;
let isLiveLoopRunning = false;
let isProcessing = false;

// Default Company ID (From your SQL setup script)
const DEFAULT_COMPANY_ID = '11111111-1111-1111-1111-111111111111'; 

// ==========================================
// AUTHENTICATION & SETUP
// ==========================================
_supabase.auth.onAuthStateChange((event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    adminDashboard.style.display = 'block'; 
    statusEl.textContent = `Connecting to camera...`;
    loadUsersFromSupabase();
  } else {
    currentUser = null;
    authSection.style.display = 'block';
    appContent.style.display = 'none';
    adminDashboard.style.display = 'none';
    labeledDescriptors = [];
    if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
  }
});

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  authStatus.textContent = 'Authenticating...';
  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) authStatus.textContent = `Error: ${error.message}`;
  else authStatus.textContent = '';
};

document.getElementById('signupBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  authStatus.textContent = 'Creating account...';
  const { error } = await _supabase.auth.signUp({ email, password });
  if (error) authStatus.textContent = `Error: ${error.message}`;
  else authStatus.textContent = 'Check your email to confirm, then login.';
};

document.getElementById('logoutBtn').onclick = async () => {
  await _supabase.auth.signOut();
};

// ==========================================
// DATA LOADING & CAMERA INIT
// ==========================================
async function loadUsersFromSupabase() {
  const { data, error } = await _supabase.from('users').select('name, department_id, face_descriptor');
  if (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
    return;
  }
  
  labeledDescriptors = data.map(user => ({
    name: user.name,
    department_id: user.department_id,
    descriptor: new Float32Array(user.face_descriptor)
  }));
  
  if (labeledDescriptors.length > 0) {
    faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
  }
  
  if (!isLiveLoopRunning) {
    startCameraAndModels();
  }
}

async function startCameraAndModels() {
  try {
    statusEl.textContent = 'Loading AI models...';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    statusEl.textContent = 'Starting camera...';
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } 
    });
    
    video.srcObject = stream;
    video.onloadedmetadata = async () => {
      await video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      isLiveLoopRunning = true;
      detectFacesLoop();
    };
  } catch (error) {
    statusEl.innerHTML = `<span style="color:red;">Startup Error: ${error.message}</span>`;
  }
}

// ==========================================
// REAL-TIME TRACKING LOOP
// ==========================================
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
    
    if (!isProcessing) statusEl.innerHTML = `<span style="color:#4caf50;">Face detected. Ready.</span>`;
  } else {
    registerBtn.disabled = true;
    recognizeBtn.disabled = true;
    if (!isProcessing) statusEl.innerHTML = `Align your face in the camera.`;
  }

  setTimeout(() => requestAnimationFrame(detectFacesLoop), 100);
}

// ==========================================
// REGISTER NEW EMPLOYEE (Free-Text Department)
// ==========================================
registerBtn.onclick = async () => {
  const name = document.getElementById('nameInput').value.trim();
  const deptName = departmentInput.value.trim();
  const pin = document.getElementById('pinInput').value.trim();

  if (!name) return alert('Please enter a full name.');
  if (!deptName) return alert('Please type a department name.');
  if (pin.length !== 4) return alert('Please enter a 4-digit PIN.');

  isProcessing = true;
  registerBtn.disabled = true;
  statusEl.textContent = 'Capturing face...';

  const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                  .withFaceLandmarks()
                                  .withFaceDescriptor();

  if (!detection) {
    statusEl.innerHTML = '<span style="color:red;">Failed to capture. Ensure good lighting and hold still.</span>';
    registerBtn.disabled = false;
    isProcessing = false;
    return;
  }

  statusEl.textContent = 'Saving to database...';
  
  // Generate a unique ID for the new department typed by the user
  const newDeptId = crypto.randomUUID(); 

  // Insert the department into the DB
  await _supabase.from('departments').insert({
    id: newDeptId,
    company_id: DEFAULT_COMPANY_ID,
    name: deptName
  });

  // Insert the new user with their face descriptor
  const { error } = await _supabase.from('users').insert({
    company_id: DEFAULT_COMPANY_ID,
    department_id: newDeptId,
    name: name,
    face_descriptor: Array.from(detection.descriptor)
  });

  if (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
  } else {
    statusEl.innerHTML = `<span style="color:#4caf50;">✅ Successfully registered ${name}!</span>`;
    document.getElementById('nameInput').value = '';
    document.getElementById('pinInput').value = '';
    departmentInput.value = '';
    await loadUsersFromSupabase(); 
  }
  
  registerBtn.disabled = false;
  isProcessing = false;
};

// ==========================================
// RECOGNIZE & LIVENESS CHECK
// ==========================================
recognizeBtn.onclick = async () => {
  if (labeledDescriptors.length === 0) return alert('No employees registered yet.');
  
  isProcessing = true;
  let blinkDetected = false;
  let closedFrames = 0;
  let openFrames = 0;

  statusEl.innerHTML = '👁️ Please blink your eyes slowly to verify liveness...';

  const checkInterval = setInterval(async () => {
    if (blinkDetected) return;

    const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                    .withFaceLandmarks()
                                    .withFaceDescriptor();

    if (!detection) return;

    const leftEye = detection.landmarks.getLeftEye();
    const ear = (Math.hypot(leftEye[1].x - leftEye[5].x, leftEye[1].y - leftEye[5].y) + 
                 Math.hypot(leftEye[2].x - leftEye[4].x, leftEye[2].y - leftEye[4].y)) / 
                 (2.0 * Math.hypot(leftEye[0].x - leftEye[3].x, leftEye[0].y - leftEye[3].y));

    if (ear < 0.24) closedFrames++; 
    else openFrames++;

    // If the user closed their eyes and then opened them
    if (closedFrames >= 1 && openFrames >= 2 && !blinkDetected) {
      blinkDetected = true;
      clearInterval(checkInterval);
      
      statusEl.innerHTML = 'Liveness confirmed! Matching identity...';
      
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

      if (bestMatch.label === 'unknown') {
        statusEl.innerHTML = '<span style="color:red;">❌ Unknown face. Please register first.</span>';
        isProcessing = false;
      } else {
        // Log attendance to the database
        const typedDept = departmentInput.value.trim() || 'General';

        const { error } = await _supabase.from('attendance').insert({
          company_id: DEFAULT_COMPANY_ID,
          user_id: currentUser.id,
          user_name: bestMatch.label,
          department_name: typedDept,
          check_in_time: new Date().toISOString()
        });

        if (error) {
          statusEl.innerHTML = `<span style="color:red;">✅ ${bestMatch.label} matched, but DB error: ${error.message}</span>`;
        } else {
          statusEl.innerHTML = `<span style="color:#4caf50;">✅ ${bestMatch.label} checked in successfully!</span>`;
          fetchAttendanceLogs(); // Auto-refresh dashboard
        }
        isProcessing = false;
      }
    }
  }, 150);

  // Timeout after 10 seconds if no blink is detected
  setTimeout(() => {
    if (!blinkDetected) {
      clearInterval(checkInterval);
      statusEl.innerHTML = '<span style="color:red;">❌ Liveness timeout. Click again and blink clearly.</span>';
      isProcessing = false;
    }
  }, 10000);
};

// ==========================================
// ADMIN DASHBOARD LOGS
// ==========================================
document.getElementById('refreshLogsBtn').onclick = fetchAttendanceLogs;

async function fetchAttendanceLogs() {
  logsTableBody.innerHTML = '<tr><td colspan="3">Loading logs...</td></tr>';
  
  const { data, error } = await _supabase
    .from('attendance')
    .select('user_name, department_name, check_in_time')
    .order('check_in_time', { ascending: false })
    .limit(50); // Show last 50 check-ins

  if (error) {
    logsTableBody.innerHTML = `<tr><td colspan="3" style="color:red;">Error: ${error.message}</td></tr>`;
    return;
  }

  if (data.length === 0) {
    logsTableBody.innerHTML = '<tr><td colspan="3">No check-ins recorded yet.</td></tr>';
    return;
  }

  logsTableBody.innerHTML = '';
  data.forEach(log => {
    const date = new Date(log.check_in_time).toLocaleString();
    logsTableBody.innerHTML += `
      <tr style="border-bottom: 1px solid #333;">
        <td style="padding: 8px;">${log.user_name}</td>
        <td style="padding: 8px;">${log.department_name}</td>
        <td style="padding: 8px;">${date}</td>
      </tr>
    `;
  });
}