// Initialize Lucide Icons (guarded: if the CDN fails the page must still load)
if (typeof lucide !== 'undefined') lucide.createIcons();

// Firebase is initialized by firebase-config.js

// UI Elements
const authBtn = document.getElementById('auth-btn');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const errorMsg = document.getElementById('error-msg');

// New Forgot Password Elements
const loginView = document.getElementById('login-view');
const forgotView = document.getElementById('forgot-view');
const forgotLink = document.getElementById('forgot-password-link');
const backToLogin = document.getElementById('back-to-login');
const resetBtn = document.getElementById('reset-btn');
const resetInput = document.getElementById('reset-id');

function showError(message, isSuccess = false) {
     if (!errorMsg) return;
     errorMsg.innerText = message;
     errorMsg.style.display = 'flex';
     errorMsg.style.backgroundColor = isSuccess ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
     errorMsg.style.color = isSuccess ? '#10b981' : '#ef4444';
     errorMsg.style.borderColor = isSuccess ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';
}

function clearError() {
     if (!errorMsg) return;
     errorMsg.innerText = '';
     errorMsg.style.display = 'none';
}

// Toggle Views
forgotLink.addEventListener('click', (e) => {
     e.preventDefault();
     clearError();
     loginView.style.display = 'none';
     forgotView.style.display = 'block';
});

backToLogin.addEventListener('click', (e) => {
     e.preventDefault();
     clearError();
     loginView.style.display = 'block';
     forgotView.style.display = 'none';
});

// Reset Password Logic (Prevents Account Enumeration)
// Login Rate Limiting State
let loginFailedAttempts = 0;
let loginCooldownTimer = null;

resetBtn.addEventListener('click', async () => {
     clearError();
     const id = resetInput.value.trim();

     if (!id) {
          showError("Please enter your email address.");
          return;
     }

     try {
          resetBtn.classList.add('loading');
          resetBtn.disabled = true;

          // Email-only reset. The old phone→email lookup queried the users collection
          // anonymously, which required public list access — an enumeration/privacy
          // hole the locked-down rules close.
          if (id.includes('@')) {
               try {
                    await auth.sendPasswordResetEmail(id);
               } catch (err) {
                    // Suppress user-not-found to prevent account enumeration
                    if (err.code !== 'auth/user-not-found') throw err;
               }
          }

          // Generic success message to protect user privacy
          showError(`If an account exists for "${id}", a password reset link has been sent. Please check your inbox and spam folder.`, true);
          resetInput.value = '';

          setTimeout(() => {
               loginView.style.display = 'block';
               forgotView.style.display = 'none';
               clearError();
          }, 8000);

     } catch (error) {
          console.error("Reset Error:", error);
          showError("If an account exists, a password reset link has been sent.");
     } finally {
          resetBtn.classList.remove('loading');
          resetBtn.disabled = false;
     }
});

// Auth Logic with Rate-Limiting & Rapid-Click Protection
async function handleLogin() {
     clearError();

     if (loginFailedAttempts >= 5) {
          showError("Too many failed attempts. Please wait 30 seconds before trying again.");
          return;
     }

     const email = emailInput.value.trim();
     const password = passwordInput.value.trim();

     if (!email || !password) {
          showError("Please enter both email and password.");
          return;
     }

     try {
          authBtn.classList.add('loading');
          authBtn.disabled = true;

          const userCredential = await auth.signInWithEmailAndPassword(email, password);
          const user = userCredential.user;

          // Check if email is verified
          if (!user.emailVerified) {
               await auth.signOut();
               showError("Your email address is not verified yet. Please check your inbox and Spam/Junk folder for the verification link before logging in.");
               authBtn.classList.remove('loading');
               authBtn.disabled = false;
               return;
          }

          // Check if disabled in Firestore
          const userDoc = await db.collection('users').doc(user.uid).get();
          if (userDoc.exists && userDoc.data().disabled === true) {
               await auth.signOut();
               showError("This account has been disabled by an administrator.");
               authBtn.classList.remove('loading');
               authBtn.disabled = false;
               return;
          }

          // Reset rate-limiting counter on success
          loginFailedAttempts = 0;

          // Success redirect
          window.location.href = "dashboard/index.html";

     } catch (error) {
          console.error("Login failed:", error);
          loginFailedAttempts++;

          let msg = "Something went wrong. Please try again.";

          switch (error.code) {
               case 'auth/user-not-found':
               case 'auth/wrong-password':
               case 'auth/invalid-credential':
                    msg = "Incorrect email or password.";
                    break;
               case 'auth/invalid-email':
                    msg = "The email address is not valid.";
                    break;
               case 'auth/too-many-requests':
                    msg = "Too many failed attempts. Try again later.";
                    break;
               case 'auth/user-disabled':
                    msg = "This account has been disabled.";
                    break;
               case 'auth/network-request-failed':
                    msg = "Network error. Check your connection.";
                    break;
               default:
                    msg = error.message ? error.message.replace("Firebase: ", "").split(" (")[0] : "Login failed. Please check your credentials.";
                    if (msg === "Error" || !msg) msg = "Login failed. Please check your credentials.";
          }

          if (loginFailedAttempts >= 3) {
               msg += ` (Attempt ${loginFailedAttempts}/5)`;
          }

          showError(msg);

          if (loginFailedAttempts >= 5) {
               authBtn.disabled = true;
               setTimeout(() => {
                    loginFailedAttempts = 0;
                    authBtn.disabled = false;
                    clearError();
               }, 30000);
          } else {
               authBtn.classList.remove('loading');
               authBtn.disabled = false;
          }
     }
}

