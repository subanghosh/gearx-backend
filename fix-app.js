const fs = require('fs');

const codeToInsert = `    const otpGroup = document.getElementById('login-otp-group');
    const isVerifyStage = otpGroup.style.display === 'block';

    if (!isVerifyStage && otpCooldownSeconds > 0) {
        showToast(\`Please wait \${otpCooldownSeconds} seconds before requesting a new OTP.\`, 'error');
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
        if (!isVerifyStage) {
            // Stage 1: Send OTP
            localStorage.removeItem('marshalUser');
            currentUser = null;
            btn.innerHTML = 'Sending...';
            btn.disabled = true;
            const res = await fetch(\`\${API_URL}/auth/send-otp\`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ phone: \`+91\${phoneInput}\` })
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            otpGroup.style.display = 'block';
            btn.innerHTML = 'Verify & Login';
            otpGroup.style.display = 'block';
            const firstBox = document.querySelector('.otp-boxes[data-target="login-otp"] .otp-box');
            if (firstBox) firstBox.focus();
            showToast(\`OTP sent! For testing, your code is: \${data.otp}\`, 'success');
            if (data.otp && window.fillOtpBoxes) fillOtpBoxes('login-otp', data.otp);
            startOtpTimer();
            btn.disabled = false;
        } else {
            // Stage 2: Verify OTP
            const otp = window.getOtpValue ? getOtpValue('login-otp') : document.getElementById('login-otp').value.trim();
            if (otp.length !== 6) return showToast('Enter the 6-digit OTP', 'error');
            
            btn.innerHTML = 'Verifying...';
            const res = await fetch(\`\${API_URL}/auth/verify-otp\`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ phone: \`+91\${phoneInput}\`, otp, role: 'marshal' })
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            if (data.user.role !== 'marshal') {
                btn.innerHTML = 'Send OTP';
                throw new Error('Access denied. This portal is for Marshals only.');
            }

            currentUser = normalizeUser(data.user);
            localStorage.setItem('marshalUser', JSON.stringify(currentUser));
            showToast('Login successful!', 'success');
            enterApp();
        }
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            showToast('Request timed out. Server may be starting — try again in 30 seconds.', 'error');
        } else {
            showToast(err.message, 'error');
        }
        btn.disabled = false;
        btn.innerHTML = isVerifyStage ? 'Verify & Login' : 'Send OTP';
    }
}

function logout() {
    currentUser = null;
    localStorage.removeItem('marshalUser');
    location.reload();
}

// --- App Navigation ---
async function enterApp() {
    try {
        // Fetch latest user data to check onboarding status
        const res = await fetch(\`\${API_URL}/users\`);
        if (res.ok) {
            const users = await res.json();
            let user = users.find(u => u.id === currentUser.id);
            if (!user) {
                // User no longer exists in DB
                logout();
                return;
            }
            if (user.status === 'suspended' || user.status === 'terminated') {
                showToast('Your account is suspended.', 'error');
                logout();
                return;
            }
            user = normalizeUser(user);
            currentUser = { ...currentUser, ...user };
        }

        const loginScreen = document.getElementById('login-screen');
        if (loginScreen) loginScreen.classList.add('hidden');
        
        const registerScreen = document.getElementById('register-screen');
        if (registerScreen) registerScreen.classList.add('hidden');
        
        const mainApp = document.getElementById('main-app');
        if (mainApp) mainApp.classList.remove('hidden');`;

let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/redrivo-marshal-app/app.js', 'utf8');
let lines = content.split('\n');

lines.splice(118, 20, ...codeToInsert.split('\n'));
fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/redrivo-marshal-app/app.js', lines.join('\n'));
