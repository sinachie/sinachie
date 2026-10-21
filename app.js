const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
// SUPABASE CREDENTIALS
const SUPABASE_URL = 'https://aoqnbjdlhrlvowgomyab.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GxpcijTSf1zXIyzySE7sgg_lBvcL4E_';

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const authSection = document.getElementById('authSection');
const appContent = document.getElementById('appContent');
const adminRegistration = document.getElementById('adminRegistration');
const adminDashboard = document.getElementById('adminDashboard');
const logsTableBody = document.getElementById('logsTableBody');

const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let labeledDescriptors = [];
let currentUser = null;
let currentUserRole = 'employee';
let currentCompanyId = null;
let faceMatcher = null;
let isLiveLoopRunning = false;
let isProcessing = false;
let cachedLogs = [];
const SHIFT_START_HOUR = 8; 

// ==========================================
// AUTHENTICATION & SIGNUP LOGIC
// ==========================================
_supabase.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    
    if (!isLiveLoopRunning) startCameraAndModels();

    // Fetch user's role and company_id
    try {
      const { data } = await _supabase.from('users')
        .select('role, company_id')
        .eq('email', currentUser.email)
        .limit(1);

      if (data && data.length > 0) {
        currentUserRole = data[0].role;
        currentCompanyId = data[0].company_id;
      } else {
        // If they just signed up, they have no employee record yet.
        // They are a new admin for a new company.
        currentUserRole = 'admin';
        // Create a new company for them if they don't have one
        const newCompId = crypto.randomUUID();
        await _supabase.from('companies').insert({ id: newCompId, name: currentUser.email.split('@')[1] + ' Corp' });
        currentCompanyId = newCompId;
      }
    } catch (err) {
      console.error(err);
      currentUserRole = 'admin'; 
    }

    // Apply role-based UI
    if (currentUserRole === 'admin') {
      adminRegistration.style.display = 'block';
      adminDashboard.style.display = 'block';
      document.getElementById('pinFallback').style.display = 'block';
    } else {
      adminRegistration.style.display = 'none';
      adminDashboard.style.display = 'none';
    }

    await loadUsersFromSupabase();

  } else {
    currentUser = null;
    authSection.style.display = 'block';
    appContent.style.display = 'none';
    if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
    isLiveLoopRunning = false;
  }
});

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) document.getElementById('authStatus').textContent = `Error: ${error.message}`;
};

// NEW SIGNUP LOGIC WITH COMPANY CODE
document.getElementById('signupBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const companyCode = document.getElementById('companyCodeInput').value.trim();

  if (!email || !password) return document.getElementById('authStatus').textContent = 'Enter email and password.';

  let compId = null;

  if (companyCode) {
    // If they provided a code, find that company
    const { data, error } = await _supabase.from('companies').select('id').eq('join_code', companyCode).single();
    if (error || !data) return document.getElementById('authStatus').textContent = 'Invalid Company Code.';
    compId = data.id;
  }

  // 1. Create auth user
  const { data: authData, error: authError } = await _supabase.auth.signUp({ email, password });
  if (authError) return document.getElementById('authStatus').textContent = `Error: ${authError.message}`;

  // 2. If successful, create their employee profile
  if (authData.user) {
    // If no company code, create a new company for them
    if (!compId) {
      compId = crypto.randomUUID();
      await _supabase.from('companies').insert({ id: compId, name: email.split('@')[1], join_code: crypto.randomUUID().split('-')[0].toUpperCase() });
    }

    // Create the user record in our custom table
    await _supabase.from('users').insert({
      company_id: compId,
      name: email.split('@')[0],
      email: email,
      role: 'admin', // First user is admin
      pin: '0000',
      face_descriptor: [0.0] // Placeholder until they register face
    });

    document.getElementById('authStatus').textContent = 'Account created! Please login (Check email to confirm if enabled).';
    toggleAuthMode(); // Switch back to login
  }
};

document.getElementById('logoutBtn').onclick = async () => {
  await _supabase.auth.signOut();
};

