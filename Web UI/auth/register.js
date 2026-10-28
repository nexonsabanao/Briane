// Initialize Lucide Icons (guarded: if the CDN fails the page must still load)
if (typeof lucide !== 'undefined') lucide.createIcons();

// Firebase is initialized by firebase-config.js

// UI Elements
const registerForm = document.getElementById('register-form');
const accountSection = document.getElementById('account-info-section');
const verifyEmailSection = document.getElementById('verify-email-section');
const sendVerificationBtn = document.getElementById('send-verification-btn');
const confirmVerifiedBtn = document.getElementById('confirm-verified-btn');
const registerTitle = document.getElementById('register-title');
const registerDesc = document.getElementById('register-desc');
const errorMsg = document.getElementById('error-msg');
const verifyEmailSentTo = document.getElementById('verify-email-sent-to');

const emailInput = document.getElementById('reg-email');
const passwordInput = document.getElementById('reg-password');
const confirmPasswordInput = document.getElementById('confirm-password');
const termsConsent = document.getElementById('terms-consent');

let registeredUser = null; // Holds the Firebase user object after account creation

// ─── Helpers ────────────────────────────────────────────────────────────────

// The Create Account button stays disabled until the Terms of Service checkbox
// is ticked. Every code path that touches the button's disabled state goes
// through here — otherwise a later error-reset would silently re-enable it.
function syncSubmitState() {
    if (!sendVerificationBtn || !termsConsent) return;
    const unlocked = termsConsent.checked;
    sendVerificationBtn.disabled = !unlocked;
    sendVerificationBtn.setAttribute('aria-disabled', String(!unlocked));
}

function showError(message, isSuccess = false) {
    if (!errorMsg) return;
    errorMsg.innerText = message;
    errorMsg.style.display = 'flex';
    errorMsg.style.backgroundColor = isSuccess ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
    errorMsg.style.color = isSuccess ? '#10b981' : '#ef4444';
    errorMsg.style.borderColor = isSuccess ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';
    // Reset button loading states (re-sync keeps the terms gate intact)
    if (sendVerificationBtn) sendVerificationBtn.classList.remove('loading');
    if (confirmVerifiedBtn) { confirmVerifiedBtn.classList.remove('loading'); confirmVerifiedBtn.disabled = false; }
    syncSubmitState();
}

function clearError() {
    if (!errorMsg) return;
    errorMsg.innerText = '';
    errorMsg.style.display = 'none';
}

// Tick/untick the consent box → enable/disable the Create Account button.
if (termsConsent) {
    termsConsent.addEventListener('change', syncSubmitState);
    syncSubmitState(); // start locked
}

// ─── Step 1: Create Account & Send Email Verification ────────────────────────

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    // Defence in depth: the button is disabled until consent is given, but the
    // form can still be submitted via Enter in a field, so re-check here.
    if (termsConsent && !termsConsent.checked) {
        showError('Please accept the Terms of Service before creating an account.');
        if (termsConsent.focus) termsConsent.focus();
        return;
    }

    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();

    // Validations
    if (!email || !password) {
        showError('Please fill in all fields.');
        return;
    }
    if (password !== confirmPassword) {
        showError('Passwords do not match!');
        return;
    }
    if (password.length < 6) {
        showError('Password must be at least 6 characters.');
        return;
    }

    try {
        sendVerificationBtn.classList.add('loading');
        sendVerificationBtn.disabled = true;

        // Firebase Auth rejects duplicate emails itself (auth/email-already-in-use,
        // handled below) — a Firestore pre-check would only race it.

        // Create Firebase Auth account
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        registeredUser = userCredential.user;

        // 3. Send verification email
        await registeredUser.sendEmailVerification();

        // 4. Create Firestore profile (marked unverified until confirmed)
        await db.collection('users').doc(registeredUser.uid).set({
            email: email,
            role: 'user',
            isVerified: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // 5. Sign out immediately — user must verify email before logging in
        await auth.signOut();

        // 6. Transition UI to step 2
        registerTitle.innerText = 'Verify your email';
        registerDesc.innerText = 'One last step — check your inbox.';
        if (verifyEmailSentTo) {
            verifyEmailSentTo.innerText = `We sent a verification link to ${email}`;
        }
        accountSection.style.display = 'none';
        verifyEmailSection.style.display = 'block';
        sendVerificationBtn.style.display = 'none';
        confirmVerifiedBtn.style.display = 'flex'; // must stay flex — 'block' would drop .btn-submit's align/justify centering
        lucide.createIcons();

    } catch (error) {
        console.error('Registration Error:', error);
        let msg = 'Registration failed. Please try again.';

        switch (error.code) {
            case 'auth/email-already-in-use': msg = 'This email is already registered. Try logging in instead.'; break;
            case 'auth/invalid-email': msg = 'The email address is not valid.'; break;
            case 'auth/weak-password': msg = 'The password is too weak. Use at least 6 characters.'; break;
            case 'auth/network-request-failed': msg = 'Network error. Please check your internet connection.'; break;
            case 'auth/too-many-requests': msg = 'Too many attempts. Please wait a moment and try again.'; break;
            default:
                msg = error.message ? error.message.replace('Firebase: ', '').split(' (')[0] : 'An unexpected error occurred.';
        }

        showError(msg);
    }
});

