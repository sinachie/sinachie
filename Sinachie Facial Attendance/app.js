const MODEL_URL = './models';
const SUPABASE_URL = 'https://aoqnbjdlhrlvowgomyab.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GxpcijTSf1zXIyzySE7sgg_lBvcL4E_';

// DOM Elements
const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const authSection = document.getElementById('authSection');
const appContent = document.getElementById('appContent');
const authStatus = document.getElementById('authStatus');

// Supabase
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let labeledDescriptors = [];
let currentUser = null;

// --- 1. Auth State Listener ---
_supabase.auth.onAuthStateChange((event, session) => {
  if (session) {
    currentUser = session.user;
    authSection.style.display = 'none';
    appContent.style.display = 'block';
    authStatus.textContent = '';
    statusEl.textContent = `Logged in as ${currentUser.email}. Loading faces...`;
    loadUsersFromSupabase(); // Reload faces for this user
  } else {
    currentUser = null;
    authSection.style.display = 'block';
    appContent.style.display = 'none';
    labeledDescriptors = []; // Clear local cache
  }
});

// --- 2. Auth Button Handlers ---
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

// --- 3. Load Faces (Now only works when authenticated) ---
async function loadUsersFromSupabase() {
  if (!currentUser) return;
  const { data, error } = await _supabase.from('users').select('name, face_descriptor');
  if (error) {
    console.error(error);
    statusEl.textContent = 'Failed to load faces: ' + error.message;
    return;
  }
  labeledDescriptors = data.map(user => ({
    name: user.name,
    descriptor: new Float32Array(user.face_descriptor)
  }));
  statusEl.textContent = `Ready. ${labeledDescriptors.length} users loaded.`;
}

// --- 4. Register Face (Include user_id) ---
document.getElementById('registerBtn').onclick = async () => {
  if (!currentUser) return alert('Login required.');
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return alert('Enter a name.');

  const detection = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return alert('No face detected.');

  const { error } = await _supabase.from('users').insert({
    name: name,
    face_descriptor: Array.from(detection.descriptor),
    // Note: The 'users' table doesn't have a user_id column in our schema,
    // so we can't link faces to the login account. For a real app, you'd
    // add a user_id column here to separate faces per tenant/user.
  });

  if (error) return alert('DB Error: ' + error.message);

  labeledDescriptors.push({ name, descriptor: detection.descriptor });
  statusEl.textContent = `✅ Registered ${name}`;
  document.getElementById('nameInput').value = '';
};

// --- 5. Recognize & Check-in (Save user_id) ---
document.getElementById('recognizeBtn').onclick = async () => {
  if (!currentUser) return alert('Login required.');
  if (labeledDescriptors.length === 0) return alert('No users registered.');

  statusEl.textContent = 'Blink to verify liveness...';
  let blinkDetected = false;

  const checkInterval = setInterval(async () => {
    const detection = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) return;

    if (detectBlink(detection.landmarks)) {
      blinkDetected = true;
      clearInterval(checkInterval);
      statusEl.textContent = 'Liveness OK. Matching...';

      const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

      if (bestMatch.label === 'unknown') {
        statusEl.textContent = '❌ Unknown face.';
      } else {
        // SAVE ATTENDANCE WITH currentUser.id
        const { error } = await _supabase.from('attendance').insert({
          user_id: currentUser.id,           // <--- REQUIRED for RLS
          user_name: bestMatch.label,
          check_in_time: new Date().toISOString()
        });

        if (error) {
          statusEl.textContent = `✅ ${bestMatch.label} matched, but DB error: ${error.message}`;
        } else {
          statusEl.textContent = `✅ ${bestMatch.label} checked in.`;
        }
      }
    }
  }, 300);

  setTimeout(() => {
    if (!blinkDetected) {
      clearInterval(checkInterval);
      statusEl.textContent = '❌ Liveness timeout.';
    }
  }, 10000);
};

// --- Helpers (EAR/Blink logic from before) ---
// Keep your existing calculateEAR and detectBlink functions here.

// --- Init (No auto-load; auth listener handles it) ---
// --- Init (No auto-load; auth listener handles it) ---
async function init() {
  try {
    statusEl.textContent = 'Loading AI models... Please wait.';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    statusEl.textContent = 'Starting camera...';
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    
    statusEl.textContent = 'Models loaded. Please login.';
  } catch (error) {
    // If anything fails, show it in big red text on your phone
    statusEl.innerHTML = `<strong style="color:red;">Error: ${error.message}</strong>`;
    console.error(error);
  }
}

init();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
