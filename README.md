Sinachie - Facial Attendance PWA

Sinachie is a serverless, Progressive Web App (PWA) designed for enterprise-grade facial attendance tracking. It runs entirely in the browser using AI for face detection, includes anti-spoofing (liveness) detection via blink tracking, and uses Supabase for secure authentication and cloud database storage.

🌟 Features

· Real-time Face Recognition: Uses face-api.js to detect and match faces directly in the browser (no heavy backend server required).
· Liveness Detection (Anti-Spoofing): Requires the user to blink before checking in, preventing users from using a printed photo to fake attendance.
· Secure Authentication: Users must log in via Supabase Auth (Email/Password) before registering or checking in.
· Cloud Database: Saves face descriptors (128-number mathematical arrays, not photos) and attendance logs securely to Supabase (PostgreSQL).
· Installable PWA: Can be installed directly to the home screen of Android or iOS devices.
· 100% Free Hosting: Designed to be hosted for free on Cloudflare Pages.

🛠️ Tech Stack

· Frontend: HTML5, Vanilla JavaScript
· AI/ML: face-api.js (TensorFlow.js)
· Authentication & Database: Supabase (PostgreSQL)
· Hosting: Cloudflare Pages

## 📄 Copyright & License

**Copyright (c) 2026 Sinachie. All Rights Reserved.**

This software and its source code are the exclusive property of Sinachie. Unauthorized copying, modification, distribution, or use of this software, via any medium, is strictly prohibited without the express written permission of the author.