const loginForm = document.getElementById('login-form');
if (loginForm) {
     loginForm.addEventListener('submit', (e) => {
          e.preventDefault();
          handleLogin();
     });
}
// NOTE: no click handler on #auth-btn — it is type="submit", so the form's submit
// event already covers both clicks and Enter. A separate click listener fired
// handleLogin() twice per click (double auth calls, double rate-limit counting).

// Password Visibility Toggle Listener
document.querySelectorAll('.toggle-password').forEach(button => {
     button.addEventListener('click', () => {
          const targetId = button.getAttribute('data-target');
          const input = document.getElementById(targetId);
          if (!input) return;
          const isPassword = input.getAttribute('type') === 'password';
          input.setAttribute('type', isPassword ? 'text' : 'password');
          button.innerHTML = `<i data-lucide="${isPassword ? 'eye-off' : 'eye'}" style="width: 18px; height: 18px;"></i>`;
          lucide.createIcons();
     });
});

// Auto-redirect if already logged in
auth.onAuthStateChanged(user => {
     if (user) {
          window.location.href = "dashboard/index.html";
     }
});

// --- Real-time Weather Background Sync ---
let alertThresholdVal = 50.0;
let currentRainRateVal = 0.0;
let currentWaterVal = -1.0;
let currentCloudCoverVal = 0.0;
let currentLightVal = -1.0;

function syncWeatherBackground() {
     // No splash on auth pages; apply the persisted/time-of-day background
     // immediately (not the sensor-driven one, which would flash the daytime
     // default before telemetry arrives).
     if (typeof updateBackgroundByTime === 'function') updateBackgroundByTime();

     const handleConfig = (data) => {
          if (data && data.alertThreshold) {
               alertThresholdVal = parseFloat(data.alertThreshold) || 50.0;
          }
          updateWeatherBackground();
     };

     const handleCurrent = (data) => {
          if (data) {
               const light = data.lightLevel !== undefined ? parseFloat(data.lightLevel) : (data.light !== undefined ? parseFloat(data.light) : -1.0);
               let cc = data.cloudCover !== undefined ? parseFloat(data.cloudCover) : 0.0;
               if ((data.cloudCover === undefined || cc === 0) && light >= 0) {
                    cc = (1.0 - Math.min(1.0, light / 65000.0)) * 100.0;
               }
               currentRainRateVal = data.rainRate !== undefined ? parseFloat(data.rainRate) : 0.0;
               currentWaterVal = data.waterLevel !== undefined ? parseFloat(data.waterLevel) : -1.0;
               currentLightVal = light;
               currentCloudCoverVal = cc;
          }
          updateWeatherBackground();
     };

     // 1. Get Config from Firestore (single live source)
     db.collection('weather').doc('config').onSnapshot(doc => {
          if (doc.exists) handleConfig(doc.data());
     });

     // 2. Get live telemetry (Current Rain & Water Level & Cloud Cover) from Firestore
     db.collection('weather').doc('current').onSnapshot(doc => {
          if (doc.exists) {
               handleCurrent(doc.data());
          } else {
               updateWeatherBackground();
          }
     }, () => {
          updateWeatherBackground();
     });
}

function updateWeatherBackground() {
     let weatherType = "sunny";

     if (currentRainRateVal >= 50.0) {
          weatherType = "stormy";
     } else if (currentRainRateVal > 0.0) {
          weatherType = "rainy";
     } else {
          const hour = new Date().getHours();
          const isDaytime = hour >= 5 && hour < 18; // 5:00 AM to 6:00 PM

          if (hour >= 18 || hour < 5) {
               weatherType = 'night';
          } else if (isDaytime && currentLightVal >= 0 && currentLightVal < 6000) {
               weatherType = 'cloudy';
          } else {
               weatherType = 'sunny';
          }
     }

     if (typeof setWeatherBackground === 'function') {
          setWeatherBackground(weatherType);
     }
}

// Initialize weather background
syncWeatherBackground();
if (typeof updateBackgroundByTime === 'function') {
     updateBackgroundByTime();
}

// Register PWA Service Worker on Login Page
if ('serviceWorker' in navigator) {
     window.addEventListener('load', () => {
          navigator.serviceWorker.register('./service-worker.js')
               .then(reg => console.log('[PWA] Service Worker registered:', reg.scope))
               .catch(err => console.warn('[PWA] Service Worker registration note:', err));
     });
}