// ─── Step 2: Confirm Email Was Verified ─────────────────────────────────────

confirmVerifiedBtn.addEventListener('click', async () => {
    clearError();

    try {
        confirmVerifiedBtn.classList.add('loading');
        confirmVerifiedBtn.disabled = true;

        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();

        if (!email || !password) {
            showError('Session lost. Please go back and register again.');
            confirmVerifiedBtn.classList.remove('loading');
            confirmVerifiedBtn.disabled = false;
            return;
        }

        // Re-sign in to get a fresh token and check emailVerified
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        await userCredential.user.reload(); // Ensure fresh data

        if (!userCredential.user.emailVerified) {
            await auth.signOut();
            showError('Your email has not been verified yet. Please click the link in the email we sent you. Don\'t forget to check your Spam or Junk folder!');
            confirmVerifiedBtn.classList.remove('loading');
            confirmVerifiedBtn.disabled = false;
            return;
        }

        // Update Firestore profile to verified
        await db.collection('users').doc(userCredential.user.uid).update({
            isVerified: true
        });

        // Redirect to dashboard
        window.location.href = '../dashboard/index.html';

    } catch (error) {
        console.error('Verification Confirm Error:', error);
        let msg = 'Could not confirm verification.';

        switch (error.code) {
            case 'auth/wrong-password':
            case 'auth/invalid-credential': msg = 'Incorrect password. Please try again.'; break;
            case 'auth/user-not-found': msg = 'Account not found. Please register again.'; break;
            case 'auth/too-many-requests': msg = 'Too many attempts. Please wait and try again.'; break;
            case 'auth/network-request-failed': msg = 'Network error. Please check your connection.'; break;
            default:
                msg = error.message ? error.message.replace('Firebase: ', '').split(' (')[0] : 'An unexpected error occurred.';
        }

        showError(msg);
    }
});

// ─── Resend Verification Email ───────────────────────────────────────────────

const resendEmailBtn = document.getElementById('resend-email-btn');
let resendCooldown = 0;

if (resendEmailBtn) {
    resendEmailBtn.addEventListener('click', async () => {
        if (resendCooldown > 0) return;
        clearError();

        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();

        if (!email || !password) {
            showError('Cannot resend — session information is missing. Please register again.');
            return;
        }

        try {
            resendEmailBtn.style.opacity = '0.5';
            resendEmailBtn.style.cursor = 'not-allowed';
            resendEmailBtn.innerText = 'Sending...';

            // Sign in temporarily to send verification
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            await userCredential.user.sendEmailVerification();
            await auth.signOut();

            showError('Verification email re-sent! Check your inbox and Spam/Junk folder.', true);

            // 60-second cooldown
            resendCooldown = 60;
            const timer = setInterval(() => {
                resendCooldown--;
                if (resendCooldown <= 0) {
                    clearInterval(timer);
                    resendEmailBtn.innerText = "Didn't receive it? Resend Email";
                    resendEmailBtn.style.opacity = '1';
                    resendEmailBtn.style.cursor = 'pointer';
                } else {
                    resendEmailBtn.innerText = `Resend available in ${resendCooldown}s`;
                }
            }, 1000);

        } catch (err) {
            console.error('Resend Email Error:', err);
            showError(err.message ? err.message.replace('Firebase: ', '') : 'Failed to resend verification email.');
            resendEmailBtn.innerText = "Didn't receive it? Resend Email";
            resendEmailBtn.style.opacity = '1';
            resendEmailBtn.style.cursor = 'pointer';
        }
    });
}

// ─── Password Visibility Toggle ─────────────────────────────────────────────

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

// ─── Shared Modal Scroll Lock ────────────────────────────────────────────────
// `overflow:hidden` on <body> is ignored by iOS Safari, so the page behind the
// dialog still rubber-bands while reading the terms. Pinning the body with
// `position:fixed` is the reliable fix. Reference-counted because either modal
// can be open, and scrollbar-width compensation stops the layout shifting
// horizontally on desktop when the scrollbar disappears.

