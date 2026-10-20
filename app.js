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
const departmentSelect = document.getElementById('departmentSelect');
const adminDashboard = document.getElementById('adminDashboard');
const logsTableBody = document.getElementById('logsTableBody');

const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let labeledDescriptors = [];
let currentUser = null;
let faceMatcher = null;
let isLiveLoopRunning = false;
let isProcessing = false;

const DEFAULT_COMPANY_ID = '11111111-1111-1111-1111-111111111111'; // From SQL script

// --- AUTHENTICATION & SETUP ---
_supabase.auth.onAuthStateChange((event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    adminDashboard.style.display = 'block'; // Show dashboard on login
    statusEl.textContent = `Connecting to camera...`;
    loadDepartments();
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

// --- LOAD DATA ---
async function loadDepartments() {
  const { data, error } = await _supabase.from('departments').select('*');
  if (!error && data) {
    departmentSelect.innerHTML = '<option value="">Select Department...</option>';
    data.forEach(dept => {
      departmentSelect.innerHTML += `<option value="${dept.id}">${dept.name}</option>`;
    });
  }
}

async function loadUsersFromSupabase() {
  const { data, error } = await _supabase.from('users').select('name, department_id, face_descriptor');
  if (error) {
    statusEl.textContent = 'DB Error: ' + error.message;
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

// --- CAMERA & AI ---
async function startCameraAndModels() {
  try {
    statusEl.textContent = 'Loading AI models...';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
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
    if (!isProcessing) statusEl.textContent = 'Face detected. Ready.';
  } else {
    registerBtn.disabled = true;
    recognizeBtn.disabled = true;
    if (!isProcessing) statusEl.textContent = 'Align your face in the camera.';
  }

  setTimeout(() => requestAnimationFrame(detectFacesLoop), 100);
}

// --- REGISTER (With Department) ---
registerBtn.onclick = async () => {
  const name = document.getElementById('nameInput').value.trim();
  const deptId = departmentSelect.value;
  const pin = document.getElementById('pinInput').value.trim();

  if (!name) return alert('Please enter a name.');
  if (!deptId) return alert('Please select a department.');
  if (pin.length !== 4) return alert('Please enter a 4-digit PIN.');

  isProcessing = true;
  registerBtn.disabled = true;
  statusEl.textContent = 'Capturing face...';

  const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                  .withFaceLandmarks()
                                  .withFaceDescriptor();

  if (!detection) {
    statusEl.textContent = 'Failed to capture. Align face and try again.';
    registerBtn.disabled = false;
    isProcessing = false;
    return;
  }

  statusEl.textContent = 'Saving to database...';
  const { error } = await _supabase.from('users').insert({
    company_id: DEFAULT_COMPANY_ID,
    department_id: deptId,
    name: name,
    face_descriptor: Array.from(detection.descriptor)
    // You can add the PIN to the DB schema if you want 2FA later
  });

  if (error) {
    statusEl.textContent = `DB Error: ${error.message}`;
  } else {
    statusEl.textContent = `✅ Successfully registered ${name}!`;
    document.getElementById('nameInput').value = '';
    document.getElementById('pinInput').value = '';
    departmentSelect.value = '';
    await loadUsersFromSupabase(); 
  }
  registerBtn.disabled = false;
  isProcessing = false;
};

// --- RECOGNIZE & CHECK IN (Saving Department) ---
recognizeBtn.onclick = async () => {
  if (labeledDescriptors.length === 0) return alert('No faces registered yet.');
  
  isProcessing = true;
  let blinkDetected = false;
  let closedFrames = 0;
  let openFrames = 0;

  statusEl.textContent = '👁️ Please blink to verify liveness...';

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

    if (ear < 0.24) closedFrames++; else openFrames++;

    if (closedFrames >= 1 && openFrames >= 2) {
      blinkDetected = true;
      clearInterval(checkInterval);
      
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

      if (bestMatch.label === 'unknown') {
        statusEl.textContent = '❌ Unknown face. Please register.';
        isProcessing = false;
      } else {
        // Find the department name for the log
        const matchedUser = labeledDescriptors.find(u => u.name === bestMatch.label);
        const deptText = departmentSelect.options[departmentSelect.selectedIndex]?.text || 'General';

        const { error } = await _supabase.from('attendance').insert({
          company_id: DEFAULT_COMPANY_ID,
          user_id: currentUser.id,
          user_name: bestMatch.label,
          department_name: deptText,
          check_in_time: new Date().toISOString()
        });

        if (error) {
          statusEl.textContent = `✅ ${bestMatch.label} matched, but DB error: ${error.message}`;
        } else {
          statusEl.textContent = `✅ ${bestMatch.label} checked in!`;
          fetchAttendanceLogs(); // Auto-refresh dashboard
        }
        isProcessing = false;
      }
    }
  }, 150);

  setTimeout(() => {
    if (!blinkDetected) {
      clearInterval(checkInterval);
      statusEl.textContent = '❌ Liveness timeout. Try again.';
      isProcessing = false;
    }
  }, 10000);
};

// --- ADMIN DASHBOARD LOGS ---
document.getElementById('refreshLogsBtn').onclick = fetchAttendanceLogs;

async function fetchAttendanceLogs() {
  logsTableBody.innerHTML = '<tr><td colspan="3">Loading logs...</td></tr>';
  
  const { data, error } = await _supabase
    .from('attendance')
    .select('user_name, department_name, check_in_time')
    .order('check_in_time', { ascending: false })
    .limit(50);

  if (error) {
    logsTableBody.innerHTML = `<tr><td colspan="3" style="color:red;">Error: ${error.message}</td></tr>`;
    return;
  }

  if (data.length === 0) {
    logsTableBody.innerHTML = '<tr><td colspan="3">No check-ins recorded.</td></tr>';
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