// ==========================================
// DATA & CAMERA (Scoped to Company)
// ==========================================
async function loadUsersFromSupabase() {
  if (!currentCompanyId) return;

  const { data, error } = await _supabase.from('users')
    .select('name, department_id, pin, face_descriptor')
    .eq('company_id', currentCompanyId); // ONLY LOAD THIS COMPANY'S USERS
  
  if (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
    return; 
  }

  if (data) {
    labeledDescriptors = data.map(user => ({
      name: user.name,
      department_id: user.department_id,
      pin: user.pin,
      descriptor: new Float32Array(user.face_descriptor)
    }));
    
    if (labeledDescriptors.length > 0) {
      faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
    }
  }
}

async function startCameraAndModels() {
  try {
    statusEl.textContent = 'Loading AI Models...';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    statusEl.textContent = 'Starting Camera...';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    
    video.srcObject = stream;
    video.onloadedmetadata = async () => {
      await video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      isLiveLoopRunning = true;
      detectFacesLoop();
    };
  } catch (error) {
    statusEl.innerHTML = `<span style="color:red;">Camera Error: ${error.message}</span>`;
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
                                  .withFaceLandmarks().withFaceDescriptor();
  
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (detections) {
    const resizedDet = faceapi.resizeResults(detections, displaySize);
    const box = resizedDet.detection.box;
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    
    document.getElementById('registerBtn').disabled = false;
    document.getElementById('recognizeBtn').disabled = false;
    if (!isProcessing) statusEl.innerHTML = `<span style="color:#4caf50;">Face detected. Ready.</span>`;
  } else {
    document.getElementById('registerBtn').disabled = true;
    document.getElementById('recognizeBtn').disabled = true;
    if (!isProcessing) statusEl.innerHTML = `Align your face in the camera.`;
  }
  setTimeout(() => requestAnimationFrame(detectFacesLoop), 100);
}

// ==========================================
// REGISTER EMPLOYEE (Scoped to Company)
// ==========================================
document.getElementById('registerBtn').onclick = async () => {
  const name = document.getElementById('nameInput').value.trim();
  const email = document.getElementById('emailInput').value.trim();
  const pin = document.getElementById('pinInput').value.trim();
  const deptName = document.getElementById('departmentInput').value.trim();

  if (!name || !email || pin.length !== 4 || !deptName) return alert('Fill all fields & 4-digit PIN.');

  isProcessing = true;
  document.getElementById('registerBtn').disabled = true;
  statusEl.innerHTML = 'Capturing face... Please hold still.';

  let detection = null;
  let attempts = 0;

  while (attempts < 5 && !detection) {
    detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
    if (!detection) { attempts++; await new Promise(r => setTimeout(r, 300)); }
  }

  if (!detection) {
    statusEl.innerHTML = '<span style="color:red;">❌ Failed to capture. Improve lighting.</span>';
    isProcessing = false; document.getElementById('registerBtn').disabled = false; return;
  }

  statusEl.textContent = 'Saving to database...';
  const newDeptId = crypto.randomUUID();

  try {
    await _supabase.from('departments').insert({ id: newDeptId, company_id: currentCompanyId, name: deptName });

    const { error } = await _supabase.from('users').insert({
      company_id: currentCompanyId, // LINK TO COMPANY
      department_id: newDeptId,
      name: name, email: email, pin: pin, face_descriptor: Array.from(detection.descriptor)
    });

    if (error) throw error;

    statusEl.innerHTML = `<span style="color:#4caf50;">✅ Registered ${name}!</span>`;
    document.getElementById('nameInput').value = '';
    document.getElementById('emailInput').value = '';
    document.getElementById('pinInput').value = '';
    document.getElementById('departmentInput').value = '';
    await loadUsersFromSupabase(); 

  } catch (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
  } finally {
    isProcessing = false; document.getElementById('registerBtn').disabled = false;
  }
};

// ==========================================
// ATTENDANCE ENGINE
// ==========================================
async function logAttendance(name) {
  const now = new Date();
  const shiftStart = new Date(); shiftStart.setHours(SHIFT_START_HOUR, 0, 0, 0);
  
  let status = now > shiftStart ? 'Late' : 'On Time';
  let minutesLate = now > shiftStart ? Math.floor((now - shiftStart) / 60000) : 0;

  const typedDept = document.getElementById('departmentInput')?.value.trim() || 'General';
  
  const { error } = await _supabase.from('attendance').insert({
    company_id: currentCompanyId, // LINK TO COMPANY
    user_id: currentUser.id,
    user_name: name,
    department_name: typedDept,
    check_in_time: now.toISOString(),
    status: status,
    minutes_late: minutesLate
  });

  if (error) return `<span style="color:red;">DB Error: ${error.message}</span>`;
  fetchAttendanceLogs(); 
  return `<span style="color:#4caf50;">✅ ${name} checked in (${status})!</span>`;
}

document.getElementById('recognizeBtn').onclick = async () => {
  if (labeledDescriptors.length === 0) return alert('No users registered yet.');
  isProcessing = true;
  let blinkDetected = false;
  let closedFrames = 0;
  let openFrames = 0;

  statusEl.innerHTML = '👁️ Please blink to verify liveness...';

  const checkInterval = setInterval(async () => {
    if (blinkDetected) return;
    try {
      const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
      if (!detection) return;

      const leftEye = detection.landmarks.getLeftEye();
      const ear = (Math.hypot(leftEye[1].x - leftEye[5].x, leftEye[1].y - leftEye[5].y) + Math.hypot(leftEye[2].x - leftEye[4].x, leftEye[2].y - leftEye[4].y)) / (2.0 * Math.hypot(leftEye[0].x - leftEye[3].x, leftEye[0].y - leftEye[3].y));

      if (ear < 0.26) closedFrames++; else openFrames++;

      if (closedFrames >= 1 && openFrames >= 1) {
        blinkDetected = true;
        clearInterval(checkInterval);
        statusEl.innerHTML = 'Liveness confirmed! Matching...';
        
        const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
        if (bestMatch.label === 'unknown') {
          statusEl.innerHTML = '<span style="color:red;">❌ Unknown face.</span>';
          isProcessing = false;
        } else {
          statusEl.innerHTML = await logAttendance(bestMatch.label);
          isProcessing = false;
        }
      }
    } catch (err) { console.error(err); }
  }, 300);

  setTimeout(() => { if (!blinkDetected) { clearInterval(checkInterval); statusEl.innerHTML = '<span style="color:red;">❌ Timeout.</span>'; isProcessing = false; } }, 15000);
};

// ==========================================
// PIN FALLBACK
// ==========================================
document.getElementById('pinCheckInBtn').onclick = async () => {
  const pin = document.getElementById('fallbackPin').value.trim();
  if (pin.length !== 4) return alert('Enter 4-digit PIN.');
  const user = labeledDescriptors.find(u => u.pin === pin);
  if (!user) return alert('Invalid PIN.');

  statusEl.innerHTML = await logAttendance(user.name);
  document.getElementById('fallbackPin').value = '';
};

// ==========================================
// DASHBOARD & CSV EXPORT
// ==========================================
document.getElementById('refreshLogsBtn').onclick = fetchAttendanceLogs;

async function fetchAttendanceLogs() {
  logsTableBody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
  
  const { data, error } = await _supabase.from('attendance')
    .select('user_name, department_name, check_in_time, status')
    .eq('company_id', currentCompanyId) // ONLY SHOW THIS COMPANY'S LOGS
    .order('check_in_time', { ascending: false }).limit(50);

  if (error) return logsTableBody.innerHTML = `<tr><td colspan="4" style="color:red;">${error.message}</td></tr>`;
  if (data.length === 0) return logsTableBody.innerHTML = '<tr><td colspan="4">No records found.</td></tr>';

  cachedLogs = data; 
  logsTableBody.innerHTML = '';
  
  data.forEach(log => {
    const date = new Date(log.check_in_time).toLocaleString();
    const color = log.status === 'Late' ? '#ff9800' : '#4caf50';
    logsTableBody.innerHTML += `
      <tr style="border-bottom: 1px solid #333;">
        <td style="padding: 8px;">${log.user_name}</td>
        <td style="padding: 8px;">${log.department_name}</td>
        <td style="padding: 8px;">${date}</td>
        <td style="padding: 8px; color:${color}; font-weight:bold;">${log.status}</td>
      </tr>
    `;
  });
}

document.getElementById('exportCsvBtn').onclick = () => {
  if (cachedLogs.length === 0) return alert('No data to export.');
  let csvContent = "data:text/csv;charset=utf-8,Name,Department,Date & Time,Status\n";
  cachedLogs.forEach(row => {
    const date = new Date(row.check_in_time).toLocaleString().replace(/,/g, ''); 
    csvContent += `"${row.user_name}","${row.department_name}","${date}","${row.status}"\n`;
  });
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `sinachie_logs_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};