let modalLockCount = 0;
let lockedScrollY = 0;

function lockPageScroll() {
    if (modalLockCount === 0) {
        const scrollbar = window.innerWidth - document.documentElement.clientWidth;
        lockedScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${lockedScrollY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    }
    modalLockCount++;
}

function unlockPageScroll() {
    if (modalLockCount === 0) return;
    modalLockCount--;
    if (modalLockCount === 0) {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.paddingRight = '';
        window.scrollTo(0, lockedScrollY); // restore the pre-modal position
    }
}

// ─── Terms of Service Modal ───────────────────────────────────────────────────
// A styled, scrollable modal instead of alert() because the terms are far too
// long for a native alert (which truncates on mobile and strips formatting).
// Mirrors the guide-modal pattern used in the admin panel.

const termsBtn = document.getElementById('terms-btn');
const termsModal = document.getElementById('terms-modal');
const termsModalClose = document.getElementById('terms-modal-close');
const termsModalAccept = document.getElementById('terms-modal-accept');

let lastFocusedBeforeTerms = null;

function openTermsModal() {
    if (!termsModal) return;
    lastFocusedBeforeTerms = document.activeElement;
    termsModal.hidden = false;
    lockPageScroll(); // lock page scroll behind the modal
    if (window.lucide) lucide.createIcons();
    if (termsModalClose) termsModalClose.focus();
}

function closeTermsModal() {
    if (!termsModal || termsModal.hidden) return;
    termsModal.hidden = true;
    unlockPageScroll();
    // Return focus to the trigger so keyboard users don't lose their place.
    if (lastFocusedBeforeTerms && typeof lastFocusedBeforeTerms.focus === 'function') {
        lastFocusedBeforeTerms.focus();
    }
}

if (termsBtn) termsBtn.addEventListener('click', openTermsModal);
if (termsModalClose) termsModalClose.addEventListener('click', closeTermsModal);
// "I Understand" closes the modal AND ticks the consent checkbox, which
// unlocks the Create Account button. Setting .checked programmatically does
// not dispatch `change`, so syncSubmitState() is called explicitly here.
if (termsModalAccept) {
    termsModalAccept.addEventListener('click', () => {
        if (termsConsent && !termsConsent.checked) {
            termsConsent.checked = true;
            syncSubmitState();
        }
        closeTermsModal();
    });
}

if (termsModal) {
    // Clicking the backdrop (but not the dialog itself) closes the modal.
    termsModal.addEventListener('click', (e) => {
        if (e.target === termsModal) closeTermsModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !termsModal.hidden) closeTermsModal();
    });
}

// ─── Registration Guide Modal ────────────────────────────────────────────────
// "How to Register and Verify Your BRIANE Account" — same guide-modal pattern
// as the admin config section, rendered on the auth page in auth.css.

const regGuideBtn = document.getElementById('reg-guide-btn');
const regGuideModal = document.getElementById('reg-guide-modal');
const regGuideClose = document.getElementById('reg-guide-close');

let lastFocusedBeforeGuide = null;

function openRegGuide() {
    if (!regGuideModal) return;
    lastFocusedBeforeGuide = document.activeElement;
    regGuideModal.hidden = false;
    lockPageScroll(); // lock page scroll behind the modal
    if (window.lucide) lucide.createIcons();
    if (regGuideClose) regGuideClose.focus();
}

function closeRegGuide() {
    if (!regGuideModal || regGuideModal.hidden) return;
    regGuideModal.hidden = true;
    unlockPageScroll();
    // Return focus to the trigger so keyboard users don't lose their place.
    if (lastFocusedBeforeGuide && typeof lastFocusedBeforeGuide.focus === 'function') {
        lastFocusedBeforeGuide.focus();
    }
}

if (regGuideBtn) regGuideBtn.addEventListener('click', openRegGuide);
if (regGuideClose) regGuideClose.addEventListener('click', closeRegGuide);

if (regGuideModal) {
    // Clicking the backdrop (but not the dialog itself) closes the modal.
    regGuideModal.addEventListener('click', (e) => {
        if (e.target === regGuideModal) closeRegGuide();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !regGuideModal.hidden) closeRegGuide();
    });
}

// ─── Real-time Weather Background Sync ──────────────────────────────────────

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
    let weatherType = 'sunny';

    if (currentRainRateVal >= 50.0) {
        weatherType = 'stormy';
    } else if (currentRainRateVal > 0.0) {
        weatherType = 'rainy';
    } else {
        const hour = new Date().getHours();
        const isDaytime = hour >= 5 && hour < 18;

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
