// ==========================================
// SINACHIE ENTERPRISE POS - CORE LOGIC (V3)
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
const adminPanel = document.getElementById('adminPanel');
const logsTableBody = document.getElementById('logsTableBody');

// Supabase Initialization
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Global State
let labeledDescriptors = [];
let currentUser = null;
let currentCompanyId = null;
let faceMatcher = null;
let isLiveLoopRunning = false;
let isProcessing = false;
let cachedLogs = []; 

// --- ADMIN TOGGLE LOGIC ---
document.getElementById('toggleAdminBtn').onclick = () => {
  if (adminPanel.style.display === 'none') {
    adminPanel.style.display = 'block';
    document.getElementById('toggleAdminBtn').innerText = '❌ Close Admin Setup';
    fetchAttendanceLogs();
  } else {
    adminPanel.style.display = 'none';
    document.getElementById('toggleAdminBtn').innerText = '⚙️ Open Admin Setup';
  }
};

// ==========================================
// AUTHENTICATION & COMPANY ONBOARDING
// ==========================================
_supabase.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    
    // 1. Start Camera Immediately (Prevents loading hang)
    if (!isLiveLoopRunning) startCameraAndModels();

    try {
      // 2. Fetch user role and company ID
      const { data: userData } = await _supabase.from('users')
        .select('company_id')
        .eq('email', currentUser.email)
        .limit(1);

      if (userData && userData.length > 0) {
        currentCompanyId = userData[0].company_id;
        
        // 3. Fetch company details to display at the top
        const { data: compData } = await _supabase.from('companies')
          .select('name, join_code')
          .eq('id', currentCompanyId)
          .single();
          
        if (compData) {
          document.getElementById('displayCompanyName').innerText = compData.name;
          document.getElementById('displayJoinCode').innerText = compData.join_code || 'N/A';
        }
      } else {
        // Edge case: Auth user exists but no company record. Force setup.
        document.getElementById('authStatus').textContent = 'Please create a company to continue.';
        toggleAuthMode(); 
        await _supabase.auth.signOut(); 
        return;
      }
    } catch (err) { 
      console.error("Setup error:", err); 
    }

    await loadUsersFromSupabase();

  } else {
    // Logged out state
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

document.getElementById('signupBtn').onclick = async () => {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const companyCode = document.getElementById('companyCodeInput').value.trim();
  
  if (!email || !password) return document.getElementById('authStatus').textContent = 'Enter email and password.';

  let compId = null;

  // Check if they are joining an existing company via code
  if (companyCode) {
    const { data } = await _supabase.from('companies').select('id').eq('join_code', companyCode).single();
    if (data) compId = data.id;
    else return document.getElementById('authStatus').textContent = 'Invalid Company Code.';
  }

  const { data: authData, error: authError } = await _supabase.auth.signUp({ email, password });
  if (authError) return document.getElementById('authStatus').textContent = `Error: ${authError.message}`;

  if (authData.user) {
    // If no code provided, create a NEW company
    if (!compId) {
      compId = crypto.randomUUID();
      const newJoinCode = crypto.randomUUID().split('-')[0].toUpperCase(); // Generate unique code
      const companyName = email.split('@')[1] + ' Corp'; // Default name from domain
      
      await _supabase.from('companies').insert({ 
        id: compId, 
        name: companyName, 
        join_code: newJoinCode 
      });
    }
    
    // Create the user record as Admin
    await _supabase.from('users').insert({ 
      company_id: compId, 
      name: email.split('@')[0], 
      email: email, 
      role: 'admin', 
      pin: '0000', 
      face_descriptor: [0.0] 
    });
    
    document.getElementById('authStatus').textContent = 'Account created! Please login.';
    toggleAuthMode();
  }
};

document.getElementById('logoutBtn').onclick = async () => { await _supabase.auth.signOut(); };

// ==========================================
// DATA & CAMERA
// ==========================================
async function loadUsersFromSupabase() {
  if (!currentCompanyId) return;
  
  const { data, error } = await _supabase.from('users')
    .select('name, department_id, pin, shift_start, shift_end, face_descriptor')
    .eq('company_id', currentCompanyId); // Filter by company
    
  if (error) { statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`; return; }

  if (data) {
    labeledDescriptors = data.map(user => ({
      name: user.name, 
      department_id: user.department_id, 
      pin: user.pin, 
      shift_start: user.shift_start,
      shift_end: user.shift_end,
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
                                  .withFaceLandmarks()
                                  .withFaceDescriptor();
  
  const ctx = canvas.getContext('2d'); 
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (detections) {
    const box = faceapi.resizeResults(detections, displaySize).detection.box;
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
// REGISTER NEW EMPLOYEE
// ==========================================
document.getElementById('registerBtn').onclick = async () => {
  const name = document.getElementById('nameInput').value.trim();
  const pin = document.getElementById('pinInput').value.trim();
  const deptName = document.getElementById('departmentInput').value.trim();
  const shiftStart = document.getElementById('shiftStartInput').value;
  const shiftEnd = document.getElementById('shiftEndInput').value;

  if (!name || pin.length !== 4 || !deptName || !shiftStart || !shiftEnd) {
    return alert('Fill all fields & select shifts.');
  }

  isProcessing = true;
  document.getElementById('registerBtn').disabled = true;
  statusEl.innerHTML = 'Capturing face... Please hold still.';

  let detection = null; 
  let attempts = 0;

  while (attempts < 5 && !detection) {
    detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                            .withFaceLandmarks()
                            .withFaceDescriptor();
    if (!detection) { 
      attempts++; 
      await new Promise(r => setTimeout(r, 300)); 
    }
  }

  if (!detection) {
    statusEl.innerHTML = '<span style="color:red;">❌ Failed to capture. Improve lighting.</span>';
    isProcessing = false; 
    document.getElementById('registerBtn').disabled = false; 
    return;
  }

  statusEl.textContent = 'Saving to database...';
  const newDeptId = crypto.randomUUID();

  try {
    await _supabase.from('departments').insert({ 
      id: newDeptId, company_id: currentCompanyId, name: deptName 
    });
    
    const { error } = await _supabase.from('users').insert({
      company_id: currentCompanyId, 
      department_id: newDeptId, 
      name: name, 
      email: "", 
      pin: pin, 
      shift_start: shiftStart, 
      shift_end: shiftEnd,
      face_descriptor: Array.from(detection.descriptor)
    });
    
    if (error) throw error;
    
    statusEl.innerHTML = `<span style="color:#4caf50;">✅ Registered ${name}!</span>`;
    document.getElementById('nameInput').value = '';
    document.getElementById('pinInput').value = '';
    document.getElementById('departmentInput').value = '';
    
    await loadUsersFromSupabase(); 

  } catch (error) {
    statusEl.innerHTML = `<span style="color:red;">DB Error: ${error.message}</span>`;
  } finally {
    isProcessing = false; 
    document.getElementById('registerBtn').disabled = false;
  }
};

// ==========================================
// ATTENDANCE ENGINE (Shift Logic)
// ==========================================
async function logAttendance(user) {
  const now = new Date();
  const shiftTimeStr = user.shift_start || "08:00:00"; 
  const [hours, minutes] = shiftTimeStr.split(':');
  
  const expectedShiftStart = new Date();
  expectedShiftStart.setHours(parseInt(hours), parseInt(minutes), 0, 0);

  let status = 'On Time';
  let minutesLate = 0;

  if (now > expectedShiftStart) {
    minutesLate = Math.floor((now - expectedShiftStart) / 60000);
    if (minutesLate > 10) { // 10-minute grace period
      status = 'Late';
    }
  }

  const typedDept = document.getElementById('departmentInput')?.value.trim() || 'General';
  
  const { error } = await _supabase.from('attendance').insert({
    company_id: currentCompanyId, 
    user_id: currentUser.id, 
    user_name: user.name,
    department_name: typedDept, 
    check_in_time: now.toISOString(), 
    status: status, 
    minutes_late: status === 'Late' ? minutesLate : 0,
    shift_expected: shiftTimeStr
  });

  if (error) return `<span style="color:red;">DB Error: ${error.message}</span>`;
  
  if(adminPanel.style.display !== 'none') fetchAttendanceLogs(); 
  
  const lateMsg = status === 'Late' ? ` - ${minutesLate} mins Late` : '';
  return `<span style="color:${status === 'Late' ? '#ff9800' : '#4caf50'};">✅ ${user.name} checked in (${status}${lateMsg})!</span>`;
}

// ==========================================
// RECOGNIZE & LIVENESS
// ==========================================
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
      const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                      .withFaceLandmarks()
                                      .withFaceDescriptor();
      if (!detection) return;
      
      const leftEye = detection.landmarks.getLeftEye();
      const ear = (Math.hypot(leftEye[1].x - leftEye[5].x, leftEye[1].y - leftEye[5].y) + 
                   Math.hypot(leftEye[2].x - leftEye[4].x, leftEye[2].y - leftEye[4].y)) / 
                   (2.0 * Math.hypot(leftEye[0].x - leftEye[3].x, leftEye[0].y - leftEye[3].y));
                   
      if (ear < 0.26) closedFrames++; 
      else openFrames++;

      if (closedFrames >= 1 && openFrames >= 1) {
        blinkDetected = true; 
        clearInterval(checkInterval); 
        statusEl.innerHTML = 'Liveness confirmed!';
        
        const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
        
        if (bestMatch.label === 'unknown') { 
          statusEl.innerHTML = '<span style="color:red;">❌ Unknown face.</span>'; 
          isProcessing = false; 
        } else { 
          const matchedUser = labeledDescriptors.find(u => u.name === bestMatch.label);
          statusEl.innerHTML = await logAttendance(matchedUser); 
          isProcessing = false; 
        }
      }
    } catch (err) { console.error(err); }
  }, 300);

  setTimeout(() => { 
    if (!blinkDetected) { 
      clearInterval(checkInterval); 
      statusEl.innerHTML = '<span style="color:red;">❌ Timeout.</span>'; 
      isProcessing = false; 
    } 
  }, 15000);
};

// ==========================================
// PIN FALLBACK
// ==========================================
document.getElementById('pinCheckInBtn').onclick = async () => {
  const pin = document.getElementById('fallbackPin').value.trim();
  if (pin.length !== 4) return alert('Enter 4-digit PIN.');
  
  const user = labeledDescriptors.find(u => u.pin === pin);
  if (!user) return alert('Invalid PIN.');
  
  statusEl.innerHTML = await logAttendance(user);
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
    .eq('company_id', currentCompanyId)
    .order('check_in_time', { ascending: false })
    .limit(50);

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